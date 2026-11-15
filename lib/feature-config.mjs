const bool = (value, key, fallback = false) => value[key] === undefined ? fallback : typeof value[key] === 'boolean' ? value[key] : (() => { throw new Error('Invalid feature boolean ' + key) })()
const int = (value, fallback, min, max) => { const n = value ?? fallback; if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('Invalid feature budget'); return n }
const object = value => { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid feature settings'); return value }
const strings = (value, max, length) => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !item || item.length > length)) throw new Error('Invalid feature list'); return [...new Set(value)] }
export function normalizeRich(value) {
  const v = object(value)
  return { cards: bool(v, 'cards'), forwards: bool(v, 'forwards'), maxChars: int(v.maxChars, 4000, 256, 6000), maxNodes: int(v.maxNodes, 24, 1, 40), maxDepth: int(v.maxDepth, 2, 0, 3), maxCalls: int(v.maxCalls, 4, 1, 8), maxBytes: int(v.maxBytes, 65536, 1024, 131072), forwardMedia: bool(v, 'forwardMedia') }
}
export function normalizeAsr(value) {
  const v = object(value)
  return { enabled: bool(v, 'enabled'), providerId: String(v.providerId ?? '').slice(0, 128), language: String(v.language ?? 'auto').slice(0, 32), timeoutMs: int(v.timeoutMs, 15000, 100, 60000), maxAudioBytes: int(v.maxAudioBytes, 5242880, 1024, 10485760), maxTextChars: int(v.maxTextChars, 4000, 128, 6000) }
}
export function normalizePolling(value) {
  const v = object(value)
  return { enabled: bool(v, 'enabled'), intervalMs: int(v.intervalMs, 2000, 800, 30000), catchupMs: int(v.catchupMs, 600000, 60000, 3600000), count: int(v.count, 30, 1, 50) }
}
export function normalizeMerge(value) {
  const v = object(value), windowMs = int(v.windowMs, 3000, 500, 30000), maxWaitMs = int(v.maxWaitMs, 20000, 1000, 120000)
  if (maxWaitMs < windowMs) throw new Error('Merge maxWaitMs must be at least windowMs')
  // Existing small merge-window settings are lifted to the fast per-chat receive queue's minimum capacity.
  return { enabled: bool(v, 'enabled'), windowMs, maxWaitMs, maxMessages: Math.max(256, int(v.maxMessages, 1000, 1, 1000)), maxChars: Math.max(1048576, int(v.maxChars, 4194304, 1000, 4194304)) }
}
export function normalizeQzone(value) {
  const v = object(value)
  return { enabled: bool(v, 'enabled'), post: bool(v, 'post'), like: bool(v, 'like'), comment: bool(v, 'comment') }
}
export function normalizePersona(value) {
  const persona = object(value)
  return { enabled: bool(persona, 'enabled'), text: String(persona.text ?? '').slice(0, 6000) }
}
export function normalizeBindingFeatures(row) {
  const a = object(row.admission), r = object(row.rate), g = object(row.replyGate), p = object(row.priceSchedule)
  const allowedSenders = strings(a.allowedSenders, 100, 24)
  if (allowedSenders.some(id => !/^[1-9]\d{0,23}$/.test(id))) throw new Error('Invalid allowed sender')
  return {
    admission: { enabled: bool(a, 'enabled'), allowedSenders, mentionOnly: bool(a, 'mentionOnly', true), keywords: strings(a.keywords, 16, 64), mentionAlways: bool(a, 'mentionAlways', true), probability: int(a.probability, 100, 0, 100), tailMessages: int(a.tailMessages, 0, 0, 20), tailMs: int(a.tailMs, 120000, 0, 600000) },
    rate: { enabled: bool(r, 'enabled'), cooldownMs: int(r.cooldownMs, 5000, 0, 60000), perMinute: int(r.perMinute, 4, 1, 60) },
    priceSchedule: { enabled: bool(p, 'enabled'), peakProbability: int(p.peakProbability, 20, 0, 100), offPeakProbability: int(p.offPeakProbability, 100, 0, 100) },
    persona: normalizePersona(row.persona),
    replyGate: { enabled: bool(g, 'enabled'), conclude: bool(g, 'conclude') },
  }
}
