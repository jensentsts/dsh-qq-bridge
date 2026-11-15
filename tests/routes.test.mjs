import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHmac } from 'node:crypto'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { registerRoutes } from '../lib/routes.mjs'
import { createOneBotClient, oneBotAccessToken, ONEBOT_CREDENTIAL_KEY } from '../lib/onebot-http.mjs'
function fixture(connection = { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, { onebot, modelCatalog, networkEnabled = () => true, bridge: activeBridge } = {}) {
  const routes = new Map(), records = new Map(), calls = []
  const bridge = activeBridge ?? { config: { enabled: true, webhookEnabled: true, bindings: [] }, state: () => ({ config: { enabled: true }, preloads: [] }), save: async value => calls.push(['save', value]), receive: async event => { calls.push(['receive', event]); return { traceId: 't' } }, importLegacy: async () => ({}), io: { preload: async () => ({}), preview: async () => ({}), history: async () => ({}), cancel: async () => ({}) } }
  const credentials = { readRecord: async key => records.get(key), modifyRecord: async (key, fn) => records.set(key, await fn(records.get(key))), deleteRecord: async key => records.delete(key) }
  const off = registerRoutes({ webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } }, connection, bridge, credentials, onebot, modelCatalog, networkEnabled })
  async function request(path, { method = 'GET', body = '', headers = {} } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []); req.method = method; req.headers = headers
    let status, value
    const res = { writeHead(code) { status = code }, end(raw) { value = JSON.parse(raw) } }
    await routes.get('/dsh-qq-bridge-001' + path).handler(req, res)
    return { status, value }
  }
  return { routes, records, calls, bridge, request, off }
}
test('route namespace is isolated and lifetime fully unregisters', () => {
  const f = fixture(); assert.ok(f.routes.has('/dsh-qq-bridge-001/state'))
  for (const p of ['/update', '/install', '/test-send', '/receive']) assert.equal(f.routes.has('/dsh-qq-bridge-001' + p), false)
  f.off(); assert.equal(f.routes.size, 0)
})
test('QQ transport tests use the saved target, reuse a send receipt, and match authenticated receive traffic', async () => {
  const store = new MemoryQqStore({ enabled: true, sendEnabled: true, webhookEnabled: true, bindings: [
    { endpoint: 'group:123', sessionId: 's', enabled: true, sendEnabled: true },
    { endpoint: 'group:456', sessionId: 'other', enabled: true, sendEnabled: true },
  ] })
  const sent = []
  const onebot = { async call(action, params) { sent.push({ action, params }); return { message_id: 81 } } }
  const io = { contractVersion: 1, registerTransport: () => () => {}, receive: () => assert.fail('A receive probe entered a session') }
  const bridge = new QqBridge({ io, onebot, store, config: store.config() })
  const [binding] = bridge.config.bindings
  const payload = { bindingId: binding.id, endpoint: binding.endpoint, text: 'test', requestId: '355f65df-c1cc-4f37-8ef6-ec4c68410f93' }
  const post = (f, path, value) => f.request(path, { method: 'POST', body: JSON.stringify(value) })
  let networkOn = true
  const f = fixture(undefined, { bridge, networkEnabled: () => networkOn })
  try {
    const guest = fixture({ requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, { bridge })
    assert.equal((await post(guest, '/tests/send', payload)).status, 403)
    networkOn = false
    assert.equal((await post(f, '/tests/send', payload)).value.result.reason, 'NETWORK_ACCESS_DISABLED')
    networkOn = true
    bridge.config.sendEnabled = false
    assert.equal((await post(f, '/tests/send', payload)).value.result.reason, 'QQ_SEND_DISABLED')
    bridge.config.sendEnabled = true
    assert.equal((await post(f, '/tests/send', { ...payload, endpoint: 'group:456' })).value.result.reason, 'TEST_TARGET_CHANGED')
    assert.equal(sent.length, 0)
    const receipts = await Promise.all([post(f, '/tests/send', payload), post(f, '/tests/send', payload)])
    assert.deepEqual(receipts.map(value => value.value.result), Array(2).fill({ state: 'delivered', externalMessageId: '81' }))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].action, 'send_group_msg')
    assert.equal(sent[0].params.group_id, '123')
    assert.deepEqual(sent[0].params.message, [{ type: 'text', data: { text: 'test' } }])
    assert.equal((await post(f, '/tests/receive/start', payload)).value.result.reason, 'QQ_RECEIVE_SETUP')
    f.records.set(ONEBOT_CREDENTIAL_KEY, { kind: 'api-key', env: { WEBHOOK_SECRET: 'test-secret' } })
    const started = (await post(f, '/tests/receive/start', payload)).value.result
    assert.match(started.code, /^DSH-RECV-[0-9a-f]{32}$/)
    const probe = { bindingId: binding.id, code: started.code }
    const event = { post_type: 'message', message_type: 'group', group_id: 123, user_id: 5, self_id: 8, message_id: 89, message: started.code }
    const report = async (value, signed) => {
      const body = JSON.stringify(value)
      const headers = signed ? { 'x-signature': 'sha1=' + createHmac('sha1', 'test-secret').update(body).digest('hex') } : {}
      return f.request('/onebot-events', { method: 'POST', body, headers })
    }
    assert.equal((await report(event, false)).status, 401)
    await report({ ...event, group_id: 456 }, true)
    await report({ ...event, user_id: 8 }, true)
    assert.equal((await post(f, '/tests/receive/status', probe)).value.result.state, 'waiting')
    assert.equal((await report(event, true)).value.result.diagnostic, 'receive-test')
    const status = (await post(f, '/tests/receive/status', probe)).value.result
    assert.equal(status.state, 'received')
    assert.equal(status.via, 'webhook')
    const polled = bridge.startReceiveTest(binding.id, binding.endpoint)
    await bridge.receive({ ...event, message_id: 90, message: polled.code }, { via: 'polling' })
    assert.equal(bridge.receiveTestStatus(binding.id, polled.code).via, 'polling')
  } finally {
    await bridge.dispose()
    f.off()
  }
})
test('QQ fallback catalog reads the official model result through the owner route', async () => {
  const catalog = { groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model' }] }] }
  const f = fixture(undefined, { modelCatalog: async () => catalog })
  assert.deepEqual((await f.request('/models')).value, { ok: true, catalog })
})
test('all management routes deny absent/broken auth and enforce HTTP method', async () => {
  const f = fixture(undefined)
  // fixture default must be bypassed explicitly for missing service.
  const g = fixture(null); assert.equal((await g.request('/state')).status, 503)
  const broken = fixture({ requestRejection() { throw new Error('bad') } }); assert.equal((await broken.request('/save', { method: 'POST', body: '{}' })).status, 503); assert.equal(broken.calls.length, 0)
  assert.equal((await f.request('/save')).status, 405)
})
test('credential write never echoes actual secret in state', async () => {
  const f = fixture(); const response = await f.request('/credentials', { method: 'POST', body: JSON.stringify({ onebotToken: 'secret-one', webhookSecret: 'secret-two' }) })
  assert.equal(response.status, 200); assert.equal(response.value.credentials.onebot, true)
  assert.ok(f.records.has('dsh-qq-bridge/onebot-v1'))
  assert.equal(JSON.stringify(response).includes('secret-one'), false); assert.equal(JSON.stringify(response).includes('secret-two'), false)
})
test('SnowLuma connection staging keeps credentials on their configured origin and preserves the signing secret', async () => {
  const current = 'http://127.0.0.1:3000'
  const origin = 'http://127.0.0.1:3010'
  const store = new MemoryQqStore({ baseUrl: current })
  const io = { contractVersion: 1, registerTransport: () => () => {} }
  const bridge = new QqBridge({ io, store, config: store.config() })
  const f = fixture(undefined, { bridge })
  const post = (path, body) => f.request(path, { method: 'POST', body: JSON.stringify(body) })
  const env = () => f.records.get(ONEBOT_CREDENTIAL_KEY)?.env
  const seen = []
  const onebot = createOneBotClient({
    config: () => bridge.config,
    token: async address => oneBotAccessToken(env(), address),
    fetch: async (url, options) => {
      seen.push([url, options.headers.authorization])
      return Response.json({ status: 'ok', retcode: 0, data: {} })
    },
  })
  try {
    await post('/credentials', { onebotToken: 'old-token', webhookSecret: 'signing-secret' })
    assert.equal((await post('/credentials', { onebotOrigin: origin, onebotToken: 'new-token' })).status, 409)
    const staged = await post('/save', { ...bridge.config, baseUrl: origin, snowLumaOrigin: origin })
    assert.equal(staged.status, 200)
    assert.deepEqual(staged.value.credentials, { onebot: false, webhook: true })
    assert.equal(oneBotAccessToken(env(), current), 'old-token')
    await onebot.callRaw('get_login_info', {})
    const saved = await post('/credentials', { onebotOrigin: origin, onebotToken: 'new-token' })
    assert.deepEqual(saved.value.credentials, { onebot: true, webhook: true })
    assert.doesNotMatch(JSON.stringify(saved), /old-token|new-token|signing-secret/)
    assert.equal(oneBotAccessToken(env(), current), '')
    await onebot.call('get_login_info', {})
    assert.deepEqual(seen, [[origin + '/get_login_info', undefined], [origin + '/get_login_info', 'Bearer new-token']])
    const cleared = await post('/credentials', { onebotOrigin: origin, clearOnebot: true })
    assert.deepEqual(cleared.value.credentials, { onebot: false, webhook: true })
    assert.deepEqual(env(), { WEBHOOK_SECRET: 'signing-secret' })
  } finally { await bridge.dispose(); f.off() }
})
test('saving a permitted remote OneBot address keeps a legacy credential scoped to its original address', async () => {
  const current = 'http://127.0.0.1:3000', origin = 'http://example.test:3000'
  const store = new MemoryQqStore({ baseUrl: current, allowRemoteOneBot: true })
  const io = { contractVersion: 1, registerTransport: () => () => {} }
  const bridge = new QqBridge({ io, store, config: store.config() }), f = fixture(undefined, { bridge })
  const post = (path, body) => f.request(path, { method: 'POST', body: JSON.stringify(body) })
  try {
    await post('/credentials', { onebotToken: 'old-token' })
    const saved = await post('/save', { ...bridge.config, baseUrl: origin, snowLumaOrigin: origin })
    assert.equal(saved.status, 200)
    const env = f.records.get(ONEBOT_CREDENTIAL_KEY).env
    assert.equal(oneBotAccessToken(env, current), 'old-token')
    assert.equal(oneBotAccessToken(env, origin), '')
  } finally { await bridge.dispose(); f.off() }
})
test('OneBot connection check reads the authenticated login identity and handles an empty 401', async () => {
  const calls = []
  let allowToken = true
  const onebot = createOneBotClient({
    config: () => ({ baseUrl: 'http://127.0.0.1:3000' }),
    token: async () => 'fixture-token',
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (!allowToken) return new Response(null, { status: 401 })
      return Response.json({ status: 'ok', retcode: 0, data: { user_id: 123456, nickname: 'Example' } })
    },
  })
  const f = fixture(undefined, { onebot })
  assert.deepEqual(await f.request('/onebot/account', { method: 'POST' }), {
    status: 200, value: { ok: true, status: 'connected', qq: '123456', nickname: 'Example' },
  })
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/get_login_info')
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-token')
  assert.equal(calls[0].init.body, '{}')
  allowToken = false
  assert.equal((await f.request('/onebot/account', { method: 'POST' })).value.status, 'authentication-failed')
  assert.equal(calls.length, 2)
})
test('OneBot connection check requires the owner and enabled network access', async () => {
  const onebot = { callRaw: () => assert.fail('The OneBot endpoint must not be called') }
  const disabled = fixture(undefined, { onebot, networkEnabled: () => false })
  assert.equal((await disabled.request('/onebot/account', { method: 'POST' })).value.status, 'network-disabled')
  const guest = fixture({ requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, { onebot })
  assert.equal((await guest.request('/onebot/account', { method: 'POST' })).status, 403)
})
test('webhook backpressure is immediate 503 with explicit not-queued receipt', async () => {
  const f = fixture(), body = '{}'
  f.records.set(ONEBOT_CREDENTIAL_KEY, { env: { WEBHOOK_SECRET: 's' } })
  f.bridge.receive = async () => { throw Object.assign(new Error('rate limited'), { code: 'QQ_BACKPRESSURE', retryAfterMs: 1000, reason: 'RATE_LIMIT' }) }
  const sig = 'sha1=' + createHmac('sha1', 's').update(body).digest('hex')
  const answer = await f.request('/onebot-events', { method: 'POST', body, headers: { 'x-signature': sig } })
  assert.equal(answer.status, 503); assert.equal(answer.value.queued, false); assert.equal(answer.value.retryAfterMs, 1000)
})
test('external webhook rejects empty/bad signatures and accepts exact signed body only', async () => {
  const f = fixture(), body = '{"post_type":"message"}'
  assert.equal((await f.request('/onebot-events', { method: 'POST', body })).status, 401)
  f.records.set(ONEBOT_CREDENTIAL_KEY, { kind: 'api-key', env: { WEBHOOK_SECRET: 's' } })
  const sig = 'sha1=' + createHmac('sha1', 's').update(body).digest('hex')
  assert.equal((await f.request('/onebot-events', { method: 'POST', body, headers: { 'x-signature': sig } })).status, 200)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.request('/onebot-events', { method: 'POST', body: body + ' ', headers: { 'x-signature': sig } })).status, 401)
})
