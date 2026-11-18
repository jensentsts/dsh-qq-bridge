import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { TRANSPORT_ID, normalizeEvent, normalizeQuote, normalizeSegments, quoteText, planOutbound, planVoice, parseEndpoint, splitChatMessages } from './onebot.mjs'
import { normalizeConfig, migrateLegacyConfig } from './config.mjs'
import { RichReader } from './rich.mjs'
import { InboundPolicy } from './admission.mjs'
import { MergeWindow } from './merge.mjs'
import { prepareOutboundContent, withGroupMentions } from './outbound-content.mjs'
import { isRecallNotice, recalledMessage, recallExcerpt, recallNotice, recallText, recallTime } from './recall.mjs'
import { OneBotError } from './onebot-http.mjs'
import { isQqStatusEvent } from './status.mjs'
import { QqOutbox } from './outbox.mjs'
import { estimateTypingMs, resolveTypingOptions } from './typing-speed.mjs'
import { isPeerTypingEvent, peerTypingNotice } from './peer-typing.mjs'
const safeReason = error => typeof error?.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'OPERATION_FAILED'
const mergeId = (bindingId, events) => 'merge:' + createHash('sha256').update(JSON.stringify([bindingId, ...events.map(event => event.externalMessageId)])).digest('hex').slice(0, 32)
const quotaTriggerKey = (bindingId, externalMessageId) => JSON.stringify(['quota-trigger', bindingId, externalMessageId])
const receiveCode = /^DSH-RECV-[0-9a-f]{32}$/
const sendRequestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const outboundPrefix = TRANSPORT_ID + ':outbound:'
const senderField = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
function senderLine(event) {
  const name = senderField(event.senderNickname)
  const title = senderField(event.senderTitle)
  const card = senderField(event.senderCard)
  return `${event.senderId}${name ? ' ' + name : ''}${title ? '<' + title + '>' : ''}${card ? '【' + card + '】' : ''}:`
}
export class QqBridge {
  constructor({ io, onebot, store, media = {}, synthesize, modelPolicy, quotaPolicy, asr, nativeFeatures, qqStatus, config, onConfig, networkEnabled = () => true, report = () => {}, typingWait = (ms, signal) => wait(ms, undefined, { signal }), confirmTypingClock = true }) {
    if (io?.contractVersion !== 1) throw new Error('superAgentIo v1 is required')
    this.io = io; this.onebot = onebot; this.store = store; this.media = media; this.synthesize = synthesize; this.modelPolicy = modelPolicy; this.quotaPolicy = quotaPolicy; this.asr = asr; this.nativeFeatures = nativeFeatures; this.rich = new RichReader({ onebot }); this.admission = new InboundPolicy({ store }); this.config = normalizeConfig(config); this.onConfig = onConfig; this.report = report; this.poller = undefined; this.scheduleAvailable = false
    this.flights = new Map(); this.bindingFlights = new Set(); this.deliveryFlights = new Map(); this.controller = new AbortController(); this.closed = false; this.preloads = []; this.settingsTail = Promise.resolve()
    this.receiveTests = new Map()
    this.typingWait = typingWait
    this.confirmTypingClock = confirmTypingClock
    this.typingActivities = new Map()
    this.typingControllers = new Map()
    this.peerInputStates = new Map()
    this.qqStatus = qqStatus
    this.recentRecallMessages = new Map()
    this.networkEnabled = networkEnabled
    this.outbox = new QqOutbox(this, { projection: nativeFeatures?.projection })
    this.merger = new MergeWindow({ settings: () => ({ ...this.config.merge, enabled: this.config.enabled }), serial: true, ingest: (events, binding, signal) => this._ingest(events, binding, signal), signal: this.controller.signal, report: this.report })
    this.off = io.registerTransport({
      id: TRANSPORT_ID,
      channel: 'qq',
      explicitSend: true,
      textHint: 'QQ 群聊正文用 @QQ号 点名具体成员。io_send 先入待发箱，用 qq_outbox 的 send 操作发送。',
      outboundTargets: () => this.outboundTargets(),
      probe: (binding, context) => this.probe(binding, context),
      deliver: (delivery, context) => this.deliver(delivery, context),
    })
  }
  async start() { await this.admission.restore(this.config.bindings); await this._syncBindings([]); return this }
  async _syncBindings(previous) {
    const nextIds = new Set(this.config.bindings.map(b => b.id))
    for (const old of previous) if (!nextIds.has(old.id)) await this.io.putBinding({ ...old, transport: TRANSPORT_ID, enabled: false, sendEnabled: false })
    // Remove stale persisted routes left by a prior crash/save before admitting any current route.
    if (typeof this.io.listBindings === 'function') for (const stale of this.io.listBindings()) {
      if (stale.transport === TRANSPORT_ID && !nextIds.has(stale.id) && (stale.enabled || stale.sendEnabled)) await this.io.putBinding({ ...stale, enabled: false, sendEnabled: false })
    }
    await this.modelPolicy?.reconcile(this.config.enabled ? this.config.bindings : [])
    await this.quotaPolicy?.reconcile(this.config.enabled ? this.config.bindings : [])
    await this.nativeFeatures?.reconcile(this.config.enabled ? this.config.bindings : [])
    this.preloads = []
    for (const row of this.config.bindings) {
      if (this.config.enabled && row.enabled) { await this.modelPolicy?.prepare(row); await this.quotaPolicy?.arm(row); await this._prepareNativeFeatures(row) }
      const binding = await this.io.putBinding({ id: row.id, transport: TRANSPORT_ID, endpoint: row.endpoint, sessionId: row.sessionId, label: row.label, mode: row.mode, enabled: this.config.enabled && row.enabled, sendEnabled: this.config.sendEnabled && row.sendEnabled, preload: row.preload, ...(row.continuation ? { continuation: row.continuation } : {}) })
      if (binding.enabled && row.preload) {
        try { this.preloads.push({ bindingId: row.id, ...(await this.io.preload(row.id)) }) }
        catch (error) { this.preloads.push({ bindingId: row.id, ready: false, reason: safeReason(error) }) }
      }
    }
  }
  featureBinding(binding) {
    return binding && { ...binding, persona: binding.persona?.enabled ? binding.persona : this.config.defaultPersona }
  }
  _prepareNativeFeatures(binding) {
    return this.nativeFeatures?.prepare(this.featureBinding(binding))
  }
  outboundTargets() {
    return this.closed || !this.config.sendEnabled ? [] : this.config.outboundTargets.filter(target => target.enabled)
  }
  sendTarget(id, explicit = false) {
    if (this.closed || !this.config.sendEnabled || typeof id !== 'string') return undefined
    if (explicit && id.startsWith(outboundPrefix)) {
      const target = this.outboundTargets().find(row => row.endpoint === id.slice(outboundPrefix.length))
      return target && { ...target, id, outboundOnly: true }
    }
    if (this.config.enabled) return this.config.bindings.find(row => row.id === id && row.enabled && row.sendEnabled)
  }
  statusTarget(id) {
    if (this.closed || typeof id !== 'string') return
    if (id.startsWith(outboundPrefix)) {
      const target = this.config.outboundTargets.find(row => row.enabled && row.endpoint === id.slice(outboundPrefix.length))
      return target && { ...target, id }
    }
    if (this.config.enabled) return this.config.bindings.find(row => row.enabled && row.id === id)
  }
  statusGroupAllowed(endpoint) {
    return this.config.enabled && this.config.bindings.some(row => row.enabled && row.endpoint === endpoint) ||
      this.config.outboundTargets.some(row => row.enabled && row.endpoint === endpoint)
  }
  async checkSendStatus(endpoint, signal) {
    return (await this.qqStatus?.read(endpoint, { signal }))?.reason
  }
  assertSendStatus(endpoint) {
    const reason = this.qqStatus?.snapshot(endpoint).reason
    if (reason) throw new OneBotError(reason, 'failed')
  }
  async sendFailureReason(error, endpoint, signal) {
    const reason = safeReason(error)
    if (!this.qqStatus || reason !== 'ONEBOT_API_REJECTED' || signal?.aborted) return reason
    const origin = this.config.baseUrl
    const updated = await this.qqStatus.read(endpoint, { signal, refresh: true }).catch(() => undefined)
    return origin === this.config.baseUrl && updated?.reason || reason
  }
  state() { return { config: structuredClone(this.config), preloads: structuredClone(this.preloads), modelPolicies: this.modelPolicy?.snapshot() ?? [], quotaPolicies: this.quotaPolicy?.snapshot() ?? [], nativeFeatures: this.nativeFeatures?.snapshot() ?? [], admission: this.admission.snapshot(), asr: this.asr?.snapshot() ?? { available: false, providers: [] }, polling: this.poller?.snapshot() ?? { enabled: false, intervalMs: 0, watermarks: [] }, merge: this.merger?.snapshot?.() ?? [], schedules: { available: this.scheduleAvailable, autoCreate: false }, capabilities: { ioVersion: 1, nativeQuote: true, allAssistantMessages: true, legacyNetwork: false, bindingModelDefaults: !!this.modelPolicy, quotaFallbackNextInput: !!this.quotaPolicy, quotaDiagnosticExternalSend: true, asr: !!this.asr, richCards: true, mergedForwards: true, perBindingFilters: true, persona: !!this.nativeFeatures, replyGate: !!this.nativeFeatures, qzone: !!this.nativeFeatures, historyPolling: true, mergeWindow: true, scheduleService: this.scheduleAvailable, scheduleAutoCreate: false, history: true }, limitations: ['Binding model defaults apply only before an unprepared boundary; native changes win after arming.', 'Quota fallback is next distinct idle QQ input only; no failed request replay. Configured quota replies are sent for private messages and group mentions after a verified balance failure. ASR/rich/filter/persona/gate are explicit opt-ins; polling and cross-message merge are explicit opt-ins.', 'Qzone writes and schedule creation run only through a user or Agent call and obey the business send gate; this package never creates a schedule task during load/save/import.', 'No live installation or visual/real-message verification has been performed.'] } }
  save(input) {
    const operation = this.settingsTail.then(async () => {
      if (this.closed) throw new Error('Bridge disposed')
      const next = normalizeConfig(input), previous = this.config.bindings
      if (!next.enabled) this.merger.cancelPending(undefined, 'BRIDGE_DISABLED')
      else for (const binding of previous) {
        const replacement = next.bindings.find(row => row.id === binding.id)
        if (!replacement?.enabled || replacement.endpoint !== binding.endpoint || replacement.sessionId !== binding.sessionId) this.merger.cancelPending(binding.id, 'BINDING_CHANGED')
      }
      // Persist conservative intended configuration first; IO can only receive an equally/more closed gate.
      await this.store.setConfig(next)
      if (this.config.baseUrl !== next.baseUrl) this.recentRecallMessages.clear()
      this.config = next
      await this._syncBindings(previous)
      if (next.enabled && !next.merge.enabled) await this.merger.flushAll()
      await this.onConfig?.(next)
      return this.state()
    })
    this.settingsTail = operation.catch(() => {})
    return operation
  }
  async importLegacy(value, { importCredentials } = {}) {
    const imported = migrateLegacyConfig(value)
    if (Object.keys(imported.credentials).length) {
      if (typeof importCredentials !== 'function') throw new Error('Credential import requires trusted Host credential storage')
      await importCredentials(imported.credentials)
    }
    await this.store.setLegacy(imported.retainedLegacy)
    await this.save(imported.config)
    return { ...this.state(), warnings: imported.warnings }
  }
  startReceiveTest(bindingId, endpoint) {
    const binding = this.config.bindings.find(row => row.id === bindingId)
    if (!binding || binding.endpoint !== endpoint) return { state: 'blocked', reason: 'TEST_TARGET_CHANGED' }
    if (this.closed || !this.config.enabled || !binding?.enabled) return { state: 'blocked', reason: 'QQ_RECEIVE_DISABLED' }
    const now = Date.now()
    for (const [key, test] of this.receiveTests) if (test.expiresAt <= now) this.receiveTests.delete(key)
    const test = {
      state: 'waiting', code: 'DSH-RECV-' + randomBytes(16).toString('hex'),
      endpoint: binding.endpoint, expiresAt: now + 120000,
    }
    this.receiveTests.set(bindingId, test)
    return { ...test }
  }
  receiveTestStatus(bindingId, code) {
    const test = this.receiveTests.get(bindingId)
    if (!test || test.code !== code) return { state: 'expired' }
    if (test.state === 'received') return { ...test }
    const binding = this.config.bindings.find(row => row.id === bindingId)
    if (!this.config.enabled || !binding?.enabled || binding.endpoint !== test.endpoint || test.expiresAt <= Date.now()) return { state: 'expired' }
    return { ...test }
  }
  async receive(event, { signal, via } = {}) {
    if (this.closed || !this.config.enabled) throw new Error('QQ bridge disabled')
    if (isPeerTypingEvent(event)) return this.observePeerTyping(event) ? { recorded: true, kind: 'peer-input-status' } : { ignored: true }
    if (this.qqStatus && isQqStatusEvent(event)) {
      const scope = this.config.baseUrl
      const status = await this.qqStatus.read(undefined, { signal })
      return scope === this.config.baseUrl && this.qqStatus.observe(event, status.account.id)
        ? { recorded: true, kind: 'qq-status' } : { ignored: true }
    }
    if (isRecallNotice(event)) {
      const baseUrl = this.config.baseUrl
      const activeSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
      const allowed = (endpoint, sender, self) => !activeSignal.aborted && this.config.baseUrl === baseUrl && this._recallAllowed(endpoint, sender, self)
      const notice = await recallNotice(event, query => this._recallOriginal(query, activeSignal), allowed)
      if (!notice) return { ignored: true }
      await this.noteRecall(notice, baseUrl)
      return { recorded: true, kind: 'recall' }
    }
    const normalized = normalizeEvent(event)
    if (!normalized) return { ignored: true }
    if (this.buttonActions?.observe(event, normalized)) return { ignored: true, reason: 'QQ_BUTTON_RESPONSE' }
    const binding = this.config.bindings.find(b => b.enabled && b.endpoint === normalized.endpoint)
    if (!binding) return { ignored: true, reason: 'UNBOUND_CHAT' }
    const peerInput = this.peerInputStates.get(normalized.endpoint), messageTime = Number(normalized.time)
    if (peerInput && Number.isFinite(messageTime) && messageTime > 0 && messageTime * 1000 + 999 >= peerInput.observedAt) this.peerInputStates.delete(normalized.endpoint)
    this._rememberRecallMessage(normalized)
    const text = normalized.text.trim()
    if (receiveCode.test(text) && !normalized.media.length && !normalized.rich.length) {
      const test = this.receiveTests.get(binding.id)
      if (test?.state === 'waiting' && test.code === text && test.endpoint === binding.endpoint && test.expiresAt > Date.now()) {
        Object.assign(test, { state: 'received', receivedAt: Date.now(), via })
      }
      return { diagnostic: 'receive-test' }
    }
    return this.merger.enqueue(normalized, binding, { signal })
  }
  observePeerTyping(event) {
    if (this.closed || !this.config.enabled || !this.networkEnabled()) return false
    const notice = peerTypingNotice(event)
    if (!notice || !this.config.bindings.some(row => row.enabled && row.endpoint === notice.endpoint)) return false
    this.peerInputStates.set(notice.endpoint, { ...notice, origin: this.config.baseUrl })
    return true
  }
  peerTyping(endpoint) {
    const status = this.peerInputStates.get(endpoint)
    if (!status || status.origin !== this.config.baseUrl || status.expiresAt <= Date.now()) {
      if (status) this.peerInputStates.delete(endpoint)
      return { state: 'unknown' }
    }
    const { origin, endpoint: ignored, ...detail } = status
    return { state: 'reported', ...detail }
  }
  cancelTyping(bindingId, id) {
    const typing = this.typingControllers.get(bindingId)
    if (!typing || id && typing.id !== id) return false
    typing.controller.abort(Object.assign(new Error('Typing cancelled'), { code: 'QQ_TYPING_CANCELLED' }))
    return true
  }
  interruptTypingOnIncoming(binding, externalMessageId) {
    const typing = this.typingControllers.get(binding.id)
    const reason = typing?.onIncoming?.(externalMessageId)
    if (reason && !typing.controller.signal.aborted) typing.controller.abort(reason)
  }
  async noteRecall(value, origin = this.config.baseUrl) {
    return this.store.recordRecall({ ...value, origin })
  }
  _recallAllowed(endpoint, senderId, selfId) {
    if (this.closed || !this.networkEnabled() || !this.config.enabled) return false
    const binding = this.config.bindings.find(row => row.enabled && row.endpoint === endpoint)
    const rule = binding?.admission
    return !!binding && (!senderId || senderId === selfId || !rule?.enabled || !rule.allowedSenders.length || rule.allowedSenders.includes(senderId))
  }
  observeRecallMessage(raw) {
    if (raw?.post_type !== 'message') return
    const message = normalizeEvent(raw, { maxTextChars: 320, maxSegments: 24 })
    if (message) this._rememberRecallMessage(message)
  }
  _rememberRecallMessage(message) {
    if (!this._recallAllowed(message.endpoint, message.senderId, message.selfId)) return
    const key = JSON.stringify([message.endpoint, message.externalMessageId])
    this.recentRecallMessages.delete(key)
    this.recentRecallMessages.set(key, { senderId: message.senderId, senderName: message.senderName, excerpt: recallExcerpt(message), time: recallTime(message.time) })
    if (this.recentRecallMessages.size > 512) this.recentRecallMessages.delete(this.recentRecallMessages.keys().next().value)
  }
  async _recallOriginal(query, signal) {
    const { endpoint, messageId, selfId } = query
    const recent = this.recentRecallMessages.get(JSON.stringify([endpoint, messageId]))
    if (recent) return recent
    const known = await this.store.messageRecord(messageId)
    if (known?.endpoint === endpoint && known.origin === this.config.baseUrl && (known.senderId || known.outbound)) return known
    try {
      const id = Number(messageId)
      const data = await this.onebot.call('get_msg', { message_id: Number.isSafeInteger(id) ? id : messageId }, { signal, timeoutMs: 3000, maxBytes: 1048576 })
      return recalledMessage(data, { endpoint, messageId, selfId, knownEndpoint: known?.origin === this.config.baseUrl ? known.endpoint : undefined })
    } catch { return undefined }
  }
  _seen(seen) { return this.io.receipt?.(seen.traceId) ?? { traceId: seen.traceId, duplicate: true, state: 'unknown', reason: 'RECEIPT_NO_LONGER_AVAILABLE' } }
  _canRetrySeen(seen) {
    try { return this.io.receipt?.(seen.traceId)?.state === 'failed' } catch { return false }
  }
  async _receive(event, binding, signal) {
    signal?.throwIfAborted()
    const seen = await this.store.ingressReceipt(binding.id, event.externalMessageId)
    if (seen && !this._canRetrySeen(seen)) return this._seen(seen)
    const prepared = await this._prepare(event, binding, signal)
    if (!prepared.admitted) return { ignored: true, filtered: true, reason: prepared.reason, queued: false }
    return this._dispatch([{ event, content: prepared.content }], binding, signal)
  }
  async _prepare(event, binding, signal) {
    signal?.throwIfAborted()
    const content = [], c = this.config, warnings = event.warnings.filter(value => !c.rich.cards && value.startsWith('json ') || !c.rich.cards && value.startsWith('xml ') || !c.rich.forwards && value.startsWith('forward ') || !/^(json|xml|forward) /.test(value))
    const earlier = await this.admission.precheck(event, binding)
    if (earlier?.admitted === false) return { admitted: false, reason: earlier.reason }
    let media = event.media.slice(0, c.maxMedia), quoted = [], quote
    if (event.replyTo && c.nativeQuote) {
      try {
        const data = await this.onebot.call('get_msg', { message_id: event.replyTo }, { signal, timeoutMs: 5000, maxBytes: 65536 })
        const knownEndpoint = await this.store.messageEndpoint(event.replyTo)
        quote = normalizeQuote(data, { endpoint: event.endpoint, messageId: event.replyTo, selfId: event.selfId, knownEndpoint, maxTextChars: c.quoteMaxChars, maxMedia: c.quoteMaxMedia })
        quoted = quote.media
      } catch { warnings.push('Quoted message unavailable or chat identity could not be verified') }
    }
    let agent, selection
    try { agent = this.modelPolicy?.liveAgent?.(binding.sessionId); selection = agent?.model?.current?.() } catch {}
    const admission = await this.admission.decide(event, binding, quote, selection, { busy: agent?.status === 'running' })
    if (!admission.admitted) return { admitted: false, reason: admission.reason }
    const peer = parseEndpoint(event.endpoint)
    if (peer.kind === 'private' && !event.senderNickname) {
      try {
        const profile = await this.onebot.call('get_stranger_info', { user_id: event.senderId }, { signal, timeoutMs: 3000, maxBytes: 16384 })
        event.senderNickname = typeof profile?.nickname === 'string' ? profile.nickname.slice(0, 120) : ''
      } catch { signal?.throwIfAborted() }
    }
    if (peer.kind === 'group') {
      if (!event.senderNickname || !event.senderCard || !event.senderTitle) {
        try {
          const member = await this.onebot.call('get_group_member_info', { group_id: peer.id, user_id: event.senderId }, { signal, timeoutMs: 3000, maxBytes: 16384 })
          event.senderNickname ||= typeof member?.nickname === 'string' ? member.nickname.slice(0, 120) : ''
          event.senderCard ||= typeof member?.card === 'string' ? member.card.slice(0, 120) : ''
          event.senderTitle ||= typeof member?.title === 'string' ? member.title.slice(0, 120) : ''
        } catch { signal?.throwIfAborted() }
      }
      event.senderName = event.senderCard || event.senderNickname || event.senderId
    }
    const text = [quote && quoteText(quote), event.text].filter(Boolean).join('\n\n')
    if (text) content.push({ type: 'text', text })
    if (event.truncated) content.push({ type: 'text', text: '\n[入站内容已按大小/段数上限截断]' })
    const rich = await this.rich.read(event.rich, { config: c, endpoint: event.endpoint, signal, mediaLimit: Math.max(0, c.maxMedia - media.length - quoted.length) })
    if (rich.text) content.push({ type: 'text', text: '\n' + rich.text })
    media = [...media, ...quoted, ...rich.media].slice(0, c.maxMedia)
    for (const [index, part] of media.entries()) {
      signal?.throwIfAborted()
      if (part.contextLabel) content.push({ type: 'text', text: `\n[${part.contextLabel}]` })
      try {
        if (part.type === 'record' && c.asr.enabled && this.asr) { content.push(...await this.asr.admit(part, { config: c, signal, bindingId: binding.id, externalMessageId: event.externalMessageId, index })); continue }
        if (typeof this.media.admit !== 'function') throw new Error('MEDIA_ADMISSION_UNAVAILABLE')
        const admitted = await this.media.admit(part, { signal, config: c, endpoint: event.endpoint, onebot: this.onebot })
        if (!admitted || !['text', 'image', 'file'].includes(admitted.type)) throw new Error('MEDIA_ADMISSION_FAILED')
        content.push(admitted)
      } catch { content.push({ type: 'text', text: `\n[${part.type} 附件未读取${part.name ? '：' + part.name : ''}；权限、大小或格式限制]` }) }
    }
    if (event.media.length + quoted.length > c.maxMedia) warnings.push('Media count limit reached')
    for (const warning of warnings.slice(0, 5)) content.push({ type: 'text', text: `\n[${warning}]` })
    if (!content.some(b => b.type !== 'text' || b.text.trim())) return { admitted: false, reason: 'EMPTY_MESSAGE' }
    const header = senderLine(event) + '\n\n'
    if (content[0]?.type === 'text') content[0] = { type: 'text', text: header + content[0].text }
    else content.unshift({ type: 'text', text: header })
    if (content.length > 24) content.splice(23, content.length - 23, { type: 'text', text: '\n[内容块上限，后续省略]' })
    let remaining = 32000
    for (const block of content) if (block.type === 'text') { if (block.text.length > remaining) { const note = '\n[总正文上限，后续省略]'; block.text = remaining >= note.length ? block.text.slice(0, remaining - note.length) + note : '' } remaining -= block.text.length }
    return { admitted: true, content }
  }
  _mergeContent(items) {
    const blocks = []
    let text = '', omitted = false
    const flush = () => { if (!text) return; if (blocks.length < 23) blocks.push({ type: 'text', text }); else omitted = true; text = '' }
    for (const item of items) {
      if (text) text += '\n\n'
      for (const block of item.content) {
        if (block.type === 'text') { text += block.text; continue }
        flush()
        if (blocks.length >= 23) { omitted = true; continue }
        blocks.push(block)
      }
    }
    flush()
    if (omitted) blocks.push({ type: 'text', text: '\n[合并内容块上限，部分内容省略]' })
    let remaining = 30000
    for (const block of blocks) if (block.type === 'text') {
      if (block.text.length > remaining) { const note = '\n[合并正文上限，后续省略]'; block.text = remaining >= note.length ? block.text.slice(0, remaining - note.length) + note : '' }
      remaining -= block.text.length
    }
    return blocks
  }
  async _ingest(events, binding, signal) {
    signal?.throwIfAborted?.()
    const items = [], filtered = []
    for (const event of events) {
      signal?.throwIfAborted?.()
      const seen = await this.store.ingressReceipt(binding.id, event.externalMessageId)
      if (seen && !this._canRetrySeen(seen)) continue
      const prepared = await this._prepare(event, binding, signal)
      if (prepared.admitted) { items.push({ event, content: prepared.content }); this.interruptTypingOnIncoming(binding, event.externalMessageId) }
      else filtered.push(prepared.reason)
    }
    if (!items.length) return filtered.length ? { ignored: true, filtered: true, reason: filtered[0], queued: false } : { ignored: true, duplicate: true, reason: 'NO_NEW_INPUT' }
    const externalMessageId = events.length === 1 && items.length === 1 ? items[0].event.externalMessageId : mergeId(binding.id, events)
    const content = items.length === 1 && events.length === 1 ? items[0].content : this._mergeContent(items)
    if (!content.some(block => block.type !== 'text' || block.text.trim())) return { ignored: true, reason: 'EMPTY_MESSAGE' }
    return this._dispatch(items, binding, signal, { externalMessageId, content, merged: events.length > 1 || items.length > 1 })
  }
  async _dispatch(items, binding, signal, prepared) {
    const merged = prepared?.merged === true
    let content = prepared?.content ?? items[0].content
    const externalMessageId = prepared?.externalMessageId ?? items[0].event.externalMessageId
    await this._prepareNativeFeatures(binding)
    await this.modelPolicy?.prepare(binding)
    await this.quotaPolicy?.beforeInput(binding, externalMessageId, signal)
    signal?.throwIfAborted()
    const current = this.config.bindings.find(row => row.id === binding.id)
    const origin = this.config.baseUrl
    if (!this.config.enabled || !current?.enabled) throw new Error('QQ binding disabled during reception')
    if (current.endpoint !== binding.endpoint || current.sessionId !== binding.sessionId) throw new Error('QQ binding changed during reception')
    const noticeTitle = 'QQ 撤回记录（外部资料）\n'
    const available = 32000 - noticeTitle.length - content.reduce((total, block) => total + (block.type === 'text' ? block.text.length : 0), 0)
    const [recentRecalls] = await Promise.all([this.store.recallsFor(binding.endpoint, 20, origin), this.qqStatus?.read(binding.endpoint, { signal })])
    const unseen = recentRecalls
      .filter(row => !row.shown && this._recallAllowed(row.endpoint, row.authorId, items[0].event.selfId)).slice(0, 4).reverse()
    const recalls = [], notices = []
    let used = 0
    for (const row of unseen) {
      const notice = recallText(row) + '\n\n'
      if (used + notice.length > available) break
      used += notice.length; notices.push(notice); recalls.push(row)
    }
    if (notices.length && content[0]?.type === 'text') content = [{ type: 'text', text: noticeTitle + notices.join('') + content[0].text }, ...content.slice(1)]
    else recalls.length = 0
    signal?.throwIfAborted()
    if (this.config.bindings.find(row => row.id === binding.id) !== current || !this.config.enabled) throw new Error('QQ binding changed during reception')
    if (this.quotaPolicy && binding.endpoint.startsWith('group:') && items.some(({ event }) => event.selfId && event.mentions?.includes(event.selfId))) {
      try { await this.store.recordGateResult(quotaTriggerKey(binding.id, externalMessageId), { reply: true, mentioned: true, reason: 'QUOTA_MENTION' }) }
      catch { this.report({ code: 'QUOTA_MENTION_RECORD_UNAVAILABLE', bindingId: binding.id }) }
    }
    const receipt = await this.io.receive({
      bindingId: binding.id, externalMessageId, content, mode: binding.mode, retryFailed: true,
      ...(!merged && items.length === 1 ? { senderId: items[0].event.senderId } : {}),
      ...(!merged && items.length === 1 && items[0].event.replyTo ? { replyTo: items[0].event.replyTo } : {}),
    })
    if (receipt?.state === 'failed') {
      this.report({ code: 'QQ_INGRESS_RETRY', bindingId: binding.id, reason: String(receipt.reason ?? 'ADMISSION_FAILED').slice(0, 80) })
      throw Object.assign(new Error('QQ ingress admission failed'), { code: 'QQ_BACKPRESSURE', retryAfterMs: 2000, reason: 'ADMISSION_FAILED' })
    }
    for (const item of items) {
      await this.store.recordIngressReceipt(binding.id, item.event.externalMessageId, receipt)
      await this.store.recordMessage(item.event.externalMessageId, item.event.endpoint, {
        senderId: item.event.senderId, senderName: item.event.senderCard || item.event.senderNickname || item.event.senderName, excerpt: recallExcerpt(item.event),
        origin, outbound: false,
        ...(recallTime(item.event.time) ? { time: recallTime(item.event.time) } : {}),
      })
    }
    if (receipt?.state === 'accepted' || receipt?.state === 'pending') for (const row of recalls) await this.store.showRecall(row)
    return receipt
  }
  async deliver(delivery, context = {}) {
    const key = context.idempotencyKey || delivery.deliveryId
    const signal = context.signal ? AbortSignal.any([context.signal, this.controller.signal]) : this.controller.signal
    return this._deliveryFlight(key, () => this.outbox.stage(delivery, { signal }))
  }
  async _deliveryFlight(key, execute) {
    const previous = this.deliveryFlights.get(key)
    if (previous) return previous
    const work = execute()
    this.deliveryFlights.set(key, work)
    try { return await work } finally { this.deliveryFlights.delete(key) }
  }
  async sendQuotaNotice({ bindingId, externalMessageId }) {
    const binding = this.config.bindings.find(row => row.id === bindingId)
    if (!binding || !this.config.quotaReply.trim()) return
    if (binding.endpoint.startsWith('group:')) {
      const key = quotaTriggerKey(bindingId, externalMessageId)
      const addressed = await this.store.gateResult(key) ?? await this.store.admissionResult(key)
      if (!addressed?.mentioned) return
    }
    const hex = createHash('sha256').update(JSON.stringify([bindingId, externalMessageId])).digest('hex')
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    return this._sendSystemText({ bindingId, endpoint: binding.endpoint, text: this.config.quotaReply, requestId }, 'quota-notice:')
  }
  async sendTest(request) { return this._sendSystemText(request, 'test-send:') }
  async _sendSystemText({ bindingId, endpoint, text, requestId }, namespace) {
    if (typeof bindingId !== 'string' || typeof text !== 'string' || !text.trim() || text.length > 500 ||
        receiveCode.test(text.trim()) || typeof requestId !== 'string' || !sendRequestId.test(requestId)) {
      return { state: 'failed', reason: 'INVALID_TEST_MESSAGE' }
    }
    const key = namespace + JSON.stringify([bindingId, requestId])
    return this._deliveryFlight(key, async () => {
      const binding = this.config.bindings.find(row => row.id === bindingId)
      if (!binding || binding.endpoint !== endpoint) return { state: 'failed', reason: 'TEST_TARGET_CHANGED' }
      const permitted = () => {
        const current = this.config.bindings.find(row => row.id === bindingId)
        return !this.closed && this.config.enabled && this.config.sendEnabled && current?.enabled &&
          current.sendEnabled && current.endpoint === endpoint
      }
      if (!permitted()) return { state: 'failed', reason: 'QQ_SEND_DISABLED' }
      const previous = await this.store.delivery(key)
      if (previous?.state === 'delivered') return { state: 'delivered', externalMessageId: previous.externalMessageId }
      if (previous?.state === 'failed') return { state: 'failed', reason: previous.reason }
      if (previous) return { state: 'unknown', reason: 'DELIVERY_ALREADY_ATTEMPTED' }
      const origin = this.config.baseUrl, signal = this.controller.signal
      const blocked = await this.checkSendStatus(endpoint, signal)
      if (blocked) {
        const receipt = { state: 'failed', reason: blocked }
        await this.store.recordDelivery(key, receipt)
        return receipt
      }
      const plan = await planOutbound([{ type: 'text', text: text.trim() }], { endpoint: binding.endpoint })
      const message = withGroupMentions(plan.message)
      await this.store.recordDelivery(key, { state: 'sending' })
      try {
        const beforeSend = () => {
          if (!permitted() || origin !== this.config.baseUrl) throw new OneBotError('QQ_SEND_DISABLED', 'failed')
          if (!this.networkEnabled()) throw new OneBotError('NETWORK_ACCESS_DISABLED', 'failed')
          this.assertSendStatus(endpoint)
        }
        beforeSend()
        const answer = await this.onebot.call(message.action, message.params, { signal, timeoutMs: 10000, beforeSend })
        const id = answer?.message_id ?? answer?.messageId
        const receipt = { state: 'delivered', ...(id === undefined ? {} : { externalMessageId: String(id) }) }
        await this.store.recordDelivery(key, receipt)
        return receipt
      } catch (error) {
        const receipt = { state: error?.deliveryState === 'failed' ? 'failed' : 'unknown', reason: await this.sendFailureReason(error, endpoint, signal) }
        try { await this.store.recordDelivery(key, receipt) } catch { this.report({ code: 'TEST_RECEIPT_UNCONFIRMED', bindingId }) }
        return receipt
      }
    })
  }
  async _deliver(delivery, { signal, idempotencyKey, bufferCommit = false, onSendStart, onBeforeAction, onImmediateSend, onTypingComplete, onTypingInput } = {}) {
    const explicit = delivery.intent === 'explicit' || bufferCommit
    const c = this.config, binding = bufferCommit ? this.outbox.target(delivery.bindingId) : this.sendTarget(delivery.bindingId, explicit)
    if (!binding) return { state: 'failed', reason: 'QQ_SEND_DISABLED' }
    if (!this.networkEnabled()) return { state: 'failed', reason: 'NETWORK_ACCESS_DISABLED' }
    const originSessionId = delivery.reply?.sessionId
    if (delivery.endpoint !== binding.endpoint || !originSessionId || (!explicit && originSessionId !== binding.sessionId) || delivery.reply?.source?.kind !== 'model') return { state: 'failed', reason: 'DELIVERY_IDENTITY_MISMATCH' }
    parseEndpoint(delivery.endpoint)
    if (!explicit && this.nativeFeatures && !await this.nativeFeatures.allowDelivery(binding, delivery.reply)) return { state: 'failed', reason: 'QQ_REPLY_GATE_SUPPRESSED' }
    const previous = await this.store.delivery(idempotencyKey || delivery.deliveryId)
    if (previous?.state === 'delivered') return { state: 'delivered', externalMessageId: previous.externalMessageId }
    if (previous) return { state: 'unknown', reason: 'DELIVERY_ALREADY_ATTEMPTED' }
    const blocked = await this.checkSendStatus(binding.endpoint, signal)
    if (blocked) return { state: 'failed', reason: blocked }
    const mediaContext = { signal, config: c, sessionId: originSessionId }
    const { content, memeFiles, mediaError } = await prepareOutboundContent(delivery.reply.content, {
      maxMedia: c.maxMedia, signal,
      resolveResource: this.media.resolveOutbound && (resource => this.media.resolveOutbound(resource, mediaContext)),
      resolveMeme: this.media.exportMeme && (caption => this.media.exportMeme(caption, mediaContext)),
      onMemeUnavailable: () => this.report({ code: 'QQ_MEME_UNAVAILABLE', bindingId: binding.id }),
    })
    if (bufferCommit && mediaError) return { state: 'failed', reason: 'QQ_MEDIA_UNAVAILABLE' }
    const plan = await planOutbound(content, {
      endpoint: binding.endpoint, replyTo: c.nativeQuote ? delivery.replyTo : undefined,
      allowGroupFiles: c.allowGroupFiles,
      exportMedia: this.media.export && (block => this.media.export(block, mediaContext)),
      memeFiles,
    })
    if (bufferCommit && plan.warnings.some(warning => warning.startsWith('附件未发送：'))) return { state: 'failed', reason: 'QQ_ATTACHMENT_UNAVAILABLE', detail: plan.warnings }
    const withMentions = withGroupMentions(plan.message)
    const mixed = withMentions?.params.message.some(part => part.type !== 'text' && part.type !== 'reply')
    const voiceConfig = plan.extras.length || mixed ? undefined : c.voice
    const messages = []
    for (const part of splitChatMessages(withMentions)) {
      const voiced = await planVoice(part, voiceConfig, this.synthesize && ((text, options) => this.synthesize(text, options, { signal })))
      messages.push(...voiced.messages)
    }
    const actions = [...messages, ...plan.extras, ...plan.memeMessages]
    if (!actions.length) return { state: 'failed', reason: 'NO_PUBLIC_CONTENT' }
    if (signal?.aborted) return { state: 'failed', reason: 'ABORTED_BEFORE_SEND' }
    const key = idempotencyKey || delivery.deliveryId
    const ids = []
    let completed = 0, started = false
    const beforeSend = () => {
      signal?.throwIfAborted()
      const current = bufferCommit ? this.outbox.target(delivery.bindingId) : this.sendTarget(delivery.bindingId, explicit)
      if (!current || current.endpoint !== binding.endpoint || current.sessionId !== binding.sessionId || this.config.baseUrl !== c.baseUrl || !this.networkEnabled()) {
        throw new OneBotError(this.networkEnabled() ? 'QQ_SEND_DISABLED' : 'NETWORK_ACCESS_DISABLED', 'failed')
      }
      this.assertSendStatus(binding.endpoint)
    }
    const waitForTyping = async duration => {
      const activity = { state: 'typing', id: delivery.deliveryId, startedAt: Date.now(), durationMs: duration, deliveredParts: completed, canCancel: true }
      const controller = new AbortController(), typingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      this.typingActivities.set(binding.id, activity)
      this.typingControllers.set(binding.id, { id: delivery.deliveryId, controller, onIncoming: onTypingInput })
      try {
        const endpoint = parseEndpoint(binding.endpoint)
        if (endpoint.kind === 'private') {
          try { await this.onebot.call('set_input_status', { user_id: endpoint.id, event_type: 1 }, { signal: typingSignal, timeoutMs: 1500 }) }
          catch { /* Input-status signaling is optional; keep the chosen send. */ }
        }
        typingSignal.throwIfAborted()
        await this.typingWait(duration, typingSignal)
        typingSignal.throwIfAborted()
      } catch (error) { throw controller.signal.aborted ? controller.signal.reason : error }
      finally {
        if (this.typingActivities.get(binding.id) === activity) this.typingActivities.delete(binding.id)
        if (this.typingControllers.get(binding.id)?.controller === controller) this.typingControllers.delete(binding.id)
      }
    }
    try {
      if (onTypingComplete) {
        const parts = actions.flatMap(action => Array.isArray(action.params?.message) ? action.params.message : typeof action.params?.message === 'string' ? [action.params.message] : [])
        const duration = estimateTypingMs(parts, resolveTypingOptions(c.typing, delivery.typing))
        if (duration > 0) {
          beforeSend()
          await waitForTyping(duration)
          beforeSend()
          await onTypingComplete({ completed, sentIds: [...ids], durationMs: duration })
        }
      }
      for (const action of actions) {
        beforeSend()
        const duration = onTypingComplete ? 0 : estimateTypingMs(action.params?.message ?? [], resolveTypingOptions(c.typing, delivery.typing))
        if (duration > 0) {
          await waitForTyping(duration)
          beforeSend()
        }
        await onBeforeAction?.({ completed, sentIds: [...ids] })
        beforeSend()
        if (!started) {
          await onSendStart?.()
          await this.store.recordDelivery(key, { state: 'sending' })
          started = true
        }
        // Failure after any completed action is ambiguous as a combined delivery: never replay it.
        const finalCheck = () => { beforeSend(); onImmediateSend?.() }
        finalCheck()
        const result = await this.onebot.call(action.action, action.params, { signal, timeoutMs: 60000, beforeSend: finalCheck })
        completed++
        const mid = result?.message_id ?? result?.messageId ?? result?.file_id
        if (mid !== undefined) {
          ids.push(String(mid))
          const parts = normalizeSegments(action.params.message, { maxTextChars: 320, maxSegments: 24 })
          const excerpt = recallExcerpt(parts) || (result?.file_id !== undefined ? '[文件]' : '')
          await this.store.recordMessage(String(mid), binding.endpoint, { outbound: true, excerpt, time: Date.now(), origin: c.baseUrl, originSessionId })
        }
      }
      // Upload-only OneBot APIs often return no message id. deliveryId is a truthful synthetic receipt, not a QQ quote target.
      const externalMessageId = ids.join(',') || `upload:${delivery.deliveryId}`
      await this.store.recordDelivery(key, { state: 'delivered', externalMessageId, parts: ids })
      if (!binding.outboundOnly) {
        try { await this.admission.delivered(binding.id) } catch { this.report({ code: 'COOLDOWN_SIDECAR_UNCONFIRMED', bindingId: binding.id }) }
      }
      return { state: 'delivered', externalMessageId }
    } catch (error) {
      const state = completed === 0 && (!started || error?.deliveryState === 'failed') ? 'failed' : 'unknown'
      const reason = await this.sendFailureReason(error, binding.endpoint, signal)
      if (started || !['QQ_CONTEXT_CHANGED_DURING_TYPING', 'QQ_TYPING_CONFIRM_REQUIRED'].includes(reason)) await this.store.recordDelivery(key, { state, reason })
      return { state, reason, ...(['QQ_CONTEXT_CHANGED_DURING_TYPING', 'QQ_TYPING_CONFIRM_REQUIRED'].includes(error?.code) ? { ...(error.context ? { context: error.context } : {}), deliveredParts: completed, sentMessageIds: ids } : {}) }
    }
  }
  async probe(binding, { signal } = {}) {
    const current = this.sendTarget(binding.id, true)
    if (!this.networkEnabled() || !current || current.endpoint !== binding.endpoint || current.sessionId !== binding.sessionId) return { available: false }
    try {
      if (this.qqStatus) {
        const status = await this.qqStatus.read(current.endpoint, { signal })
        return { available: !!status.account.id && status.canSend !== false }
      }
      const account = await this.onebot.call('get_login_info', {}, { signal, timeoutMs: 5000, maxBytes: 16384 })
      return { available: !!account?.user_id }
    } catch {
      signal?.throwIfAborted()
      return { available: false }
    }
  }
  async cancel(bindingId) { await this.modelPolicy?.cancel(bindingId); await this.quotaPolicy?.cancel(bindingId); return this.io.cancel(bindingId, { keepInbox: false }) }
  async dispose() {
    if (this.closed) return
    this.closed = true; this.controller.abort(); this.off?.()
    await this.settingsTail
    await this.merger?.dispose()
    await this.modelPolicy?.dispose()
    await this.quotaPolicy?.dispose()
    await this.nativeFeatures?.dispose()
    this.rich.dispose()
    await this.asr?.dispose()
    await Promise.allSettled([...this.flights.values(), ...this.deliveryFlights.values()])
  }
}
