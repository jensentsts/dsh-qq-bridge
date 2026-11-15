import { parseEndpoint, bindingId } from './onebot.mjs'
import { normalizeRich, normalizeAsr, normalizePolling, normalizeMerge, normalizeQzone, normalizePersona, normalizeBindingFeatures } from './feature-config.mjs'
import { DEFAULT_TYPING_OPTIONS, normalizeTypingOptions } from './typing-speed.mjs'
export const DEFAULT_CONFIG = Object.freeze({ version: 1, enabled: false, sendEnabled: false, webhookEnabled: false, baseUrl: 'http://127.0.0.1:3000', allowRemoteOneBot: false, bindings: [], outboundTargets: [], inputMode: 'auto', replyQuietMs: 1200, nativeQuote: true, quoteMaxChars: 3000, quoteMaxMedia: 2, maxMedia: 4, maxMediaBytes: 5242880, maxFileBytes: 52428800, allowGroupFiles: false, mediaOrigins: ['https://multimedia.nt.qq.com.cn'], voice: { enabled: false, provider: 'deepseek', deepseekVoice: 'stella', keepText: false, maxChars: 600, voice: 'female-shaonv', model: 'speech-2.8-turbo' }, polling: { enabled: false, intervalMs: 2000, catchupMs: 600000, count: 30 }, merge: { enabled: false, windowMs: 3000, maxWaitMs: 20000, maxMessages: 8, maxChars: 16000 }, qzone: { enabled: false, post: false, like: false, comment: false } })
const boolean = (input, key, fallback) => input[key] === undefined ? fallback : typeof input[key] === 'boolean' ? input[key] : (() => { throw new Error(`Invalid boolean ${key}`) })()
const integer = (value, fallback, min, max, label) => { const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`); return n }
export function validateBaseUrl(value, allowRemote = false) {
  const url = new URL(String(value))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('OneBot URL must be an HTTP(S) origin without credentials/path/query')
  if (!allowRemote && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote OneBot origin requires explicit opt-in')
  return url.origin
}
export function normalizeConfig(input = {}) {
  const d = DEFAULT_CONFIG
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid QQ settings')
  const allowRemoteOneBot = boolean(input, 'allowRemoteOneBot', d.allowRemoteOneBot)
  const inputMode = input.inputMode ?? d.inputMode
  if (!['auto', 'queue', 'steer'].includes(inputMode)) throw new Error('Invalid input mode')
  const seen = new Set(), sessions = new Set()
  if (input.bindings !== undefined && (!Array.isArray(input.bindings) || input.bindings.length > 100)) throw new Error('At most 100 bindings')
  const bindings = (input.bindings ?? []).map(row => {
    parseEndpoint(row.endpoint)
    const sessionId = String(row.sessionId ?? '').trim()
    if (!sessionId || sessionId.length > 512) throw new Error('Binding requires a full session ID')
    const bid = row.id || `${bindingId(row.endpoint)}:${sessionId}`
    if (typeof bid !== 'string' || bid.length > 128 || bid.includes(':outbound:')) throw new Error('Invalid QQ binding ID')
    if (seen.has(row.endpoint) || sessions.has(sessionId)) throw new Error('Each QQ chat and session may appear only once')
    seen.add(row.endpoint); sessions.add(sessionId)
    const mode = row.mode ?? inputMode
    if (!['auto', 'queue', 'steer'].includes(mode)) throw new Error('Invalid binding mode')
    let modelSelection
    if (row.modelSelection) {
      const s = row.modelSelection
      if (typeof s.provider !== 'string' || !s.provider || typeof s.model !== 'string' || !s.model) throw new Error('Invalid model selection')
      modelSelection = { provider: s.provider, model: s.model, ...(typeof s.reasoningEffort === 'string' ? { reasoningEffort: s.reasoningEffort } : {}) }
    }
    let continuation
    if (row.continuation !== undefined) {
      const value = row.continuation
      if (!value || typeof value !== 'object' || value.enabled === true && !['maxAdditionalReplies', 'maxOutputTokens', 'maxDurationMs'].every(key => Number.isSafeInteger(value[key]))) throw new Error('Enabled continuation requires all three explicit budgets')
      continuation = { enabled: boolean(value, 'enabled', false), maxAdditionalReplies: integer(value.maxAdditionalReplies, 1, 1, 8, 'continuation.maxAdditionalReplies'), maxOutputTokens: integer(value.maxOutputTokens, 1024, 1, 32768, 'continuation.maxOutputTokens'), maxDurationMs: integer(value.maxDurationMs, 30000, 100, 120000, 'continuation.maxDurationMs') }
    }
    let quotaPolicy
    if (row.quotaPolicy !== undefined) {
      const value = row.quotaPolicy
      if (!value || !['off', 'next-input'].includes(value.mode) || !Array.isArray(value.candidates) || value.candidates.length > 8) throw new Error('Invalid quota policy')
      const candidates = value.candidates.map(selection => {
        if (!selection || typeof selection.provider !== 'string' || !selection.provider || typeof selection.model !== 'string' || !selection.model) throw new Error('Invalid quota fallback candidate')
        return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}) }
      })
      if (value.mode === 'next-input' && !candidates.length) throw new Error('Quota fallback requires a candidate')
      quotaPolicy = { mode: value.mode, maxSwitches: integer(value.maxSwitches, 1, 1, 8, 'quotaPolicy.maxSwitches'), candidates }
    }
    const modelPolicy = row.modelPolicy ?? 'native-wins'
    if (!['native-wins', 'binding-once', 'off'].includes(modelPolicy)) throw new Error('Invalid binding model policy')
    const modelRevision = integer(row.modelRevision, 0, 0, Number.MAX_SAFE_INTEGER, 'modelRevision')
    return { id: bid, endpoint: row.endpoint, sessionId, modelPolicy, modelRevision, workspaceId: String(row.workspaceId ?? ''), label: String(row.label ?? row.endpoint).slice(0, 160), enabled: row.enabled === true, sendEnabled: row.sendEnabled === true, preload: row.preload !== false, mode, ...normalizeBindingFeatures(row), ...(modelSelection ? { modelSelection } : {}), ...(continuation ? { continuation } : {}), ...(quotaPolicy ? { quotaPolicy } : {}) }
  })
  if (input.outboundTargets !== undefined && (!Array.isArray(input.outboundTargets) || input.outboundTargets.length > 100)) throw new Error('At most 100 outbound targets')
  const outboundTargets = (input.outboundTargets ?? []).map(row => {
    if (typeof row?.endpoint !== 'string') throw new Error('Outbound target requires a QQ chat')
    parseEndpoint(row.endpoint)
    if (seen.has(row.endpoint)) throw new Error('Each QQ chat may appear only once')
    seen.add(row.endpoint)
    return { endpoint: row.endpoint, label: String(row.label ?? '').trim().slice(0, 160) || row.endpoint, enabled: boolean(row, 'enabled', true) }
  })
  const origins = input.mediaOrigins ?? d.mediaOrigins
  if (!Array.isArray(origins) || origins.length > 16) throw new Error('At most 16 media origins')
  const voice = input.voice ?? {}
  const voiceProvider = voice.provider ?? (voice.enabled === true ? 'minimax' : 'deepseek')
  if (!['deepseek', 'minimax'].includes(voiceProvider)) throw new Error('Invalid voice provider')
  const deepseekVoice = voice.deepseekVoice ?? 'stella'
  if (!['stella', 'tide'].includes(deepseekVoice)) throw new Error('Invalid DeepSeek voice')
  const rich = normalizeRich(input.rich), asr = normalizeAsr(input.asr), polling = normalizePolling(input.polling), merge = normalizeMerge(input.merge), qzone = normalizeQzone(input.qzone)
  const typingInput = input.typing ?? {}
  if (!typingInput || typeof typingInput !== 'object' || Array.isArray(typingInput)) throw new Error('Invalid typing settings')
  const typing = { enabled: boolean(typingInput, 'enabled', true), ...normalizeTypingOptions({ ...DEFAULT_TYPING_OPTIONS, ...typingInput }) }
  return { version: 1, rich, asr, typing, defaultPersona: normalizePersona(input.defaultPersona), maxIngressFlights: integer(input.maxIngressFlights, 8, 1, 32, 'maxIngressFlights'), enabled: boolean(input, 'enabled', d.enabled), sendEnabled: boolean(input, 'sendEnabled', d.sendEnabled), webhookEnabled: boolean(input, 'webhookEnabled', d.webhookEnabled), baseUrl: validateBaseUrl(input.baseUrl ?? d.baseUrl, allowRemoteOneBot), allowRemoteOneBot, bindings, outboundTargets, inputMode, replyQuietMs: integer(input.replyQuietMs, d.replyQuietMs, 0, 5000, 'replyQuietMs'), nativeQuote: boolean(input, 'nativeQuote', d.nativeQuote), quoteMaxChars: integer(input.quoteMaxChars, d.quoteMaxChars, 128, 6000, 'quoteMaxChars'), quoteMaxMedia: integer(input.quoteMaxMedia, d.quoteMaxMedia, 0, 4, 'quoteMaxMedia'), maxMedia: integer(input.maxMedia, d.maxMedia, 0, 8, 'maxMedia'), maxMediaBytes: integer(input.maxMediaBytes, d.maxMediaBytes, 1024, 20971520, 'maxMediaBytes'), maxFileBytes: integer(input.maxFileBytes, d.maxFileBytes, 1024, 52428800, 'maxFileBytes'), allowGroupFiles: boolean(input, 'allowGroupFiles', d.allowGroupFiles), mediaOrigins: origins.map(origin => { const u = new URL(origin); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.origin !== origin) throw new Error('Media origins must be explicit HTTP(S) origins'); return u.origin }), voice: { enabled: boolean(voice, 'enabled', false), provider: voiceProvider, deepseekVoice, keepText: boolean(voice, 'keepText', d.voice.keepText), maxChars: integer(voice.maxChars, 600, 60, 3000, 'voice.maxChars'), voice: String(voice.voice ?? 'female-shaonv').slice(0, 100), model: String(voice.model ?? 'speech-2.8-turbo').slice(0, 100) }, polling, merge, qzone }
}
/** Explicit read-only legacy import. Original data and all gates remain unchanged. */
export function migrateLegacyConfig(legacy) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('Expected legacy JSON object')
  const warnings = [], rows = []
  const old = Array.isArray(legacy.绑定) ? [...legacy.绑定] : []
  if (!old.length) {
    if (legacy.私聊QQ && (legacy.私聊会话 || legacy.目标会话)) old.push({ 类型: '私聊', 号码: legacy.私聊QQ, 会话: legacy.私聊会话 || legacy.目标会话 })
    if (legacy.群号 && legacy.群会话) old.push({ 类型: '群', 号码: legacy.群号, 会话: legacy.群会话 })
  }
  const peers = new Set(), sessions = new Set()
  for (const row of old.slice(0, 100)) {
    try {
      const endpoint = `${row.类型 === '群' ? 'group' : 'private'}:${String(row.号码)}`
      parseEndpoint(endpoint)
      const sessionId = String(row.会话 || '').trim()
      if (!sessionId || peers.has(endpoint) || sessions.has(sessionId)) throw new Error('missing/duplicate session/chat')
      rows.push({ endpoint, sessionId, label: String(row.称呼 || endpoint), enabled: false, sendEnabled: false, preload: true, mode: 'auto' })
      peers.add(endpoint); sessions.add(sessionId)
    } catch { warnings.push('One invalid/duplicate legacy binding omitted') }
  }
  const retainedLegacy = structuredClone(legacy)
  // Secrets leave the retained/config/response planes; only the explicit Host import action writes credentials.
  const credentials = { ...(typeof legacy.令牌 === 'string' && legacy.令牌.trim() ? { ONEBOT_TOKEN: legacy.令牌.trim().slice(0, 4096) } : {}) }
  delete retainedLegacy.令牌; delete retainedLegacy.通知口令
  warnings.push('Imported bindings are disabled; legacy bearer token is moved to credential storage by the explicit import action. Old notification URL secret is not reused as HMAC secret. Legacy gates/persona/Qzone/schedules/ASR settings retained read-only, not auto-activated')
  return { config: normalizeConfig({ bindings: rows, baseUrl: legacy.NapCat || DEFAULT_CONFIG.baseUrl, allowRemoteOneBot: false, allowGroupFiles: legacy.文件仅私聊 === false }), retainedLegacy, warnings, credentials }
}
