import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const ENDPOINT = 'wss://api.deepseek.com/v1/tools/tts'
const SAMPLE_RATE = 24000
const MAX_AUDIO_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120000
const validVoice = value => value === 'stella' || value === 'tide'

export class DeepSeekVoiceError extends Error {
  constructor(code) { super(code); this.name = 'DeepSeekVoiceError'; this.code = code }
}

/** Turn the documented 24 kHz signed PCM stream into a portable mono WAV. */
export function pcmToWav(pcm) {
  if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > MAX_AUDIO_BYTES) throw new DeepSeekVoiceError('DEEPSEEK_TTS_INVALID_AUDIO')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.byteLength, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.byteLength, 40)
  return Buffer.concat([header, pcm])
}

async function pcmFromDeepSeek({ text, voice, key, signal, webSocketFactory, timeoutMs }) {
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key)) throw new DeepSeekVoiceError('DEEPSEEK_TTS_INVALID_CREDENTIAL')
  const url = new URL(ENDPOINT)
  url.searchParams.set('voice_id', voice); url.searchParams.set('format', 'pcm'); url.searchParams.set('filter_markdown', 'true')
  return new Promise((resolve, reject) => {
    let socket, timer, settled = false, total = 0, pending = Promise.resolve()
    const chunks = []
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      try { socket?.close() } catch { /* A failed or closed socket needs no further teardown. */ }
      if (error) reject(error); else resolve(value)
    }
    const fail = code => finish(new DeepSeekVoiceError(code))
    const abort = () => fail('DEEPSEEK_TTS_ABORTED')
    if (signal?.aborted) return abort()
    try {
      socket = webSocketFactory(url.href, ['tts', `bearer.${key}`])
      socket.binaryType = 'arraybuffer'
      timer = setTimeout(() => fail('DEEPSEEK_TTS_TIMEOUT'), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', () => {
        if (settled) return
        try { socket.send(JSON.stringify({ event: 'text', text })); socket.send(JSON.stringify({ event: 'finish_text' })) }
        catch { fail('DEEPSEEK_TTS_SEND_FAILED') }
      })
      socket.addEventListener('message', event => {
        pending = pending.then(async () => {
          if (settled) return
          if (typeof event.data === 'string') {
            let data
            try { data = JSON.parse(event.data) } catch { throw new DeepSeekVoiceError('DEEPSEEK_TTS_INVALID_RESPONSE') }
            if (data?.event === 'finish') {
              if (data.code !== 'success') throw new DeepSeekVoiceError('DEEPSEEK_TTS_FAILED')
              if (!total || total % 2) throw new DeepSeekVoiceError('DEEPSEEK_TTS_INVALID_AUDIO')
              finish(undefined, Buffer.concat(chunks, total))
            }
            return
          }
          const raw = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data
          const bytes = raw instanceof ArrayBuffer ? Buffer.from(raw) : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : undefined
          if (!bytes) throw new DeepSeekVoiceError('DEEPSEEK_TTS_INVALID_RESPONSE')
          total += bytes.byteLength
          if (total > MAX_AUDIO_BYTES) throw new DeepSeekVoiceError('DEEPSEEK_TTS_AUDIO_TOO_LARGE')
          chunks.push(bytes)
        }).catch(error => finish(error instanceof DeepSeekVoiceError ? error : new DeepSeekVoiceError('DEEPSEEK_TTS_FAILED')))
      })
      socket.addEventListener('error', () => fail('DEEPSEEK_TTS_CONNECTION_FAILED'))
      socket.addEventListener('close', () => { void pending.then(() => { if (!settled) fail('DEEPSEEK_TTS_INCOMPLETE') }) })
    } catch { fail('DEEPSEEK_TTS_CONNECTION_FAILED') }
  })
}

/** Produces one completed WAV without touching a session, output channel or disk. */
export function createDeepSeekSpeech({ resolveApiKey, webSocketFactory = (url, protocols) => new WebSocket(url, protocols), timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof resolveApiKey !== 'function') throw new TypeError('DeepSeek voice requires an API-key resolver')
  return async function synthesizeSpeech(text, config, { signal } = {}) {
    const limit = Math.max(60, Math.min(Number(config.maxChars) || 600, 3000))
    if (!config.enabled || typeof text !== 'string' || !text.trim() || text.length > limit || signal?.aborted) return
    const key = await resolveApiKey()
    if (typeof key !== 'string' || !key.trim()) throw new DeepSeekVoiceError('DEEPSEEK_TTS_MISSING_CREDENTIAL')
    const voice = validVoice(config.deepseekVoice) ? config.deepseekVoice : validVoice(config.voice) ? config.voice : 'stella'
    const pcm = await pcmFromDeepSeek({ text, voice, key: key.trim(), signal, webSocketFactory, timeoutMs })
    signal?.throwIfAborted()
    return pcmToWav(pcm)
  }
}

/** Reuses the official DeepSeek API-key resolver; only the completed audio is saved. */
export function createDeepSeekVoiceSynthesizer({ cacheDir, ...options }) {
  if (typeof cacheDir !== 'string' || !cacheDir) throw new TypeError('DeepSeek voice requires a cache directory')
  const synthesizeSpeech = createDeepSeekSpeech(options)
  return async function synthesize(text, config, context = {}) {
    const audio = await synthesizeSpeech(text, config, context)
    if (!audio) return ''
    await mkdir(cacheDir, { recursive: true })
    const file = join(cacheDir, `v-${randomUUID()}.wav`)
    await writeFile(file, audio, { flag: 'wx' })
    return pathToFileURL(file).href
  }
}
