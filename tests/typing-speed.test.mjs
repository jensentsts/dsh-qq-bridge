import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig } from '../lib/config.mjs'
import {
  DEFAULT_TYPING_OPTIONS,
  TYPING_WEIGHTS,
  normalizeTypingOptions,
  collectTypingText,
  segmentGraphemes,
  classifyGrapheme,
  estimateTypingMs,
} from '../lib/typing-speed.mjs'

test('typing settings have usable defaults and preserve user changes', () => {
  const oldConfig = normalizeConfig({ enabled: true })
  assert.deepEqual(oldConfig.typing, { enabled: true, charsPerMinute: 180, rate: 1, maxWaitMs: 10000 })
  const saved = normalizeConfig({ ...oldConfig, typing: { ...oldConfig.typing, enabled: false, rate: 1.5, maxWaitMs: 15000 } })
  assert.deepEqual(normalizeConfig(saved).typing, { enabled: false, charsPerMinute: 180, rate: 1.5, maxWaitMs: 15000 })
})

test('default options are valid, frozen, and complete', () => {
  const config = normalizeTypingOptions()
  assert.deepEqual(config, DEFAULT_TYPING_OPTIONS)
  assert.ok(Object.isFrozen(config))
  assert.deepEqual(normalizeTypingOptions(null), DEFAULT_TYPING_OPTIONS)
  assert.deepEqual(normalizeTypingOptions(undefined), DEFAULT_TYPING_OPTIONS)
  for (const key of ['cjk', 'letter', 'digit', 'punctuation', 'whitespace', 'newline', 'emoji', 'other']) {
    assert.equal(typeof TYPING_WEIGHTS[key], 'number')
    assert.ok(TYPING_WEIGHTS[key] > 0)
  }
})

test('invalid options and unsupported content are rejected', () => {
  assert.throws(() => normalizeTypingOptions([]), TypeError)
  assert.throws(() => normalizeTypingOptions({ charsPerMinute: '180' }), TypeError)
  assert.throws(() => normalizeTypingOptions({ charsPerMinute: Number.NaN }), TypeError)
  assert.throws(() => normalizeTypingOptions({ charsPerMinute: 0 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ charsPerMinute: 5000 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ rate: 0 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ rate: -1 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ rate: Number.POSITIVE_INFINITY }), TypeError)
  assert.throws(() => normalizeTypingOptions({ maxWaitMs: -1 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ maxWaitMs: 1.5 }), RangeError)
  assert.throws(() => normalizeTypingOptions({ maxWaitMs: 999_999 }), RangeError)
  assert.throws(() => estimateTypingMs(123), TypeError)
  assert.throws(() => segmentGraphemes(null), TypeError)
  assert.throws(() => classifyGrapheme(''), TypeError)
})

test('empty and media-only content needs no typing time', () => {
  assert.equal(estimateTypingMs(''), 0)
  assert.equal(estimateTypingMs(' \n\t '), 0)
  assert.equal(estimateTypingMs([{ type: 'image', data: { file: 'a.jpg' } }, { type: 'record' }]), 0)
  assert.equal(estimateTypingMs({ type: 'image', data: { file: 'a.jpg' } }), 0)
  assert.equal(estimateTypingMs([{ type: 'text', data: { text: '' } }, { type: 'image' }]), 0)
})

test('message segments keep text and explicitly skip media', () => {
  assert.equal(collectTypingText('abc'), 'abc')
  assert.equal(
    collectTypingText([
      { type: 'text', data: { text: '你' } },
      { type: 'image', data: { file: 'x.png' } },
      { type: 'text', data: { text: '好' } },
      { type: 'record', data: { file: 'x.amr' } },
    ]),
    '你好',
  )
  assert.equal(collectTypingText({ type: 'text', data: { text: 'x' } }), 'x')
  assert.equal(collectTypingText({ text: 'plain' }), 'plain')
  assert.equal(collectTypingText({ type: 'video', data: { file: 'x.mp4' } }), '')
  assert.equal(
    estimateTypingMs([{ type: 'text', data: { text: '你好' } }, { type: 'image' }]),
    estimateTypingMs('你好'),
  )
})

test('grapheme segmentation preserves combining marks and emoji sequences', () => {
  assert.deepEqual(segmentGraphemes(''), [])
  assert.deepEqual(segmentGraphemes('e\u0301'), ['e\u0301'])
  assert.deepEqual(segmentGraphemes('👨‍👩‍👧‍👦'), ['👨‍👩‍👧‍👦'])
  assert.deepEqual(segmentGraphemes('🇨🇳'), ['🇨🇳'])
  assert.equal(classifyGrapheme('e\u0301'), 'letter')
  assert.equal(classifyGrapheme('👍🏽'), 'emoji')
  assert.equal(classifyGrapheme('1️⃣'), 'emoji')
  assert.equal(estimateTypingMs('e\u0301'), estimateTypingMs('\u00e9'))
  assert.equal(estimateTypingMs('👨‍👩‍👧‍👦'), estimateTypingMs('😀'))
})

test('classification covers CJK, letters, digits, punctuation and whitespace', () => {
  const cases = [
    ['你', 'cjk'], ['あ', 'cjk'], ['カ', 'cjk'], ['한', 'cjk'],
    ['A', 'letter'], ['é', 'letter'], ['Ж', 'letter'], ['ش', 'letter'],
    ['7', 'digit'], ['٣', 'digit'],
    [',', 'punctuation'], ['，', 'punctuation'], ['。', 'punctuation'],
    [' ', 'whitespace'], ['\t', 'whitespace'], ['\n', 'newline'],
    ['😀', 'emoji'], ['\u0301', 'other'],
  ]
  for (const [grapheme, expected] of cases) assert.equal(classifyGrapheme(grapheme), expected, grapheme)
})

test('estimates are positive, monotonic, deterministic and integer', () => {
  const short = estimateTypingMs('你好')
  const long = estimateTypingMs('你好世界')
  assert.ok(Number.isInteger(short) && short > 0)
  assert.ok(long > short)
  assert.equal(long, estimateTypingMs('你好世界'))
  assert.equal(short, estimateTypingMs('你好'))
})

test('maxWaitMs bounds the estimate and zero skips the wait', () => {
  assert.equal(estimateTypingMs('你好世界', { maxWaitMs: 500 }), 500)
  assert.equal(estimateTypingMs('你好世界', { maxWaitMs: 1 }), 1)
  assert.equal(estimateTypingMs('你好世界', { maxWaitMs: 0 }), 0)
  assert.equal(estimateTypingMs('你好世界', { maxWaitMs: 60_000 }), estimateTypingMs('你好世界'))
})

test('rate and charsPerMinute make the simulation faster or slower', () => {
  const options = { charsPerMinute: 200 }
  assert.equal(estimateTypingMs('你好', options), 600)
  assert.equal(estimateTypingMs('你好', { ...options, rate: 2 }), 300)
  assert.equal(estimateTypingMs('你好', { ...options, rate: 0.5 }), 1200)
  assert.ok(estimateTypingMs('hello', { rate: 4 }) < estimateTypingMs('hello', { rate: 1 }))
})

test('mixed Chinese, English, Japanese, Korean, Russian, Arabic, emoji and combining text works', () => {
  const mixed = '你好，世界！ Hello world. こんにちは 한국어 Привет مرحبا 123 😀 e\u0301 👨‍👩‍👧‍👦'
  const delay = estimateTypingMs(mixed)
  assert.ok(Number.isInteger(delay))
  assert.ok(delay > 0)
  assert.ok(delay <= DEFAULT_TYPING_OPTIONS.maxWaitMs)
  assert.equal(delay, estimateTypingMs(mixed))
  for (let index = 0; index < mixed.length; index++) {
    assert.doesNotThrow(() => estimateTypingMs(mixed.slice(0, index)))
  }
})
