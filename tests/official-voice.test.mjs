import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createDeepSeekVoiceSynthesizer, pcmToWav } from '../lib/official-voice.mjs'
import { planVoice } from '../lib/onebot.mjs'

async function testDir(t) {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, 'dsh-deepseek-voice-'))
  if (!resolve(dir).startsWith(root + sep) || !dir.includes('dsh-deepseek-voice-')) throw new Error('Unexpected test directory')
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
class FakeSocket {
  constructor(run) { this.listeners = new Map(); this.sent = []; this.run = run; queueMicrotask(() => this.emit('open')) }
  addEventListener(name, fn) { this.listeners.set(name, fn) }
  emit(name, data = {}) { this.listeners.get(name)?.(data) }
  send(text) { this.sent.push(JSON.parse(text)); if (this.sent.at(-1).event === 'finish_text') queueMicrotask(() => this.run(this)) }
  close() {}
}

test('DeepSeek voice reuses the key resolver and saves completed PCM as 24 kHz mono WAV', async t => {
  const dir = await testDir(t), calls = [], sockets = []
  const synthesize = createDeepSeekVoiceSynthesizer({ cacheDir: dir, resolveApiKey: async () => 'fixture-key', webSocketFactory: (url, protocols) => {
    calls.push({ url, protocols })
    const ws = new FakeSocket(socket => {
      socket.emit('message', { data: Uint8Array.of(0, 1, 2).buffer })
      socket.emit('message', { data: Uint8Array.of(3).buffer })
      socket.emit('message', { data: JSON.stringify({ event: 'finish', code: 'success' }) })
      socket.emit('close')
    }); sockets.push(ws); return ws
  } })
  const output = await synthesize('你好，主人。', { enabled: true, deepseekVoice: 'tide' })
  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(url.origin, 'wss://api.deepseek.com'); assert.equal(url.pathname, '/v1/tools/tts')
  assert.equal(url.searchParams.get('voice_id'), 'tide'); assert.equal(url.searchParams.get('format'), 'pcm')
  assert.deepEqual(calls[0].protocols, ['tts', 'bearer.fixture-key'])
  assert.deepEqual(sockets[0].sent, [{ event: 'text', text: '你好，主人。' }, { event: 'finish_text' }])
  const wav = await readFile(fileURLToPath(output))
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16)
  assert.deepEqual(wav.subarray(44), Buffer.from([0, 1, 2, 3]))
})

test('an interrupted or refused TTS stream creates no file and QQ keeps the original text', async t => {
  const dir = await testDir(t)
  for (const behavior of ['closed', 'refused']) {
    const synthesize = createDeepSeekVoiceSynthesizer({ cacheDir: dir, resolveApiKey: async () => 'fixture-key', webSocketFactory: () => new FakeSocket(socket => {
      socket.emit('message', { data: Uint8Array.of(0, 1).buffer })
      if (behavior === 'refused') socket.emit('message', { data: JSON.stringify({ event: 'finish', code: 'service_error' }) })
      socket.emit('close')
    }) })
    const original = { action: 'send_private_msg', params: { user_id: 123, message: [{ type: 'text', data: { text: '请听语音' } }] } }
    const plan = await planVoice(original, { enabled: true }, synthesize)
    assert.equal(plan.synthesized, false); assert.deepEqual(plan.messages, [original])
  }
  assert.deepEqual(await readdir(dir), [])
})

test('missing credentials, cancellation and invalid audio never create an output', async t => {
  const dir = await testDir(t); let opened = 0
  const create = key => createDeepSeekVoiceSynthesizer({ cacheDir: dir, resolveApiKey: async () => key, webSocketFactory: () => { opened++; throw new Error('unexpected') } })
  await assert.rejects(create('')('文字', { enabled: true }), { code: 'DEEPSEEK_TTS_MISSING_CREDENTIAL' })
  const aborted = new AbortController(); aborted.abort()
  assert.equal(await create('fixture-key')('文字', { enabled: true }, { signal: aborted.signal }), '')
  assert.throws(() => pcmToWav(Uint8Array.of(1)), { code: 'DEEPSEEK_TTS_INVALID_AUDIO' })
  assert.equal(opened, 0); assert.deepEqual(await readdir(dir), [])
})
