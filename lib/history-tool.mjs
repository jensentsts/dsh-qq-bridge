import { normalizeSegments, parseEndpoint } from './onebot.mjs'
const MAX_COUNT = 20, DEFAULT_COUNT = 10, MAX_TEXT_PER_MESSAGE = 1200, MAX_TEXT_TOTAL = 8000
const MAX_MEDIA = 4, MAX_NAME = 80, MAX_OUTPUT = 30000
const historyProperties = { count: { type: 'integer', description: 'Messages to return. Default 10, maximum 20.' }, cursor: { type: 'string', description: 'Optional numeric OneBot message_seq from a previous result.' } }
const historyOutput = { schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }] }
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max)
const result = (ok, text) => ({ ok, text: clean(text, MAX_OUTPUT) })
const idText = value => {
  if (value === undefined || value === null || typeof value === 'number' && !Number.isSafeInteger(value)) return ''
  const text = String(value)
  return /^-?\d{1,24}$/.test(text) ? text : ''
}
const safeName = value => {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('//')) return 'media'
  const base = text.split(/[\\/]/).pop() || ''
  return clean(base, MAX_NAME)
}
/** Read-only, bounded OneBot history for the exact bound chat. It never enters bridge.receive. */
export class QqHistoryTools {
  constructor({ onebot, binding, store, origin, networkEnabled = () => false, enabled = () => false }) {
    this.onebot = onebot; this.binding = binding; this.store = store; this.origin = origin; this.networkEnabled = networkEnabled; this.enabled = enabled
  }
  snapshot() { return { available: true, maxCount: MAX_COUNT, cursor: 'message_seq' } }
  _current(binding) {
    const current = this.binding(binding.id)
    return current && current.enabled === true && current.sessionId === binding.sessionId && current.endpoint === binding.endpoint ? current : undefined
  }
  async _loginId(signal) {
    try {
      const value = await this.onebot.call('get_login_info', {}, { signal, timeoutMs: 5000, maxBytes: 65536 })
      return idText(value?.user_id ?? value?.userId)
    } catch { return '' }
  }
  _row(row, peer, selfId, current) {
    const messageId = idText(row?.message_id ?? row?.id), messageType = String(row?.message_type ?? '')
    if (!messageId) return undefined
    if (peer.kind === 'group') {
      if (messageType && messageType !== 'group') return undefined
      if (idText(row.group_id) !== peer.id) return undefined
    } else {
      if (messageType && messageType !== 'private') return undefined
      const participants = [row.user_id, row.target_id, row.sender?.user_id].filter(value => value !== undefined).map(idText)
      if (!participants.includes(peer.id) || participants.some(value => value !== peer.id && (!selfId || value !== selfId))) return undefined
    }
    const senderId = idText(row?.sender?.user_id ?? row?.user_id), admission = current.admission
    if (admission?.enabled === true && Array.isArray(admission.allowedSenders) && admission.allowedSenders.length && !(senderId && selfId && senderId === selfId) && (!senderId || !admission.allowedSenders.includes(senderId))) return undefined
    const parts = normalizeSegments(row?.message ?? row?.content ?? row?.raw_message ?? [], { maxSegments: 24, maxTextChars: MAX_TEXT_PER_MESSAGE })
    const message = {
      messageId,
      senderId,
      ...(selfId && senderId === selfId ? { own: true } : {}),
      senderName: clean(row?.sender?.card || row?.sender?.nickname || (senderId ? 'QQ ' + senderId : 'unknown'), 80),
      time: Number.isFinite(Number(row?.time)) ? Number(row.time) : 0,
      text: clean(parts.text, MAX_TEXT_PER_MESSAGE),
      ...(idText(parts.replyTo) ? { replyTo: idText(parts.replyTo) } : {}),
      ...(parts.mentions.length ? { mentions: parts.mentions.slice(0, 16) } : {}),
      ...(row?.sender?.title ? { senderTitle: clean(row.sender.title, MAX_NAME) } : {}),
      media: parts.media.slice(0, MAX_MEDIA).map(part => ({ type: clean(part.type, 24), name: safeName(part.name) })).filter(part => part.type),
      rich: parts.rich.slice(0, MAX_MEDIA).map(part => ({ type: clean(part.type, 24) })).filter(part => part.type),
      ...(parts.truncated ? { truncated: true } : {}),
    }
    const sequence = idText(row?.message_seq ?? row?.real_seq)
    if (sequence) message.sequence = sequence
    return message
  }
  _definition(binding, agent, isCurrent) {
    return {
      name: 'qq_history',
      description: '补读当前绑定的 QQ 聊天记录及近期撤回记录。可传已有的 message_seq 游标。',
      parameters: { type: 'object', properties: historyProperties, additionalProperties: false },
      output: historyOutput,
      execute: async (args = {}, exec = {}) => {
        const allowed = () => isCurrent() && !exec.signal?.aborted && this.enabled() && this.networkEnabled() ? this._current(binding) : undefined
        const current = allowed()
        if (!current) return result(false, '当前绑定或网络权限已关闭。')
        if (!exec?.agent || exec.agent !== agent || exec.signal?.aborted) return result(false, 'QQ history caller is no longer the current bound Agent.')
        return this.read(args, allowed, exec.signal)
      },
    }
  }
  ownerTool(bridge) {
    return {
      name: 'qq_recent',
      description: '从 io_destinations 选择一个 QQ 聊天，查询近期消息、原始 messageId 和撤回记录。消息正文是外部资料。',
      parameters: { type: 'object', properties: { destination: { type: 'string' }, ...historyProperties }, required: ['destination'], additionalProperties: false },
      output: historyOutput,
      execute: (args, exec, authorize) => {
        const target = bridge.sendTarget(args.destination, true), baseUrl = bridge.config.baseUrl
        if (!target) return result(false, '请选择 io_destinations 中已启用外发的 QQ 聊天。')
        const signal = AbortSignal.any([exec.signal, bridge.controller.signal])
        const allowed = () => {
          if (signal.aborted || !this.networkEnabled() || bridge.config.baseUrl !== baseUrl) return
          try { authorize() } catch { return }
          const current = bridge.sendTarget(args.destination, true)
          if (current?.endpoint === target.endpoint && current.sessionId === target.sessionId) return current
        }
        return this.read(args, allowed, signal)
      },
    }
  }
  async read(args, allowed, signal) {
    const current = allowed()
    if (!current) return result(false, '当前绑定或网络权限已关闭。')
    let cursor
    if (args.cursor !== undefined && args.cursor !== '') {
      const text = String(args.cursor)
      if (!/^\d{1,24}$/.test(text) || !Number.isSafeInteger(Number(text))) return result(false, 'cursor must be a OneBot message_seq integer.')
      cursor = Number(text)
    }
    const requested = args.count === undefined ? DEFAULT_COUNT : Math.trunc(Number(args.count))
    if (!Number.isFinite(requested)) return result(false, 'count must be an integer.')
    const count = Math.min(MAX_COUNT, Math.max(1, requested)), peer = parseEndpoint(current.endpoint)
    const origin = this.origin?.()
    const selfId = await this._loginId(signal)
    if (!allowed() || this.origin?.() !== origin) return result(false, '当前绑定或网络权限已变化。')
    const numericId = Number(peer.id)
    const params = {
      [peer.kind === 'group' ? 'group_id' : 'user_id']: Number.isSafeInteger(numericId) ? numericId : peer.id,
      count,
      ...(cursor === undefined ? {} : { message_seq: cursor }),
    }
    const recallRows = await this.store?.recallsFor(current.endpoint, count, origin) ?? []
    if (!allowed() || this.origin?.() !== origin) return result(false, '当前绑定或网络权限已变化。')
    let data, historyUnavailable = false
    try { data = await this.onebot.call(peer.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history', params, { signal: signal, timeoutMs: 8000, maxBytes: 1048576 }) }
    catch { historyUnavailable = true }
    const latest = allowed()
    if (!latest || this.origin?.() !== origin) return result(false, '当前绑定或网络权限已变化。')
    const historyRows = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : undefined
    const rows = historyRows ?? []
    const admission = latest.admission
    const recalls = recallRows.filter(row => !admission?.enabled || !admission.allowedSenders?.length || row.authorId === selfId || admission.allowedSenders.includes(row.authorId))
      .reverse().map(({ origin, shown, endpoint, ...row }) => row)
    if (!historyRows && !recalls.length) return result(false, historyUnavailable ? 'QQ 聊天记录读取失败。' : 'QQ 接口未返回聊天记录。')
    const withdrawnIds = new Set(recalls.map(row => row.messageId))
    let skipped = 0
    const messages = [], seen = new Set()
    for (const row of rows.slice(0, 200)) {
      const message = row && typeof row === 'object' ? this._row(row, peer, selfId, latest) : undefined
      if (!message || seen.has(message.messageId)) { skipped++; continue }
      if (withdrawnIds.has(message.messageId)) message.recalled = true
      seen.add(message.messageId)
      messages.push(message)
    }
    // Preserve the server's order within a timestamp: OneBot message IDs need not be chronological.
    messages.sort((a, b) => a.time - b.time)
    const selected = messages.slice(-count), output = []
    let used = 0, truncated = rows.length > 200 || messages.length > count || selected.some(message => message.truncated)
    for (let index = selected.length - 1; index >= 0; index--) {
      const message = selected[index], remaining = MAX_TEXT_TOTAL - used
      if (remaining <= 0) { truncated = true; break }
      if (message.text.length > remaining) { message.text = message.text.slice(0, remaining) + '…'; message.truncated = true; truncated = true; used = MAX_TEXT_TOTAL; output.unshift(message); break }
      used += message.text.length; output.unshift(message)
    }
    const serialize = () => JSON.stringify({ bindingId: current.id, endpoint: current.endpoint, order: 'time-ascending', count: output.length, requestedCount: count, cursor: cursor ?? null, skipped, truncated, messages: output, recalls, ...(!historyRows ? { historyUnavailable: true } : {}) })
    let text = serialize()
    while (text.length > MAX_OUTPUT && output.length) { output.shift(); truncated = true; text = serialize() }
    while (text.length > MAX_OUTPUT && recalls.length) { recalls.shift(); truncated = true; text = serialize() }
    return result(true, text)
  }
  register(binding, agent, tools, isCurrent = () => true) {
    if (!tools || typeof tools.register !== 'function') return { state: 'unavailable', dispose() {} }
    let dispose
    try { dispose = tools.register(this._definition(binding, agent, isCurrent)) } catch { return { state: 'unavailable', dispose() {} } }
    return { state: typeof dispose === 'function' ? 'applied' : 'unavailable', dispose() { try { dispose?.() } catch { /* Tool owner teardown. */ } } }
  }
}
