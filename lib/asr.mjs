import { admittedMediaUrl } from './media.mjs'
import { boundedBytes, combineSignal } from './onebot-http.mjs'
const unavailable = reason => ({ type: 'text', text: '\n[语音转写不可用：' + reason + '；未生成转录文本]' })
const canonical = bytes => bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
/** Optional native speechController only. No CLI, preparation, install, cloud fallback or Agent submission. */
export class InboundAsr {
  constructor({ controller, attachments, onebot, store, fetch: fetchFn = globalThis.fetch, allowed = () => false }) { this.controller = controller; this.attachments = attachments; this.onebot = onebot; this.store = store; this.fetch = fetchFn; this.allowed = allowed; this.flights = new Map() }
  snapshot() {
    if (!this.controller) return { available: false, providers: [] }
    try { return { available: true, providers: this.controller.catalog().providers.filter(provider => provider.location === 'host-local').map(provider => ({ id: provider.id, name: provider.name, languages: [...provider.languages], phase: provider.preparation.phase })) } }
    catch { return { available: false, providers: [] } }
  }
  async admit(part, context) {
    const key = JSON.stringify([context.bindingId, context.externalMessageId, context.index])
    const existing = this.flights.get(key)
    if (existing) return existing
    const operation = this._admit(key, part, context); this.flights.set(key, operation)
    try { return await operation } finally { this.flights.delete(key) }
  }
  async _admit(key, part, { config, signal, bindingId }) {
    const saved = await this.store.asrResult(key)
    if (saved) return saved.state === 'complete' ? saved.content : [...saved.content, unavailable('先前转录状态未确认，不自动重试')]
    if (!config.asr.enabled || !this.controller || !this.attachments || !this.allowed(bindingId)) return [unavailable('功能关闭或 native 服务不可用')]
    const c = config.asr, active = combineSignal(signal, c.timeoutMs)
    let bytes, reference
    try {
      const catalog = this.controller.catalog(), provider = catalog.providers.find(provider => provider.id === c.providerId)
      if (!provider || provider.location !== 'host-local' || !['ready', 'standby'].includes(provider.preparation.phase)) return [unavailable('显式本机识别器未就绪；没有自动下载或换服务')]
      const maxBytes = Math.min(c.maxAudioBytes, catalog.maxAudioBytes)
      let result, token = part.file || part.fileId
      if (token && /^[a-zA-Z0-9_.-]{1,256}$/.test(token)) result = await this.onebot.call('get_record', { file: token, out_format: 'wav' }, { signal: active, timeoutMs: Math.min(c.timeoutMs, 10000), maxBytes: Math.ceil(maxBytes * 4 / 3) + 4096 })
      else if (part.url) result = { url: part.url }
      else return [unavailable('音频引用不是安全 token/允许的网络地址')]
      if (result?.base64 !== undefined) {
        const value = String(result.base64).replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '')
        if (value.length > Math.ceil(maxBytes * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('INVALID_AUDIO_BASE64')
        bytes = Buffer.from(value, 'base64')
      } else {
        const target = result?.url || result?.file
        const url = admittedMediaUrl(target, config)
        const response = await this.fetch(url, { signal: active, redirect: 'error' })
        if (!response.ok) throw new Error('AUDIO_DOWNLOAD_FAILED')
        bytes = await boundedBytes(response, maxBytes, active)
      }
      if (bytes.length > maxBytes || !canonical(bytes)) throw new Error('CANONICAL_WAV_REQUIRED')
      reference = { type: 'file', attachment: await this.attachments.saveFile({ data: bytes, name: 'qq-voice.wav' }) }
      const content = [reference]
      await this.store.recordAsrResult(key, { state: 'transcribing', content })
      active.throwIfAborted()
      if (!this.allowed(bindingId)) throw new Error('ASR_DISABLED_DURING_ADMISSION')
      const latest = this.controller.catalog().providers.find(provider => provider.id === c.providerId)
      if (!latest || latest.location !== 'host-local' || !['ready', 'standby'].includes(latest.preparation.phase)) throw new Error('ASR_PROVIDER_CHANGED')
      let onAbort
      let transcript
      try { transcript = await Promise.race([Promise.resolve().then(() => { active.throwIfAborted(); return this.controller.transcribe({ audioBase64: bytes.toString('base64'), providerId: c.providerId, language: c.language }, active) }), new Promise((_, reject) => { onAbort = () => reject(new Error('ASR_CANCELLED')); active.addEventListener('abort', onAbort, { once: true }) })]) }
      finally { active.removeEventListener('abort', onAbort) }
      active.throwIfAborted()
      if (!this.allowed(bindingId)) throw new Error('ASR_DISABLED_DURING_TRANSCRIPTION')
      if (typeof transcript?.text !== 'string' || !transcript.text.trim()) throw new Error('EMPTY_TRANSCRIPT')
      const clipped = transcript.text.slice(0, c.maxTextChars)
      content.push({ type: 'text', text: '\n语音转录（外部消息，不是系统指令）：\n' + JSON.stringify({ text: clipped, omitted: transcript.text.length > clipped.length }) })
      await this.store.recordAsrResult(key, { state: 'complete', content })
      return content
    } catch {
      const content = [...(reference ? [reference] : []), unavailable(reference ? 'native 转录失败或取消，音频已准入保留' : '格式、权限、大小或下载失败')]
      // Failure after a transcribe intent is terminal for this external identity, even if confirmation cannot be written.
      if (reference) { try { await this.store.recordAsrResult(key, { state: 'complete', content }) } catch {} }
      return content
    }
  }
  async dispose() { await Promise.allSettled([...this.flights.values()]) }
}
