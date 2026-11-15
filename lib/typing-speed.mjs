/**
 * Pure, dependency-free typing-duration estimator for the QQ bridge.
 *
 * The estimator turns user-visible text into a bounded number of milliseconds.
 * It uses `Intl.Segmenter` grapheme clusters so combining marks, emoji
 * variation selectors, keycaps, flags and ZWJ emoji sequences count as one
 * character. Every cluster is classified as CJK, letter, digit, punctuation,
 * whitespace, newline, emoji or other, then weighted against a base speed.
 *
 * Non-text message parts (images, records, files, ...) contribute nothing, and
 * content with no visible text returns 0 milliseconds. Consumers can make the
 * simulation faster/slower with `rate`, raise/lower the ceiling with
 * `maxWaitMs`, or skip the wait entirely with `maxWaitMs: 0`.
 *
 * This module performs no I/O and has no network or package dependencies.
 */

/** Default estimator settings. `rate > 1` is faster, `maxWaitMs: 0` skips. */
export const DEFAULT_TYPING_OPTIONS = Object.freeze({
  charsPerMinute: 180,
  rate: 1,
  maxWaitMs: 10_000,
})

/**
 * Relative cost of one grapheme cluster. The base interval is
 * `60000 / charsPerMinute / rate` milliseconds, multiplied by these weights.
 */
export const TYPING_WEIGHTS = Object.freeze({
  cjk: 1,
  letter: 0.65,
  digit: 0.75,
  punctuation: 0.9,
  whitespace: 0.4,
  newline: 2,
  emoji: 2.5,
  other: 1,
})

const MIN_CHARS_PER_MINUTE = 30
const MAX_CHARS_PER_MINUTE = 1200
const MIN_RATE = 0.1
const MAX_RATE = 20
const MAX_MAX_WAIT_MS = 600_000

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20E3/u
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u
const DIGIT_RE = /^\p{Nd}+$/u
const PUNCTUATION_RE = /[\p{P}\p{S}]/u
const LETTER_RE = /\p{L}/u
const WHITESPACE_RE = /^\s+$/u
const NEWLINE_RE = /[\r\n\u2028\u2029]/u
const MARK_OR_JOINER_RE = /^[\p{M}\u200d\ufe0e\ufe0f]$/u

let cachedSegmenter

function getSegmenter() {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  try {
    cachedSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null
  } catch {
    cachedSegmenter = null
  }
  return cachedSegmenter
}

/**
 * Validate and normalize estimator options.
 *
 * @param {object|null|undefined} options
 * @param {number} [options.charsPerMinute=180] Reference CJK characters per minute, 30..1200.
 * @param {number} [options.rate=1] Speed multiplier, 0.1..20 (higher is faster).
 * @param {number} [options.maxWaitMs=10000] Integer ceiling in milliseconds, 0..600000.
 * @returns {Readonly<{charsPerMinute: number, rate: number, maxWaitMs: number}>}
 * @throws {TypeError} for non-object options or non-finite/non-numeric values.
 * @throws {RangeError} for values outside the supported bounds.
 */
export function normalizeTypingOptions(options = {}) {
  if (options === null || options === undefined) options = {}
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Typing options must be an object')
  }
  const {
    charsPerMinute = DEFAULT_TYPING_OPTIONS.charsPerMinute,
    rate = DEFAULT_TYPING_OPTIONS.rate,
    maxWaitMs = DEFAULT_TYPING_OPTIONS.maxWaitMs,
  } = options
  if (typeof charsPerMinute !== 'number' || !Number.isFinite(charsPerMinute)) {
    throw new TypeError('charsPerMinute must be a finite number')
  }
  if (charsPerMinute < MIN_CHARS_PER_MINUTE || charsPerMinute > MAX_CHARS_PER_MINUTE) {
    throw new RangeError(`charsPerMinute must be between ${MIN_CHARS_PER_MINUTE} and ${MAX_CHARS_PER_MINUTE}`)
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new TypeError('rate must be a finite number')
  }
  if (rate < MIN_RATE || rate > MAX_RATE) {
    throw new RangeError(`rate must be between ${MIN_RATE} and ${MAX_RATE}`)
  }
  if (typeof maxWaitMs !== 'number' || !Number.isFinite(maxWaitMs)) {
    throw new TypeError('maxWaitMs must be a finite number')
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > MAX_MAX_WAIT_MS) {
    throw new RangeError(`maxWaitMs must be an integer between 0 and ${MAX_MAX_WAIT_MS}`)
  }
  return Object.freeze({ charsPerMinute, rate, maxWaitMs })
}

/** Per-message control exposed to the agent. */
export function normalizeTypingControl(value) {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['speed', 'rate'].includes(key))) throw new TypeError('Invalid typing control')
  const speed = value.speed ?? 'default'
  if (!['default', 'instant', 'slow', 'normal', 'fast'].includes(speed)) throw new TypeError('Invalid typing speed')
  if (value.rate !== undefined && (typeof value.rate !== 'number' || !Number.isFinite(value.rate) || value.rate < 0.1 || value.rate > 20)) throw new RangeError('Invalid typing rate')
  return { speed, ...(value.rate === undefined ? {} : { rate: value.rate }) }
}

export function resolveTypingOptions(config = {}, value) {
  const control = normalizeTypingControl(value) ?? { speed: 'default' }
  const speed = control.speed
  const multiplier = ({ slow: 0.65, normal: 1, fast: 1.7 })[speed] ?? 1
  const enabled = speed === 'default' ? config.enabled !== false : speed !== 'instant'
  return normalizeTypingOptions({
    charsPerMinute: config.charsPerMinute ?? DEFAULT_TYPING_OPTIONS.charsPerMinute,
    rate: Math.max(0.1, Math.min(20, (config.rate ?? 1) * multiplier * (control.rate ?? 1))),
    maxWaitMs: enabled ? (config.maxWaitMs ?? DEFAULT_TYPING_OPTIONS.maxWaitMs) : 0,
  })
}

/**
 * Extract user-visible text from a string or an array of message segments.
 * Non-text segments (image, record, video, file, ...) are skipped explicitly.
 *
 * @param {string|Array<string|object>|object} content
 * @returns {string}
 * @throws {TypeError} when the content shape is unsupported.
 */
export function collectTypingText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const part of content) {
      if (typeof part === 'string') { text += part; continue }
      if (!part || typeof part !== 'object') continue
      if (part.type !== 'text') continue // Media and other non-text parts are intentionally ignored.
      const value = part.data?.text ?? part.text
      if (typeof value === 'string') text += value
    }
    return text
  }
  if (content && typeof content === 'object') {
    if (content.type !== undefined && content.type !== 'text') return ''
    const value = content.data?.text ?? content.text
    return typeof value === 'string' ? value : ''
  }
  throw new TypeError('Typing content must be a string, an object, or an array of message segments')
}

/**
 * Split text into user-perceived grapheme clusters. Falls back to a small
 * combining-mark/joiner-aware splitter when `Intl.Segmenter` is unavailable.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function segmentGraphemes(text) {
  if (typeof text !== 'string') throw new TypeError('Typing text must be a string')
  if (!text) return []
  const segmenter = getSegmenter()
  if (segmenter) return Array.from(segmenter.segment(text), part => part.segment)
  const clusters = []
  for (const char of text) {
    const last = clusters.at(-1)
    if (last !== undefined && (MARK_OR_JOINER_RE.test(char) || last.endsWith('\u200d'))) {
      clusters[clusters.length - 1] = last + char
    } else {
      clusters.push(char)
    }
  }
  return clusters
}

/**
 * Classify one grapheme cluster.
 *
 * @param {string} grapheme A non-empty grapheme cluster.
 * @returns {'cjk'|'letter'|'digit'|'punctuation'|'whitespace'|'newline'|'emoji'|'other'}
 */
export function classifyGrapheme(grapheme) {
  if (typeof grapheme !== 'string' || grapheme.length === 0) {
    throw new TypeError('A non-empty grapheme string is required')
  }
  if (NEWLINE_RE.test(grapheme)) return 'newline'
  if (WHITESPACE_RE.test(grapheme)) return 'whitespace'
  if (EMOJI_RE.test(grapheme)) return 'emoji'
  if (CJK_RE.test(grapheme)) return 'cjk'
  if (DIGIT_RE.test(grapheme)) return 'digit'
  if (PUNCTUATION_RE.test(grapheme)) return 'punctuation'
  if (LETTER_RE.test(grapheme)) return 'letter'
  return 'other'
}

/**
 * Estimate how long a natural typing simulation should last.
 *
 * @param {string|Array<string|object>|object} content Unicode text or message segments.
 * @param {object} [options] See {@link normalizeTypingOptions}.
 * @returns {number} Integer milliseconds, always within `[0, maxWaitMs]`.
 */
export function estimateTypingMs(content, options = {}) {
  const config = normalizeTypingOptions(options)
  const text = collectTypingText(content)
  if (config.maxWaitMs === 0 || text.trim() === '') return 0

  const baseMs = 60_000 / config.charsPerMinute / config.rate
  let total = 0
  for (const grapheme of segmentGraphemes(text)) {
    total += (TYPING_WEIGHTS[classifyGrapheme(grapheme)] ?? TYPING_WEIGHTS.other) * baseMs
    if (total >= config.maxWaitMs) return config.maxWaitMs
  }
  return Math.min(Math.round(total), config.maxWaitMs)
}
