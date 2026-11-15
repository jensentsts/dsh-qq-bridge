import { ROUTE_PREFIX } from './onebot.mjs'
import { normalizeConfig, validateBaseUrl } from './config.mjs'
import { managementStatus, oneBotAccessToken, ONEBOT_CREDENTIAL_KEY, verifyWebhookSignature } from './onebot-http.mjs'
export function jsonResponse(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
export async function readRequestBytes(req, maxBytes = 131072) {
  const chunks = []; let total = 0
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk) }
  return Buffer.concat(chunks, total)
}
const parseBody = async req => { const bytes = await readRequestBytes(req); return bytes.length ? JSON.parse(bytes.toString('utf8')) : {} }
/** Pure route registration with injectable trusted operations; no browser credential retrieval. */
export function registerRoutes({ webServer, connection, bridge, credentials, onebot, modelCatalog, hostPermissions, networkEnabled = () => false, schedule, bindings = () => [] }) {
  const disposers = [], secretsKey = ONEBOT_CREDENTIAL_KEY
  const secret = async () => (await credentials.readRecord(secretsKey))?.env ?? {}
  const state = async () => {
    const env = await secret()
    const data = bridge.state()
    return { ok: true, version: '0.0.1', ...data, networkEnabled: networkEnabled(), recallEvents: bridge.recallFeed?.status, credentials: { onebot: !!oneBotAccessToken(env, data.config.baseUrl), webhook: !!env.WEBHOOK_SECRET } }
  }
  const related = task => task?.target?.kind === 'session' && bindings().some(binding => binding.sessionId === task.target.sessionId)
  const requireSchedule = () => { if (!schedule || typeof schedule.create !== 'function' || typeof schedule.list !== 'function') throw new Error('SCHEDULE_UNAVAILABLE') }
  const route = (path, methods, handler, webhook = false) => disposers.push(webServer.register({ kind: 'exact', path: ROUTE_PREFIX + path, handler: async (req, res) => {
    try {
      if (!methods.includes(req.method)) return jsonResponse(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
      if (!webhook) { const denial = managementStatus(connection, req); if (denial !== undefined) return jsonResponse(res, denial, { ok: false, code: 'AUTHENTICATION_REQUIRED' }) }
      await handler(req, res)
    } catch (error) { if (error?.code === 'QQ_BACKPRESSURE') { res.setHeader?.('retry-after', String(Math.ceil(error.retryAfterMs / 1000))); return jsonResponse(res, 503, { ok: false, code: 'QQ_BACKPRESSURE', retryAfterMs: error.retryAfterMs, queued: false, reason: error.reason }) } jsonResponse(res, 400, { ok: false, code: error?.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'OPERATION_FAILED' }) }
  } }))
  route('/state', ['GET'], async (_, res) => jsonResponse(res, 200, await state()))
  route('/models', ['GET'], async (_, res) => {
    jsonResponse(res, 200, { ok: true, catalog: await modelCatalog() })
  })
  route('/host-permissions', ['GET', 'POST'], async (req, res) => {
    if (!hostPermissions) return jsonResponse(res, 200, { ok: true, result: { available: false, options: [], bindings: [] } })
    if (req.method === 'POST') {
      const value = await parseBody(req)
      await hostPermissions.set(value.bindingId, value.preset)
    }
    jsonResponse(res, 200, { ok: true, result: hostPermissions.catalog() })
  })
  route('/tests/send', ['POST'], async (req, res) => {
    const result = networkEnabled() ? await bridge.sendTest(await parseBody(req))
      : { state: 'failed', reason: 'NETWORK_ACCESS_DISABLED' }
    jsonResponse(res, 200, { ok: true, result })
  })
  route('/tests/receive/start', ['POST'], async (req, res) => {
    const { bindingId, endpoint } = await parseBody(req)
    let result
    if (!networkEnabled()) result = { state: 'blocked', reason: 'NETWORK_ACCESS_DISABLED' }
    else if (!bridge.config.polling?.enabled && !(bridge.config.webhookEnabled && (await secret()).WEBHOOK_SECRET)) {
      result = { state: 'blocked', reason: 'QQ_RECEIVE_SETUP' }
    } else result = bridge.startReceiveTest(bindingId, endpoint)
    jsonResponse(res, 200, { ok: true, result })
  })
  route('/tests/receive/status', ['POST'], async (req, res) => {
    const { bindingId, code } = await parseBody(req)
    jsonResponse(res, 200, { ok: true, result: bridge.receiveTestStatus(bindingId, code) })
  })
  route('/onebot/account', ['POST'], async (_, res) => {
    if (!networkEnabled()) return jsonResponse(res, 200, { ok: true, status: 'network-disabled' })
    if (bridge.qqStatus) {
      const { account, reason } = await bridge.qqStatus.read(undefined, { refresh: true })
      const status = reason === 'NETWORK_ACCESS_DISABLED' ? 'network-disabled'
        : reason === 'QQ_ACCOUNT_OFFLINE' ? 'account-offline'
        : reason === 'QQ_ONEBOT_AUTH_FAILED' ? 'authentication-failed'
        : account.reachable === false ? 'connection-failed'
        : account.healthy === false ? 'account-unhealthy'
        : account.id ? 'connected' : 'account-unavailable'
      return jsonResponse(res, 200, { ok: true, status, ...(account.id ? { qq: account.id, nickname: account.nickname } : {}) })
    }
    const result = await onebot.callRaw('get_login_info', {}, { timeoutMs: 5000, maxBytes: 16384 })
    if (!result.ok) {
      const unauthorized = result.status === 401 || result.status === 403 || result.retcode === 1401 || result.retcode === 1403
      const status = unauthorized ? 'authentication-failed' : result.code === 'ONEBOT_API_REJECTED' ? 'account-unavailable' : 'connection-failed'
      return jsonResponse(res, 200, { ok: true, status })
    }
    const id = result.data?.user_id
    const qq = typeof id === 'string' ? id : Number.isSafeInteger(id) ? String(id) : ''
    if (!/^[1-9]\d{0,23}$/.test(qq)) return jsonResponse(res, 200, { ok: true, status: 'account-unavailable' })
    const nickname = typeof result.data.nickname === 'string' ? result.data.nickname.trim().slice(0, 80) : ''
    jsonResponse(res, 200, { ok: true, status: 'connected', qq, nickname })
  })
  route('/save', ['POST'], async (req, res) => {
    const input = await parseBody(req)
    try { normalizeConfig(input) } catch {
      return jsonResponse(res, 422, { ok: false, code: 'INVALID_SETTINGS' })
    }
    if (input.snowLumaOrigin !== undefined) {
      const currentOrigin = bridge.config.baseUrl
      const nextOrigin = validateBaseUrl(input.snowLumaOrigin, input.allowRemoteOneBot === true)
      if (nextOrigin !== input.baseUrl) throw new Error('ONEBOT_ADDRESS_CHANGED')
      if (currentOrigin !== nextOrigin && (await secret()).ONEBOT_TOKEN) {
        // Keep the old credential on its original endpoint while the imported credential is staged.
        await credentials.modifyRecord(secretsKey, async current => {
          const env = { ...(current?.env ?? {}) }
          if (env.ONEBOT_TOKEN && !env.ONEBOT_TOKEN_ORIGIN) env.ONEBOT_TOKEN_ORIGIN = currentOrigin
          return { kind: 'api-key', env }
        })
      }
    }
    try { await bridge.save(input) } catch {
      return jsonResponse(res, 500, { ok: false, code: 'SETTINGS_APPLY_FAILED' })
    }
    jsonResponse(res, 200, await state())
  })
  route('/credentials', ['POST'], async (req, res) => {
    const value = await parseBody(req)
    if (Object.keys(value).some(k => !['onebotToken', 'onebotOrigin', 'clearOnebot', 'webhookSecret', 'clear'].includes(k))) throw new Error('INVALID_SECRET_FIELDS')
    if (value.onebotOrigin !== undefined && value.onebotOrigin !== bridge.config.baseUrl) {
      return jsonResponse(res, 409, { ok: false, code: 'ONEBOT_ADDRESS_CHANGED' })
    }
    if (value.clear === true) await credentials.deleteRecord(secretsKey)
    else await credentials.modifyRecord(secretsKey, async current => {
      const env = { ...(current?.env ?? {}) }
      if (value.clearOnebot === true) {
        delete env.ONEBOT_TOKEN
        delete env.ONEBOT_TOKEN_ORIGIN
      } else if (typeof value.onebotToken === 'string' && value.onebotToken.trim()) {
        env.ONEBOT_TOKEN = value.onebotToken.trim().slice(0, 4096)
        if (value.onebotOrigin !== undefined) env.ONEBOT_TOKEN_ORIGIN = value.onebotOrigin
        else delete env.ONEBOT_TOKEN_ORIGIN
      }
      if (typeof value.webhookSecret === 'string' && value.webhookSecret.trim()) env.WEBHOOK_SECRET = value.webhookSecret.trim().slice(0, 4096)
      return { kind: 'api-key', env }
    })
    jsonResponse(res, 200, await state())
  })
  route('/legacy-import', ['POST'], async (req, res) => { const value = await parseBody(req); const result = await bridge.importLegacy(value, { importCredentials: env => credentials.modifyRecord(secretsKey, async current => {
    const next = { ...(current?.env ?? {}), ...env }
    if (env.ONEBOT_TOKEN) delete next.ONEBOT_TOKEN_ORIGIN
    return { kind: 'api-key', env: next }
  }) }); jsonResponse(res, 200, { ok: true, ...result }) })
  route('/preload', ['POST'], async (req, res) => { const { bindingId } = await parseBody(req); if (!bridge.config.bindings.some(binding => binding.id === bindingId)) throw new Error('BINDING_NOT_FOUND'); const result = await bridge.io.preload(bindingId); jsonResponse(res, 200, { ok: true, result }) })
  route('/preview', ['POST'], async (req, res) => { const { bindingId } = await parseBody(req); if (!bridge.config.bindings.some(binding => binding.id === bindingId)) throw new Error('BINDING_NOT_FOUND'); const result = await bridge.io.preview(bindingId, { limit: 20 }); jsonResponse(res, 200, { ok: true, result }) })
  route('/history', ['POST'], async (req, res) => {
    const { bindingId, cursor } = await parseBody(req), binding = bridge.config.bindings.find(b => b.id === bindingId)
    if (!binding) throw new Error('BINDING_NOT_FOUND')
    const result = await bridge.io.history({ bindingId, ...(typeof cursor === 'string' ? { cursor } : {}), limit: 20 }, { sessionId: binding.sessionId })
    jsonResponse(res, 200, { ok: true, result })
  })
  route('/cancel', ['POST'], async (req, res) => {
    const { bindingId } = await parseBody(req)
    if (!bridge.config.bindings.some(b => b.id === bindingId)) throw new Error('BINDING_NOT_FOUND')
    jsonResponse(res, 200, { ok: true, result: await bridge.cancel(bindingId) })
  })
  route('/schedules', ['GET'], async (_, res) => {
    requireSchedule()
    const page = await schedule.list({ limit: 500 })
    jsonResponse(res, 200, { ok: true, result: { items: (page.items ?? []).filter(related), total: (page.items ?? []).filter(related).length } })
  })
  route('/schedules/view', ['POST'], async (req, res) => {
    requireSchedule()
    const { id } = await parseBody(req)
    const task = await schedule.view({ id: String(id ?? '') })
    if (!task || task.code === 'schedule_not_found') throw new Error('SCHEDULE_NOT_FOUND')
    if (!related(task)) throw new Error('SCHEDULE_NOT_BOUND')
    jsonResponse(res, 200, { ok: true, result: task })
  })
  route('/schedules/create', ['POST'], async (req, res) => {
    requireSchedule()
    const value = await parseBody(req), binding = bindings().find(row => row.id === value.bindingId)
    if (!binding || !binding.enabled) throw new Error('BINDING_NOT_FOUND')
    if (!value.timing || typeof value.timing !== 'object') throw new Error('TIMING_REQUIRED')
    const task = await schedule.create({ title: value.title, prompt: value.prompt, timing: value.timing, target: { kind: 'session', sessionId: binding.sessionId } })
    jsonResponse(res, 200, { ok: true, result: task })
  })
  route('/schedules/edit', ['POST'], async (req, res) => {
    requireSchedule()
    const value = await parseBody(req), task = await schedule.view({ id: String(value.id ?? '') })
    if (!task || task.code === 'schedule_not_found') throw new Error('SCHEDULE_NOT_FOUND')
    if (!related(task)) throw new Error('SCHEDULE_NOT_BOUND')
    const patch = value.patch && typeof value.patch === 'object' ? value.patch : {}
    if (value.action === 'update' && patch.target !== undefined) throw new Error('TARGET_CHANGE_REQUIRES_TOOL')
    const result = await schedule.edit({ id: task.id, action: value.action === 'delete' ? 'delete' : 'update', ...(value.action === 'delete' ? {} : { patch }), ...(typeof value.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: value.expectedUpdatedAt } : {}) })
    jsonResponse(res, 200, { ok: true, result })
  })
  // Webhook events use the configured OneBot signature before entering the bridge.
  route('/onebot-events', ['POST'], async (req, res) => {
    if (!networkEnabled() || !bridge.config.enabled || !bridge.config.webhookEnabled) return jsonResponse(res, 403, { ok: false, code: 'WEBHOOK_DISABLED' })
    const raw = await readRequestBytes(req), sig = req.headers['x-signature'], key = (await secret()).WEBHOOK_SECRET
    if (!verifyWebhookSignature(raw, sig, key)) return jsonResponse(res, 401, { ok: false, code: 'INVALID_SIGNATURE' })
    const result = await bridge.receive(JSON.parse(raw.toString('utf8')), { via: 'webhook' })
    jsonResponse(res, 200, { ok: true, result })
  }, true)
  return () => { for (const off of disposers.reverse()) off?.() }
}
