import { createHmac, timingSafeEqual } from 'node:crypto'
import { validateBaseUrl } from './config.mjs'
export const ONEBOT_CREDENTIAL_KEY = 'dsh-qq-bridge/onebot-v1'
export function oneBotAccessToken(env, origin) {
  return env?.ONEBOT_TOKEN_ORIGIN && env.ONEBOT_TOKEN_ORIGIN !== origin ? '' : env?.ONEBOT_TOKEN ?? ''
}
export class OneBotError extends Error {
  constructor(code, deliveryState = 'unknown') { super(code); this.code = code; this.deliveryState = deliveryState }
}
export function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}
export async function boundedBytes(response, maxBytes, signal) {
  const advertised = Number(response.headers?.get?.('content-length'))
  if (advertised > maxBytes) throw new OneBotError('BODY_TOO_LARGE')
  if (!response.body?.getReader) throw new OneBotError('STREAMING_BODY_UNAVAILABLE')
  const reader = response.body.getReader(), chunks = []
  let total = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new OneBotError('BODY_TOO_LARGE')
      chunks.push(value)
    }
  } finally { try { await reader.cancel() } catch { /* Already closed. */ } reader.releaseLock() }
  return Buffer.concat(chunks, total)
}
/** No retries after a request might have left this process. Explicit API rejection is safely failed. */
export function createOneBotClient({ config, token = async () => '', fetch: fetchFn = globalThis.fetch }) {
  return {
    async call(action, params, { signal, timeoutMs = 10000, maxBytes = 1048576, beforeSend } = {}) {
      if (!/^[a-z_]+$/.test(action)) throw new OneBotError('INVALID_ACTION', 'failed')
      if (signal?.aborted) throw new OneBotError('ABORTED_BEFORE_SEND', 'failed')
      const c = config(), baseUrl = validateBaseUrl(c.baseUrl, c.allowRemoteOneBot)
      const secret = await token(baseUrl), headers = { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge/0.0.1' }
      if (secret) headers.authorization = `Bearer ${secret}`
      const combined = combineSignal(signal, timeoutMs)
      if (combined.aborted) throw new OneBotError('ABORTED_BEFORE_SEND', 'failed')
      beforeSend?.()
      let response, data
      try {
        response = await fetchFn(`${baseUrl}/${action}`, { method: 'POST', headers, body: JSON.stringify(params), signal: combined, redirect: 'error' })
        const bytes = await boundedBytes(response, maxBytes, combined)
        data = JSON.parse(bytes.toString('utf8'))
      } catch { throw new OneBotError('ONEBOT_RESPONSE_UNKNOWN') }
      if (!response.ok) throw new OneBotError('ONEBOT_HTTP_REJECTED', 'unknown')
      if (data?.status !== 'ok' || data.retcode !== 0) throw new OneBotError('ONEBOT_API_REJECTED', 'failed')
      return data.data
    },
    /** Diagnostic-preserving variant for extension APIs that use non-zero retcodes for legitimate empty states. */
    async callRaw(action, params, { signal, timeoutMs = 10000, maxBytes = 1048576, beforeSend } = {}) {
      if (!/^[a-z_]+$/.test(action)) throw new OneBotError('INVALID_ACTION', 'failed')
      if (signal?.aborted) throw new OneBotError('ABORTED_BEFORE_SEND', 'failed')
      const c = config(), baseUrl = validateBaseUrl(c.baseUrl, c.allowRemoteOneBot)
      const secret = await token(baseUrl), headers = { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge/0.0.1' }
      if (secret) headers.authorization = `Bearer ${secret}`
      const combined = combineSignal(signal, timeoutMs)
      if (combined.aborted) throw new OneBotError('ABORTED_BEFORE_SEND', 'failed')
      beforeSend?.()
      let response, data
      try {
        response = await fetchFn(`${baseUrl}/${action}`, { method: 'POST', headers, body: JSON.stringify(params), signal: combined, redirect: 'error' })
        const bytes = await boundedBytes(response, maxBytes, combined)
        data = JSON.parse(bytes.toString('utf8'))
      } catch {
        if (response && !response.ok) return { ok: false, code: 'ONEBOT_HTTP_REJECTED', status: response.status }
        return { ok: false, code: 'ONEBOT_RESPONSE_UNKNOWN', text: 'QQ 后端响应不可用或连接失败。' }
      }
      const wording = String(data?.wording || data?.msg || data?.message || data?.data?.wording || data?.data?.message || '').slice(0, 300)
      if (!response.ok) return { ok: false, code: 'ONEBOT_HTTP_REJECTED', status: response.status, retcode: data?.retcode, wording }
      if (data?.status !== 'ok' || data.retcode !== 0) return { ok: false, code: 'ONEBOT_API_REJECTED', retcode: data?.retcode, wording }
      return { ok: true, data: data.data }
    },
  }
}
/** OneBot HTTP reporting requires a nonempty secret and the signature over exact bounded bytes. */
export function verifyWebhookSignature(raw, signature, secret) {
  if (typeof secret !== 'string' || !secret || typeof signature !== 'string' || !/^sha1=[a-f0-9]{40}$/i.test(signature)) return false
  const expected = `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature.toLowerCase()))
}
export function managementStatus(connection, request) {
  try {
    if (typeof connection?.requestRejection !== 'function' || typeof connection?.admit !== 'function') return 503
    const status = connection.requestRejection(request)
    if (status !== undefined) return status === 401 ? 401 : 403
    const admission = connection.admit(request)
    if (admission?.rejection !== undefined) return admission.rejection === 401 ? 401 : 403
    return admission?.peer?.principal?.kind === 'owner' ? undefined : 403
  } catch { return 503 }
}
