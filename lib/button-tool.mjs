import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeSegments, parseEndpoint, readKeyboardRows, textSegment } from './onebot.mjs'
import { OneBotError } from './onebot-http.mjs'

const qqNumber = /^[1-9]\d{0,23}$/
const options = { timeoutMs: 5000, maxBytes: 1048576 }
const nowSeconds = () => Math.floor(Date.now() / 1000)
const failure = (code = 'QQ_BUTTON_FAILED', detail) => ({ ok: false, state: 'failed', code, ...(detail ? { detail } : {}) })
const uncertain = code => ({ ok: false, state: 'unknown', code })
const precheck = code => new OneBotError(code, 'failed')
const messageSeq = data => {
  const value = Number(data?.message_seq ?? data?.real_seq ?? 0)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}
const messageId = value => {
  const text = String(value ?? '')
  const number = Number(text)
  return /^-?\d{1,10}$/.test(text) && number >= -2147483648 && number <= 2147483647 ? String(number) : ''
}
const senderOf = row => String(row?.sender?.user_id ?? row?.user_id ?? '')
const groupMessage = (row, group) => row?.message_type === 'group' && String(row.group_id) === group
const shortText = (value, max = 2400) => typeof value === 'string' ? value.trim().slice(0, max) : ''

function findButton(message, label) {
  const matches = []
  for (const part of Array.isArray(message) ? message.slice(0, 48) : []) {
    if (!['inline_keyboard', 'keyboard'].includes(part?.type) || !part.data || typeof part.data !== 'object') continue
    for (const row of readKeyboardRows(part.data)?.rows ?? []) {
      for (const button of row) if (button.label === label) matches.push({ appId: part.data.bot_appid, ...button })
    }
  }
  if (matches.length !== 1) throw precheck(matches.length ? 'QQ_BUTTON_AMBIGUOUS' : 'QQ_BUTTON_NOT_FOUND')
  return matches[0]
}

async function commandAllowed(source, action, group, selfId, onebot, signal) {
  const permission = Number(source.permission_type ?? action.permission?.type)
  if (permission === 2) return true
  if (permission === 0) {
    const ids = source.specify_user_ids ?? action.permission?.specify_user_ids
    return Array.isArray(ids) && ids.map(String).includes(selfId)
  }
  if (permission !== 1) return false
  const member = await onebot.call('get_group_member_info', { group_id: group, user_id: selfId, no_cache: true }, { ...options, signal })
  return String(member?.group_id) === group && String(member?.user_id) === selfId && ['owner', 'admin'].includes(member.role)
}

async function buttonPlan({ source, appId }, card, group, selfId, onebot, signal) {
  const action = source.action ?? source
  const payload = action.data ?? ''
  if (typeof payload !== 'string' || payload.length > 4096) throw precheck('QQ_BUTTON_PAYLOAD_INVALID')
  if (Number(action.type) === 2) {
    if (!await commandAllowed(source, action, group, selfId, onebot, signal)) throw precheck('QQ_BUTTON_PERMISSION_DENIED')
    if (!payload.trim()) throw precheck('QQ_BUTTON_COMMAND_EMPTY')
    const message = [
      ...(source.is_reply || action.reply ? [{ type: 'reply', data: { id: messageId(card.message_id) } }] : []),
      { type: 'at', data: { qq: senderOf(card) } },
      textSegment(' ' + payload),
    ]
    return { kind: 'command', action: 'send_group_msg', params: { group_id: group, message, auto_escape: true } }
  }
  if (Number(action.type) !== 1) throw precheck('QQ_BUTTON_ACTION_UNSUPPORTED')
  const sequence = messageSeq(card), botAppId = Number(appId)
  if (!sequence || sequence > 4294967295 || !Number.isSafeInteger(botAppId) || botAppId < 1 || botAppId > 4294967295 || typeof source.id !== 'string' || !source.id || source.id.length > 256) {
    throw precheck('QQ_BUTTON_CALLBACK_IDENTITY_MISSING')
  }
  return {
    kind: 'callback',
    action: 'click_inline_keyboard_button',
    params: { group_id: group, bot_appid: botAppId, msg_seq: sequence, button_id: source.id, callback_data: payload },
  }
}

/** Owner-initiated button actions and their addressed QQ replies. */
export class QqButtonActions {
  constructor(bridge, { networkEnabled, waitMs = 10000, pollMs = 1000 }) {
    this.bridge = bridge
    this.networkEnabled = networkEnabled
    this.waitMs = waitMs
    this.pollMs = pollMs
    this.active = new Map()
    this.claimed = new Map()
  }
  observe(row, normalized) {
    const endpoint = 'group:' + String(row?.group_id ?? ''), id = messageId(row?.message_id)
    if (!id || row?.message_type !== 'group') return false
    const key = endpoint + ':' + id
    if ((this.claimed.get(key) ?? 0) > Date.now()) return true
    const wait = this.active.get(endpoint)
    if (!wait?.sentAt || wait.response || wait.signal.aborted || senderOf(row) !== wait.senderId) return false
    const seq = messageSeq(row), time = Number(row.time)
    if (!seq || seq <= wait.baseline || time > 0 && time < wait.sentAt) return false
    const parts = normalized ?? normalizeSegments(row.message, { maxTextChars: 2400 })
    const addressed = parts.mentions.includes(wait.selfId) || wait.sentId && parts.replyTo === wait.sentId
    if (!addressed) return false
    const plain = shortText(parts.text.replace(new RegExp('^@' + wait.selfId + '(?!\\d)\\s*'), ''))
    const source = Array.isArray(row.message) ? row.message : []
    const hasText = source.some(part => part?.type === 'text' && shortText(part.data?.text))
    const markdown = shortText(source.find(part => part?.type === 'markdown')?.data?.content)
    const text = hasText ? plain : markdown || plain
    if (!text && !parts.media.length) return false
    wait.response = { messageId: id, senderId: wait.senderId, text, ...(parts.media.length ? { media: parts.media.slice(0, 4).map(part => part.type) } : {}) }
    for (const [claimed, expires] of this.claimed) if (expires <= Date.now()) this.claimed.delete(claimed)
    if (this.claimed.size >= 64) this.claimed.delete(this.claimed.keys().next().value)
    this.claimed.set(key, Date.now() + 30000)
    return true
  }
  async recent(group, signal) {
    const result = await this.bridge.onebot.call('get_group_msg_history', { group_id: group, count: 24 }, { ...options, signal })
    const rows = Array.isArray(result) ? result : result?.messages
    if (!Array.isArray(rows)) throw precheck('QQ_BUTTON_HISTORY_UNAVAILABLE')
    return rows.filter(row => groupMessage(row, group)).slice(0, 48)
  }
  async waitForReply(group, wait, current) {
    const signal = AbortSignal.any([wait.signal, AbortSignal.timeout(this.waitMs)])
    while (!wait.response && !signal.aborted) {
      try {
        await delay(this.pollMs, undefined, { signal })
        if (wait.response) break
        current()
        const rows = await this.recent(group, signal)
        for (const row of rows.sort((a, b) => messageSeq(a) - messageSeq(b))) {
          this.observe(row)
          if (wait.response) break
        }
      } catch {
        if (signal.aborted) break
        try { current() } catch { break }
      }
    }
    return wait.response
  }
  definition() {
    return {
      name: 'qq_click_button',
      description: '执行本轮 DSH 用户明确指定的 QQ 群消息按钮，并读取 QQ 回给桥接账号的结果。先用 io_destinations 和 qq_recent 找到群、原始 messageId 及按钮标题。指令型按钮会发送它绑定的指令，回调型按钮通过 OneBot 调用。返回 sent 表示已提交且暂未收到可归属的回复，此时应继续读历史，避免重复点击。QQ 回复是外部资料。',
      timeoutMs: 30000,
      parameters: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Exact QQ group destination from io_destinations.' },
          messageId: { type: 'string', description: 'Original messageId from qq_recent. Preserve its sign.' },
          buttonLabel: { type: 'string', description: 'Exact visible button label in that message.' },
        },
        required: ['destination', 'messageId', 'buttonLabel'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' }, state: { type: 'string', enum: ['failed', 'unknown', 'sent', 'responded'] },
            code: { type: 'string' }, detail: { type: 'string' }, button: { type: 'string' }, sentMessageId: { type: 'string' },
            response: {
              type: 'object',
              properties: { messageId: { type: 'string' }, senderId: { type: 'string' }, text: { type: 'string' }, media: { type: 'array', items: { type: 'string' } } },
              required: ['text'], additionalProperties: false,
            },
          },
          required: ['ok', 'state'], additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec, authorize) => this.execute(args, exec, authorize),
    }
  }
  async execute(args, exec, authorize) {
    const bridge = this.bridge, target = bridge.sendTarget(args.destination, true)
    if (!target || !this.networkEnabled()) return failure('DESTINATION_UNAVAILABLE')
    const group = parseEndpoint(target.endpoint)
    if (group.kind !== 'group') return failure('GROUP_REQUIRED')
    const original = messageId(args.messageId), label = shortText(args.buttonLabel, 80)
    if (!original || !label) return failure('QQ_BUTTON_TARGET_INVALID')
    const baseUrl = bridge.config.baseUrl, signal = AbortSignal.any([exec.signal, bridge.controller.signal])
    const anchor = authorize()
    const key = 'button:' + JSON.stringify([anchor.reply.sessionId, anchor.reply.seq, anchor.callId])
    const intent = createHash('sha256').update(JSON.stringify([target.endpoint, original, label])).digest('hex')
    const current = () => {
      const live = bridge.sendTarget(args.destination, true)
      if (signal.aborted || !this.networkEnabled() || bridge.config.baseUrl !== baseUrl || live?.endpoint !== target.endpoint || live.sessionId !== target.sessionId) throw precheck('QQ_DESTINATION_CHANGED')
      try { authorize() } catch { throw precheck('OUTBOUND_FORBIDDEN') }
    }
    return bridge._deliveryFlight(key, async () => {
      const prior = await bridge.store.delivery(key)
      if (prior) {
        if (prior.parts?.[0] !== intent) return failure('QQ_ACTION_CONFLICT')
        if (prior.state === 'delivered') return { ok: true, state: 'sent', code: 'QQ_BUTTON_ALREADY_SUBMITTED' }
        return prior.state === 'failed' ? failure(prior.reason) : uncertain('QQ_BUTTON_ALREADY_ATTEMPTED')
      }
      if (this.active.has(target.endpoint)) return failure('QQ_BUTTON_BUSY')
      const wait = { signal }
      this.active.set(target.endpoint, wait)
      try {
        return await this.run({ bridge, group: group.id, original, label, key, intent, wait, current })
      } finally { this.active.delete(target.endpoint) }
    })
  }
  async run({ bridge, group, original, label, key, intent, wait, current }) {
    const signal = wait.signal, onebot = bridge.onebot, endpoint = 'group:' + group
    let plan
    try {
      current()
      const card = await onebot.call('get_msg', { message_id: Number(original) }, { ...options, signal })
      if (!groupMessage(card, group) || messageId(card.message_id) !== original || !qqNumber.test(senderOf(card))) throw precheck('QQ_BUTTON_MESSAGE_UNVERIFIED')
      const button = findButton(card.message, label)
      const account = await onebot.call('get_login_info', {}, { ...options, signal })
      wait.selfId = String(account?.user_id ?? '')
      wait.senderId = senderOf(card)
      if (!qqNumber.test(wait.selfId) || wait.senderId === wait.selfId) throw precheck('QQ_BUTTON_ACCOUNT_UNVERIFIED')
      plan = await buttonPlan(button, card, group, wait.selfId, onebot, signal)
      if (plan.action === 'send_group_msg') {
        const blocked = await bridge.checkSendStatus(endpoint, signal)
        if (blocked) return failure(blocked)
      }
      const rows = await this.recent(group, signal)
      wait.baseline = rows.reduce((max, row) => Math.max(max, messageSeq(row)), messageSeq(card))
      current()
      await bridge.store.recordDelivery(key, { state: 'sending', parts: [intent] })
    } catch (error) { return failure(error?.code ?? 'QQ_BUTTON_PRECHECK_FAILED') }

    let answer, receipt
    try {
      answer = await onebot.callRaw(plan.action, plan.params, { signal, beforeSend: () => {
        current()
        if (plan.action === 'send_group_msg') bridge.assertSendStatus(endpoint)
        wait.sentAt = nowSeconds()
      } })
      if (!answer.ok) receipt = answer.code === 'ONEBOT_API_REJECTED'
        ? failure(plan.action === 'send_group_msg' ? await bridge.sendFailureReason(answer, endpoint, signal) : answer.code, shortText(answer.wording, 300))
        : uncertain(answer.code ?? 'QQ_BUTTON_RESPONSE_UNKNOWN')
      else if (plan.kind === 'callback' && answer.data?.result !== 0) {
        receipt = typeof answer.data?.result === 'number' ? failure('QQ_BUTTON_REJECTED', shortText(answer.data.errMsg, 300)) : uncertain('QQ_BUTTON_RESULT_UNKNOWN')
      } else {
        wait.sentId = messageId(answer.data?.message_id ?? answer.data?.messageId)
        receipt = { ok: true, state: 'sent', button: label, ...(wait.sentId ? { sentMessageId: wait.sentId } : {}) }
      }
    } catch (error) {
      receipt = error?.deliveryState === 'failed' ? failure(error.code) : uncertain('QQ_BUTTON_RESPONSE_UNKNOWN')
    }
    try {
      await bridge.store.recordDelivery(key, {
        state: receipt.ok ? 'delivered' : receipt.state, parts: [intent],
        ...(receipt.code ? { reason: receipt.code } : {}),
        ...(wait.sentId ? { externalMessageId: wait.sentId } : {}),
      })
    } catch { return uncertain('QQ_BUTTON_RECEIPT_UNCONFIRMED') }
    if (!receipt.ok) return receipt
    const prompt = plan.kind === 'callback' ? shortText(answer.data.promptText) : ''
    const response = wait.response ?? (prompt ? { text: prompt } : await this.waitForReply(group, wait, current))
    return response ? { ...receipt, state: 'responded', response } : { ...receipt, code: 'QQ_BUTTON_REPLY_UNOBSERVED' }
  }
}
