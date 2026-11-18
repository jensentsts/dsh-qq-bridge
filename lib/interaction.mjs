import { createHash } from 'node:crypto'
import { parseEndpoint } from './onebot.mjs'

const validUser = value => typeof value === 'string' && /^[1-9]\d{0,23}$/.test(value)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = code => ({ ok: false, state: 'failed', code })

/** Actions share the QQ channel's target selection and delivery receipts. */
export class QqInteraction {
  constructor(bridge) { this.bridge = bridge }

  definition() {
    return {
      name: 'qq_interact',
      description: '向 QQ 发送戳一戳或私聊窗口抖动。当前会话绑定 QQ 时可省略 destination，其他会话可通过 io_destinations 查找目标。群聊戳一戳需指定 userId。',
      timeoutMs: 15000,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['poke', 'shake'], description: 'poke 为戳一戳，shake 为私聊窗口抖动。' },
          destination: { type: 'string', description: 'QQ 目标的绑定 ID、group:群号或 private:QQ号。' },
          userId: { type: 'string', description: '要戳的 QQ 号；群聊必填，私聊默认对方。' },
        },
        required: ['action'], additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, state: { type: 'string' }, code: { type: 'string' }, targets: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['ok', 'state', 'code'], additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) => this.execute(args, exec),
    }
  }

  async execute(args, exec) {
    const bridge = this.bridge
    let scope
    try { scope = bridge.outbox.context(args, exec, {}) }
    catch (error) { return fail(error?.code ?? 'QQ_INTERACTION_UNAVAILABLE') }
    if (!scope.target) return { ...fail('QQ_TARGET_REQUIRED'), targets: scope.targets }

    const endpoint = parseEndpoint(scope.target.endpoint)
    if (!['poke', 'shake'].includes(args.action)) return fail('QQ_INTERACTION_INVALID')
    if (args.action === 'shake' && endpoint.kind !== 'private') return fail('QQ_SHAKE_PRIVATE_ONLY')
    const userId = args.userId ?? (endpoint.kind === 'private' ? endpoint.id : '')
    if (!validUser(userId) || endpoint.kind === 'private' && userId !== endpoint.id) return fail('QQ_INTERACTION_USER_REQUIRED')
    const action = args.action === 'shake' ? 'send_private_msg' : endpoint.kind === 'group' ? 'group_poke' : 'friend_poke'
    const params = args.action === 'shake'
      ? { user_id: userId, message: [{ type: 'shake', data: {} }] }
      : endpoint.kind === 'group' ? { group_id: endpoint.id, user_id: userId } : { user_id: userId }
    const key = 'interaction:' + digest([scope.anchor.reply.sessionId, scope.anchor.reply.seq, scope.anchor.callId])
    const intent = digest([scope.target.endpoint, args.action, userId])
    const origin = bridge.config.baseUrl
    const signal = AbortSignal.any([exec.signal, bridge.controller.signal].filter(Boolean))
    const guard = () => {
      scope.guard()
      if (signal.aborted || origin !== bridge.config.baseUrl) throw Object.assign(new Error('QQ target changed'), { code: 'QQ_OUTBOX_TARGET_CHANGED', deliveryState: 'failed' })
    }

    return bridge._deliveryFlight(key, async () => {
      const prior = await bridge.store.delivery(key)
      if (prior) {
        if (prior.parts?.[0] !== intent) return fail('QQ_INTERACTION_CONFLICT')
        if (prior.state === 'delivered') return { ok: true, state: 'sent', code: 'QQ_INTERACTION_SENT' }
        return { ok: false, state: prior.state === 'failed' ? 'failed' : 'unknown', code: prior.reason ?? 'QQ_INTERACTION_ALREADY_ATTEMPTED' }
      }
      try {
        guard()
        await bridge.store.recordDelivery(key, { state: 'sending', parts: [intent] })
        await bridge.onebot.call(action, params, { signal, beforeSend: guard, timeoutMs: 10000 })
        await bridge.store.recordDelivery(key, { state: 'delivered', parts: [intent] })
        return { ok: true, state: 'sent', code: 'QQ_INTERACTION_SENT' }
      } catch (error) {
        const state = error?.deliveryState === 'failed' ? 'failed' : 'unknown'
        const code = typeof error?.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'QQ_INTERACTION_FAILED'
        try { await bridge.store.recordDelivery(key, { state, reason: code, parts: [intent] }) } catch {}
        return { ok: false, state, code }
      }
    })
  }
}
