import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { TRANSPORT_ID, parseEndpoint } from './onebot.mjs'
import { checkReplyFlow, isQqGroupTurn, pendingGroupInput } from './reply-flow.mjs'
import { estimateTypingMs, normalizeTypingControl, resolveTypingOptions } from './typing-speed.mjs'

const digest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const result = (ok, code, extra = {}) => ({ ok, code, ...extra })
const output = { schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' } }, required: ['ok', 'code'], additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const validText = value => typeof value === 'string' && value.trim() && value.length <= 32768
const copy = value => structuredClone(value)
const outboundPrefix = TRANSPORT_ID + ':outbound:'
const validReplyTo = value => typeof value === 'string' && /^-?\d{1,24}$/.test(value)
const maxReplyDeferrals = 3, maxReplyWaitMs = 15000
const currentBatch = (item, anchor) => {
  const reply = item.delivery?.reply, current = anchor.reply
  return reply?.sessionId === current.sessionId && reply?.turn === current.turn &&
    reply?.source?.provider === current.source?.provider && reply?.source?.model === current.source?.model
}

// Capture identifiers at each ingress stage: held for decoding, queued for the
// agent, and already consumed into the session. The message text stays in IO.
function incomingMarkers(bridge, scope, { includePending = true } = {}) {
  const ids = new Set()
  if (!scope.agent || !scope.target.sessionId || scope.target.sessionId !== scope.agent.id) return ids
  const add = value => { if (value !== undefined && value !== null && String(value)) ids.add(String(value)) }
  const addMessage = message => {
    const source = message?.source
    if (source?.kind === 'super-agent-io' && source.bindingId === scope.target.id) add(source.externalMessageId ?? source.traceId ?? message.id)
  }
  try { for (const id of bridge.nativeFeatures?.projection?.stateOf(scope.agent.session)?.inputs ?? []) add(id) } catch {}
  if (includePending) for (const message of [...(scope.agent.inbox?.nextStep ?? []), ...(scope.agent.inbox?.nextTurn ?? [])]) addMessage(message)
  try {
    for (const event of (scope.agent.session?.snapshotEvents?.() ?? []).slice(-1000)) {
      if (event.type === 'user/message') addMessage(event.data)
      if (includePending && event.type === 'agent/inbox/spliced' && event.seq > (scope.inputSeqBaseline ?? -1)) for (const message of event.data?.inserted ?? []) addMessage(message)
    }
  } catch {}
  if (includePending) {
    const state = bridge.merger?.states?.get(scope.target.id)
    for (const item of state?.events ?? []) add(item.event.externalMessageId)
    for (const id of state?.inFlight ?? []) add(id)
  }
  return ids
}
const historyKey = row => digest(row.messageId, row.text, row.replyTo, row.mentions, row.media, row.rich, row.recalled)
const contextChanged = context => Object.assign(new Error('QQ chat changed during typing'), { code: 'QQ_CONTEXT_CHANGED_DURING_TYPING', deliveryState: 'failed', context })
const typingComplete = () => Object.assign(new Error('Typing timer needs a decision'), { code: 'QQ_TYPING_CONFIRM_REQUIRED', deliveryState: 'failed' })

function splitPlainTextDraft(delivery, enabled, available) {
  const content = delivery.reply?.content
  if (!enabled || !Array.isArray(content) || !content.length || content.some(block => block.type !== 'text' || typeof block.text !== 'string')) return [delivery]
  const text = content.map(block => block.text).join('')
  if (!/[\r\n]/u.test(text) || /!\[|\]\(|\[表情[:：]|```/u.test(text)) return [delivery]
  const lines = text.split(/\r\n|\r|\n/u).filter(line => line.trim())
  if (lines.length < 2 || lines.length > available) return [delivery]
  return lines.map((line, index) => {
    const part = copy(delivery)
    part.deliveryId = index ? `${delivery.deliveryId}:line:${index}` : delivery.deliveryId
    part.reply.content = [{ type: 'text', text: line }]
    if (index) { delete part.replyTo; delete part.quoteChosen }
    return part
  })
}

/** Durable, per-destination draft buffer. Only commit() can reach the physical QQ transport. */
export class QqOutbox {
  constructor(bridge, { projection } = {}) { this.bridge = bridge; this.projection = projection; this.tails = new Map(); this.sendTails = new Map(); this.running = new Set(); this.replyDeferrals = new Map(); this.reviews = new Map(); this.jobs = new Map() }
  selection(box, args, anchor) {
    const eligible = box.entries.filter(item => (!args.id || item.id === args.id) && (item.state === 'draft' || args.retry === true && item.state === 'failed'))
    const relevant = args.id || args.includePrevious === true ? eligible : eligible.filter(item => currentBatch(item, anchor))
    return { relevant, previousDrafts: !args.id && args.includePrevious !== true ? eligible.length - relevant.length : 0 }
  }
  reviewFingerprint(scope, args, relevant) {
    return digest('qq-context-review-v1', scope.agent.id, scope.target.id, scope.target.endpoint, this.bridge.config.baseUrl,
      scope.anchor.reply.source?.provider, scope.anchor.reply.source?.model,
      args.id ?? '', args.includePrevious === true, args.retry === true, args.finish === true,
      relevant.map(item => [item.id, item.state, item.delivery.reply.content, item.delivery.replyTo ?? '', item.delivery.quoteChosen === true, item.delivery.typing ?? null]))
  }
  async reviewSnapshot(scope, args) {
    return this.serial(scope.target.id, async () => {
      scope.guard()
      const box = await this.load(scope.target), { relevant, previousDrafts } = this.selection(box, args, scope.anchor)
      return { relevant: copy(relevant), previousDrafts, fingerprint: this.reviewFingerprint(scope, args, relevant) }
    })
  }
  pruneReviews() {
    const now = Date.now()
    for (const [id, item] of this.reviews) if (now - item.createdAt > 300000) this.reviews.delete(id)
    while (this.reviews.size > 128) this.reviews.delete(this.reviews.keys().next().value)
  }
  async prepareReview(scope, args, signal, snapshot, { allowUnavailable = false, clockReady = false, releaseForFairness = false } = {}) {
    const history = this.bridge.nativeFeatures?.history
    if (!history?.read && !allowUnavailable) return result(false, 'QQ_CONTEXT_UNAVAILABLE')
    snapshot ??= await this.reviewSnapshot(scope, args)
    if (!snapshot.relevant.length) return result(false, snapshot.previousDrafts ? 'QQ_OUTBOX_CURRENT_BATCH_EMPTY' : 'QQ_OUTBOX_EMPTY', snapshot.previousDrafts ? { previousDrafts: snapshot.previousDrafts } : {})
    if (args.action === 'send') await checkReplyFlow(this.bridge, scope, signal, { allowPending: true })
    const drafts = snapshot.relevant.map(item => ({ kind: 'outgoing_draft', id: item.id, content: item.delivery.reply.content,
      typing: { ...(args.typing ?? item.delivery.typing ?? { speed: 'default' }), estimatedMs: estimateTypingMs(item.delivery.reply.content, resolveTypingOptions(this.bridge.config.typing, args.typing ?? item.delivery.typing)) },
      ...(item.needsReview ? { needsReview: true } : {}), ...(item.delivery.quoteChosen && item.delivery.replyTo ? { replyTo: item.delivery.replyTo } : {}) }))
    if (JSON.stringify(drafts).length > 100000) return result(false, 'QQ_CONTEXT_REVIEW_TOO_LARGE', { message: '待发内容较多，请选择具体条目分批查看并发送。' })
    let live
    try {
      const allowed = () => { try { scope.guard(); return this.target(scope.target.id) } catch { return undefined } }
      const response = history?.read && await history.read({ count: 12 }, allowed, signal)
      if (response?.ok) {
        const data = JSON.parse(response.text)
        if (Array.isArray(data?.messages) && !data.historyUnavailable) live = data
      }
    } catch { /* The result explicitly reports that the live history was unavailable. */ }
    scope.guard()
    const reviewId = randomUUID(), createdAt = Date.now()
    this.pruneReviews()
    this.reviews.set(reviewId, { createdAt, fingerprint: snapshot.fingerprint, ids: snapshot.relevant.map(item => item.id), agentId: scope.agent.id, targetId: scope.target.id, endpoint: scope.target.endpoint, clockReady, releaseForFairness,
      ...(live ? { history: live.messages.map(row => ({ id: String(row.messageId), key: historyKey(row) })), recalls: (live.recalls ?? []).map(row => String(row.messageId)) } : {}),
      ...(args.typing ? { typing: args.typing } : {}) })
    return result(false, 'QQ_CONTEXT_REVIEW', { reviewId, retrievedAt: createdAt, historyStatus: live ? 'live' : 'unavailable', peerInput: (this.bridge.peerTyping?.(scope.target.endpoint) ?? { state: 'unknown' }),
      timeline: [...(live?.messages ?? []).map(message => ({ kind: message.own ? 'sent' : 'received', ...message })), ...drafts],
      ...(live?.recalls?.length ? { recalls: live.recalls } : {}), ...(live?.truncated ? { historyTruncated: true } : {}),
      ...(live?.skipped ? { historySkipped: live.skipped } : {}), agentStatus: scope.agent.status ?? 'unknown', finishRequested: args.finish === true,
      message: live ? '请将待发内容放在最新聊天里判断是否合时，并核对描述与当前任务状态。决定发送时用同样的目标、条目和 finish 值携带 reviewId；也可以修改或暂缓。若说要查记录，请在本轮实际查完再结束。' : '实时聊天记录暂时无法读取。请结合已知上下文判断措辞和任务状态，再决定发送、修改或暂缓；决定发送时携带 reviewId。' })
  }
  async checkedReview(scope, args, signal) {
    this.pruneReviews()
    const snapshot = await this.reviewSnapshot(scope, args), review = typeof args.reviewId === 'string' ? this.reviews.get(args.reviewId) : undefined
    if (review && (Date.now() - review.createdAt <= (review.clockReady ? 300000 : 30000) || args.sendNow === true) && review.agentId === scope.agent.id && review.targetId === scope.target.id && review.endpoint === scope.target.endpoint) {
      const ids = new Set(review.ids), selected = snapshot.relevant.filter(item => ids.has(item.id))
      if (selected.length === ids.size && review.fingerprint === this.reviewFingerprint(scope, args, selected)) return review
    }
    return this.bridge.nativeFeatures?.history?.read ? this.prepareReview(scope, args, signal, snapshot) : undefined
  }
  freshInputs(scope) {
    if (scope.sendNow || scope.releaseForFairness) return []
    const baseline = scope.inputBaseline ?? new Set(), seenHistory = new Set((scope.review?.history ?? []).map(row => row.id))
    return [...incomingMarkers(this.bridge, scope)].filter(id => !baseline.has(id) && !seenHistory.has(id))
  }
  async checkLiveChat(scope, sentIds, signal) {
    if (scope.sendNow || scope.releaseForFairness) return
    let fresh = this.freshInputs(scope), live
    const history = this.bridge.nativeFeatures?.history
    if (history?.read && scope.review?.history) {
      try {
        const allowed = () => {
          if (signal?.aborted || this.bridge.closed || !this.bridge.networkEnabled()) return
          const target = this.target(scope.target.id)
          return target?.endpoint === scope.target.endpoint && target.sessionId === scope.target.sessionId ? target : undefined
        }
        const response = await history.read({ count: 12 }, allowed, signal)
        if (response?.ok) {
          const value = JSON.parse(response.text)
          if (Array.isArray(value?.messages) && !value.historyUnavailable) live = value
        }
      } catch { /* Preserve the input-based check when recent history is unavailable. */ }
    }
    fresh = this.freshInputs(scope)
    const old = new Map((scope.review?.history ?? []).map(row => [row.id, row.key]))
    const known = scope.inputBaseline ?? new Set(), sent = new Set(sentIds)
    const changed = (live?.messages ?? []).filter(row => {
      const id = String(row.messageId)
      return !sent.has(id) && (old.has(id) ? old.get(id) !== historyKey(row) : !known.has(id))
    })
    const oldRecalls = new Set(scope.review?.recalls ?? [])
    const recalls = (live?.recalls ?? []).filter(row => !oldRecalls.has(String(row.messageId)))
    if (fresh.length || changed.length || recalls.length) throw contextChanged({ historyStatus: live ? 'live' : 'unavailable', incomingCount: fresh.length,
      ...(live ? { recentMessages: live.messages, changedMessageIds: changed.map(row => row.messageId), ...(recalls.length ? { recalls } : {}) } : {}) })
  }
  checkImmediateInput(scope) {
    const fresh = this.freshInputs(scope)
    if (fresh.length) throw contextChanged({ historyStatus: 'unavailable', incomingCount: fresh.length })
  }
  wakeForDecision(job, scope) {
    if (job.observed || job.waiters > 0 || job.wakeSent || this.bridge.closed) return
    const agent = scope.agent
    const message = { id: randomUUID(), role: 'user', source: { kind: 'schedule' }, content: [{ type: 'text',
      text: `QQ 待发消息已到判断时机。请用 qq_buffer 的 watch 读取 jobId=${job.id}、destination=${scope.target.id} 的结果，查看最新聊天和草稿，自己决定发送、修改或清空；已经处理过时略过。` }] }
    try {
      if (agent?.status === 'idle' && typeof agent.followup === 'function') agent.followup(message)
      else if (typeof agent?.steer === 'function') agent.steer(message)
      else if (typeof agent?.followup === 'function') agent.followup(message)
      else { job.wake = 'unavailable'; return }
      job.wakeSent = true
    } catch { job.wake = 'failed'; this.bridge.report({ code: 'QQ_TYPING_WAKE_FAILED', bindingId: scope.target.id }) }
  }
  replyKey(scope) { return JSON.stringify([scope.agent.id, scope.target.id]) }
  replyWaitExpired(scope) {
    if (!isQqGroupTurn(this.bridge, scope)) return false
    const key = this.replyKey(scope), wait = this.replyDeferrals.get(key)
    if (!wait) return false
    const elapsed = performance.now() - wait.started
    if (elapsed > 300000) { this.replyDeferrals.delete(key); return false }
    return wait.rounds >= maxReplyDeferrals || elapsed >= maxReplyWaitMs
  }
  async deferReply(scope, pending, exec, receipts) {
    const key = this.replyKey(scope), now = performance.now()
    let wait = this.replyDeferrals.get(key)
    if (!wait || now - wait.started > 300000) wait = { started: now, rounds: 0, inputs: '' }
    let inputs = ''
    try { inputs = JSON.stringify(this.projection?.stateOf(scope.agent.session)?.inputs ?? []) } catch {}
    // Repeating the same tool call while the same input is still pending is one wait, not a new listening round.
    if (wait.rounds === 0 || wait.inputs !== inputs) { wait.rounds++; wait.inputs = inputs }
    this.replyDeferrals.set(key, wait)
    await this.markForReview(scope)
    if (pending.nextTurn && !pending.nextStep && !pending.receiving) exec?.concludeTurn?.()
    return result(false, 'QQ_INPUT_PENDING', { pending, listeningRounds: wait.rounds, canSendNow: true,
      ...(scope.reviewId && this.reviews.has(scope.reviewId) ? { reviewId: scope.reviewId } : {}),
      ...(receipts?.length ? { receipts } : {}), message: '新消息正在进入。可以先整理后发送；如果此刻适合先回复，调用 send 并设置 sendNow=true。后续消息会继续进入会话。' })
  }
  async serial(key, fn) {
    const prior = this.tails.get(key) ?? Promise.resolve()
    const work = prior.catch(() => {}).then(fn)
    this.tails.set(key, work)
    try { return await work } finally { if (this.tails.get(key) === work) this.tails.delete(key) }
  }
  async load(target) {
    let box = await this.bridge.store.outbox(target.id)
    if (!box) return { version: 1, bindingId: target.id, endpoint: target.endpoint, entries: [] }
    box = copy(box)
    if (box.endpoint !== target.endpoint) throw Object.assign(new Error('QQ destination changed'), { code: 'QQ_OUTBOX_TARGET_CHANGED' })
    let changed = false; const uncertain = []
    box.entries = box.entries.map(item => {
      if (item.state === 'reserved' && !this.running.has(item.id)) { changed = true; return { ...item, state: 'draft' } }
      if (item.state === 'sending' && !this.running.has(item.id)) { changed = true; uncertain.push(item.id); return { ...item, state: 'unknown', receipt: { state: 'unknown', reason: 'RESTART_DURING_SEND' } } }
      return item
    })
    if (changed) {
      await this.bridge.store.recordOutbox(target.id, box)
      for (const id of uncertain) await this.reconcile(id, { state: 'unknown', reason: 'RESTART_DURING_SEND' })
    }
    return box
  }
  async save(target, box) {
    let excess = Math.max(0, box.entries.length - 500)
    if (excess) box.entries = box.entries.filter(item => { if (excess && item.state === 'sent') { excess--; return false } return true })
    if (excess) throw Object.assign(new Error('QQ outbox is full'), { code: 'QQ_OUTBOX_FULL' })
    await this.bridge.store.recordOutbox(target.id, box)
  }
  async reconcile(id, update) {
    try { await this.bridge.io.updateBuffered?.(id, update) }
    catch { this.bridge.report({ code: 'QQ_OUTBOX_RECEIPT_UNCONFIRMED' }) }
  }
  target(id) {
    const bridge = this.bridge, configured = bridge.sendTarget(id, true)
    if (configured) return configured
    if (bridge.closed || !bridge.config.sendEnabled || typeof id !== 'string' || !id.startsWith(outboundPrefix)) return
    const endpoint = id.slice(outboundPrefix.length)
    try { parseEndpoint(endpoint) } catch { return }
    // An explicitly disabled configured destination keeps its own switch.
    if (bridge.config.bindings.some(row => row.endpoint === endpoint) || bridge.config.outboundTargets.some(row => row.endpoint === endpoint)) return
    return { id, endpoint, label: endpoint, enabled: true, sendEnabled: true, outboundOnly: true }
  }
  targets() {
    const bridge = this.bridge
    return [...(bridge.config.enabled ? bridge.config.bindings.filter(b => b.enabled && b.sendEnabled) : []),
      ...bridge.config.outboundTargets.filter(row => row.enabled).map(row => ({ ...row, id: TRANSPORT_ID + ':outbound:' + row.endpoint }))]
      .filter(row => this.target(row.id)).map(row => ({ destination: row.id, name: row.label, endpoint: row.endpoint }))
  }
  resolveTarget(value, binding, agent) {
    const targets = this.targets()
    const requested = typeof value === 'string' ? value.trim() : ''
    if (!requested) {
      if (binding) return this.target(binding.id)
      const own = this.bridge.config.bindings.filter(row => row.enabled && row.sendEnabled && row.sessionId === agent?.id && this.target(row.id))
      if (own.length === 1) return this.target(own[0].id)
      return targets.length === 1 ? this.target(targets[0].destination) : undefined
    }
    const matches = targets.filter(row => [row.destination, row.endpoint, row.endpoint.slice(row.endpoint.indexOf(':') + 1), row.name].includes(requested))
    if (matches.length && matches.every(row => row.endpoint === matches[0].endpoint)) return this.target((matches.find(row => row.destination === binding?.id) ?? matches[0]).destination)
    if (matches.length) return
    try { parseEndpoint(requested); return this.target(outboundPrefix + requested) } catch { return this.target(requested) }
  }
  /** Called by SA for automatic replies and explicit io_send alike; it never calls OneBot. */
  async stage(delivery, { signal } = {}) {
    const bridge = this.bridge, target = this.target(delivery.bindingId)
    if (!target || target.endpoint !== delivery.endpoint || !bridge.networkEnabled() || bridge.closed || signal?.aborted) return { state: 'failed', reason: 'QQ_SEND_DISABLED' }
    if (!delivery.reply?.sessionId || delivery.reply.source?.kind !== 'model' || !Array.isArray(delivery.reply.content)) return { state: 'failed', reason: 'DELIVERY_IDENTITY_MISMATCH' }
    if (delivery.intent !== 'explicit' && delivery.reply.sessionId !== target.sessionId) return { state: 'failed', reason: 'DELIVERY_IDENTITY_MISMATCH' }
    try {
      return await this.serial(target.id, async () => {
        if (!this.target(target.id) || signal?.aborted || bridge.closed) return { state: 'failed', reason: 'QQ_SEND_DISABLED' }
        const box = await this.load(target)
        if (!box.entries.some(item => item.id === delivery.deliveryId || item.id.startsWith(delivery.deliveryId + ':line:'))) {
          const staged = copy(delivery)
          if (!staged.quoteChosen) delete staged.replyTo
          const parts = splitPlainTextDraft(staged, bridge.confirmTypingClock, 500 - box.entries.length)
          for (const part of parts) box.entries.push({ id: part.deliveryId, state: 'draft', delivery: part, createdAt: Date.now(), attempts: 0 })
          await this.save(target, box)
        }
        return { state: 'buffered', bufferId: delivery.deliveryId }
      })
    } catch (error) { return { state: 'failed', reason: String(error.code ?? 'QQ_OUTBOX_STORE_FAILED').slice(0, 80) } }
  }
  anchor(exec) {
    const events = exec.agent?.session?.snapshotEvents?.()
    const callId = exec.rootCallId ?? exec.callId
    const event = Array.isArray(events) && events.toReversed().find(e => e.type === 'assistant/message' && e.data?.message?.source?.kind === 'model'
      && e.data.message.content?.some(block => block.type === 'tool-call' && block.id === callId))
    if (!event) throw Object.assign(new Error('Tool call anchor unavailable'), { code: 'QQ_OUTBOX_ANCHOR_UNAVAILABLE' })
    const m = event.data.message, { replayState, ...source } = m.source
    return { callId: exec.callId, reply: { version: 1, sessionId: exec.agent.id, seq: event.seq, messageId: m.id, turn: event.data.turn, step: event.data.step, time: event.time, source } }
  }
  context(args, exec, options) {
    const { binding, agent, current } = options, bridge = this.bridge
    if (exec.signal?.aborted || bridge.closed || !bridge.networkEnabled()) throw Object.assign(new Error('QQ unavailable'), { code: 'QQ_OUTBOX_UNAVAILABLE' })
    if (binding && (exec.agent !== agent || !current())) throw Object.assign(new Error('QQ binding unavailable'), { code: 'QQ_OUTBOX_UNAVAILABLE' })
    const anchor = this.anchor(exec)
    const target = this.resolveTarget(args.destination, binding, exec.agent)
    if (!target) return { targets: this.targets() }
    const guard = () => {
      if (exec.signal?.aborted || bridge.closed || !bridge.networkEnabled()) throw Object.assign(new Error('QQ unavailable'), { code: 'QQ_OUTBOX_UNAVAILABLE' })
      const live = this.target(target.id)
      if (!live || live.endpoint !== target.endpoint || live.sessionId !== target.sessionId) throw Object.assign(new Error('QQ target changed'), { code: 'QQ_OUTBOX_TARGET_CHANGED' })
      if (binding && (!current() || exec.agent !== agent)) throw Object.assign(new Error('QQ binding unavailable'), { code: 'QQ_OUTBOX_UNAVAILABLE' })
    }
    guard()
    return { target, anchor, guard, binding, agent: exec.agent }
  }
  async execute(args, exec, options) {
    let scope
    try {
      if (args.typing !== undefined) {
        try { args = { ...args, typing: normalizeTypingControl(args.typing) } } catch { return result(false, 'QQ_TYPING_INVALID') }
      }
      scope = this.context(args, exec, options)
      if (!scope.target) return result(false, 'QQ_OUTBOX_TARGET_REQUIRED', { targets: scope.targets })
      if (args.action === 'send') {
        try { scope.inputSeqBaseline = scope.agent.session?.snapshotEvents?.().at(-1)?.seq ?? -1 } catch { scope.inputSeqBaseline = -1 }
      }
      const confirmedInputs = args.action === 'send' ? incomingMarkers(this.bridge, scope, { includePending: false }) : undefined
      const pendingAtDecision = args.action === 'send' ? incomingMarkers(this.bridge, scope) : undefined
      if (this.bridge.io.flushOutbound) await this.bridge.io.flushOutbound(exec.agent.id)
      scope.guard()
      if (args.action === 'review') return await this.prepareReview(scope, args, exec.signal)
      if (args.action === 'watch') {
        const job = typeof args.jobId === 'string' ? this.jobs.get(args.jobId) : undefined
        if (!job || job.targetId !== scope.target.id) return result(false, 'QQ_OUTBOX_JOB_NOT_FOUND')
        if (args.waitMs !== undefined && (!Number.isSafeInteger(args.waitMs) || args.waitMs < 0 || args.waitMs > 5000)) return result(false, 'QQ_OUTBOX_INVALID_WAIT')
        if (job.status === 'running' && (args.waitMs ?? 5000) > 0) {
          const timer = new AbortController()
          const signal = exec.signal ? AbortSignal.any([exec.signal, timer.signal]) : timer.signal
          job.waiters++
          try { await Promise.race([job.done, wait(args.waitMs ?? 5000, undefined, { signal }).catch(() => {})]) }
          finally { job.waiters--; timer.abort() }
        }
        if (job.status !== 'running') { job.observed = true; return { ...job.outcome, jobId: job.id } }
        const activity = this.bridge.typingActivities?.get(scope.target.id)
        const elapsedMs = activity ? Math.max(0, Math.min(activity.durationMs, Date.now() - activity.startedAt)) : 0
        return result(true, 'QQ_OUTBOX_TYPING', { jobId: job.id, ...(activity ? { activity: { ...activity, elapsedMs, remainingMs: Math.max(0, activity.durationMs - elapsedMs) } } : {}) })
      }
      if (args.action === 'cancel_typing') return this.bridge.cancelTyping(scope.target.id, args.id)
        ? result(true, 'QQ_TYPING_CANCEL_REQUESTED') : result(false, 'QQ_TYPING_NOT_ACTIVE')
      if (args.action === 'send') {
        const reviewed = await this.checkedReview(scope, args, exec.signal)
        if (reviewed?.code) return reviewed
        if (reviewed) { scope.review = reviewed; scope.reviewId = args.reviewId }
        scope.typing = args.typing ?? reviewed?.typing
        scope.sendNow = args.sendNow === true
        scope.clockReady = reviewed?.clockReady === true
        scope.finishRequested = args.finish === true
        scope.releaseForFairness = reviewed?.releaseForFairness === true || this.replyWaitExpired(scope)
        scope.allowPending = scope.sendNow || scope.releaseForFairness
        const pending = await checkReplyFlow(this.bridge, scope, exec.signal, { allowPending: scope.allowPending })
        if (pending) return await this.deferReply(scope, pending, exec)
        scope.inputBaseline = scope.allowPending ? pendingAtDecision : confirmedInputs
        const typing = resolveTypingOptions(this.bridge.config.typing, scope.typing)
        const background = args.background ?? (this.bridge.confirmTypingClock && !scope.clockReady && typing.maxWaitMs > 0)
        const answer = await this.commit({ ...args, background }, scope)
        if (answer.ok && args.finish === true && answer.code !== 'QQ_OUTBOX_TYPING_STARTED') exec.concludeTurn?.()
        return answer
      }
      return await this.serial(scope.target.id, () => this.apply(args, scope))
    } catch (error) { return result(false, String(error.code ?? 'QQ_OUTBOX_OPERATION_FAILED').slice(0, 80)) }
  }
  async markForReview(scope) {
    return this.serial(scope.target.id, async () => {
      scope.guard()
      const box = await this.load(scope.target); let changed = false
      scope.guard()
      for (const item of box.entries) if (currentBatch(item, scope.anchor) && ['draft', 'failed', 'reserved'].includes(item.state) && !item.needsReview) { item.needsReview = true; changed = true }
      if (changed) await this.save(scope.target, box)
    })
  }
  async apply(args, scope) {
    const { target, anchor } = scope, action = args.action
    scope.guard()
    const box = await this.load(target)
    const selected = args.id ? box.entries.find(item => item.id === args.id) : undefined
    if (action === 'read') {
      if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) return result(false, 'QQ_OUTBOX_INVALID_OFFSET')
      const offset = args.offset ?? 0, end = Math.max(0, box.entries.length - offset), start = Math.max(0, end - 100)
      const entries = args.id ? (selected ? [selected] : []) : box.entries.slice(start, end)
      for (const [id, job] of this.jobs) if (job.finishedAt && Date.now() - job.finishedAt > 300000) this.jobs.delete(id)
      const jobs = [...this.jobs.values()].filter(job => job.targetId === target.id).map(({ id, status, createdAt, finishedAt, outcome }) => ({ id, status, createdAt, ...(finishedAt ? { finishedAt } : {}), ...(outcome ? { outcome } : {}) }))
      for (const job of this.jobs.values()) if (job.targetId === target.id && job.status !== 'running') job.observed = true
      const activity = this.bridge.typingActivities?.get(target.id)
      const elapsedMs = activity ? Math.max(0, Math.min(activity.durationMs, Date.now() - activity.startedAt)) : 0
      return result(true, 'QQ_OUTBOX_READ', { destination: target.id, peerInput: (this.bridge.peerTyping?.(target.endpoint) ?? { state: 'unknown' }), ...(jobs.length ? { jobs } : {}), total: box.entries.length, offset, hasMore: !args.id && start > 0, ...(activity ? { activity: { ...activity, elapsedMs, remainingMs: Math.max(0, activity.durationMs - elapsedMs) } } : {}), items: entries.map(item => ({ id: item.id, state: item.state, currentBatch: currentBatch(item, anchor), ...(item.delivery.typing ? { typing: item.delivery.typing } : {}), ...(item.needsReview ? { needsReview: true } : {}), createdAt: item.createdAt, attempts: item.attempts, ...(item.delivery.quoteChosen && item.delivery.replyTo ? { replyTo: item.delivery.replyTo } : {}), ...(item.receipt ? { receipt: item.receipt } : {}), content: args.id ? item.delivery.reply.content : item.delivery.reply.content.map(block => block.type === 'text' ? { type: 'text', text: block.text.slice(0, 1000), ...(block.text.length > 1000 ? { truncated: true } : {}) } : block) })) })
    }
    if (action === 'append') {
      if (!validText(args.text)) return result(false, 'QQ_OUTBOX_TEXT_REQUIRED')
      if (args.replyTo !== undefined && args.replyTo !== '' && !validReplyTo(args.replyTo)) return result(false, 'QQ_INVALID_REPLY_ID')
      const id = 'draft:' + digest(anchor.reply.sessionId, anchor.reply.seq, anchor.callId)
      let ids = [id]
      if (!box.entries.some(item => item.id === id || item.id.startsWith(id + ':line:'))) {
        const delivery = { deliveryId: id, bindingId: target.id, endpoint: target.endpoint, reply: { ...anchor.reply, content: [{ type: 'text', text: args.text }] }, traceIds: [], intent: 'explicit', ...(args.typing ? { typing: args.typing } : {}), ...(args.replyTo ? { replyTo: args.replyTo, quoteChosen: true } : {}) }
        const parts = splitPlainTextDraft(delivery, this.bridge.confirmTypingClock, 500 - box.entries.length)
        ids = parts.map(part => part.deliveryId)
        for (const part of parts) box.entries.push({ id: part.deliveryId, state: 'draft', delivery: part, createdAt: Date.now(), attempts: 0 })
        await this.save(target, box)
      }
      return result(true, 'QQ_OUTBOX_APPENDED', { id, ...(ids.length > 1 ? { ids } : {}) })
    }
    if (action === 'replace') {
      if (!selected || !['draft', 'failed'].includes(selected.state)) return result(false, 'QQ_OUTBOX_ITEM_NOT_EDITABLE')
      if (args.text === undefined && args.typing === undefined || args.text !== undefined && !validText(args.text)) return result(false, 'QQ_OUTBOX_TEXT_REQUIRED')
      if (args.replyTo !== undefined && args.replyTo !== '' && !validReplyTo(args.replyTo)) return result(false, 'QQ_INVALID_REPLY_ID')
      if (args.text !== undefined) { selected.delivery.reply.content = [{ type: 'text', text: args.text }]; delete selected.needsReview }
      if (args.typing !== undefined) selected.delivery.typing = args.typing
      selected.state = 'draft'; delete selected.receipt
      if (args.replyTo !== undefined) {
        if (args.replyTo) { selected.delivery.replyTo = args.replyTo; selected.delivery.quoteChosen = true }
        else { delete selected.delivery.replyTo; delete selected.delivery.quoteChosen }
      }
      let ids = [selected.id]
      if (args.text !== undefined) {
        const parts = splitPlainTextDraft(selected.delivery, this.bridge.confirmTypingClock, 501 - box.entries.length)
        if (parts.length > 1 && parts.slice(1).every(part => !box.entries.some(item => item.id === part.deliveryId))) {
          selected.delivery = parts[0]
          ids = parts.map(part => part.deliveryId)
          const index = box.entries.indexOf(selected)
          box.entries.splice(index + 1, 0, ...parts.slice(1).map(part => ({ id: part.deliveryId, state: 'draft', delivery: part, createdAt: Date.now(), attempts: 0 })))
        }
      }
      await this.save(target, box)
      if (args.text !== undefined) await this.reconcile(selected.id, { state: 'content', content: selected.delivery.reply.content })
      return result(true, 'QQ_OUTBOX_REPLACED', { id: selected.id, ...(ids.length > 1 ? { ids } : {}) })
    }
    if (action === 'clear') {
      const before = box.entries.length, removed = box.entries.filter(item => !['reserved', 'sending'].includes(item.state) && (!args.id || item.id === args.id))
      box.entries = box.entries.filter(item => ['reserved', 'sending'].includes(item.state) || (args.id && item.id !== args.id))
      await this.save(target, box)
      for (const item of removed) await this.reconcile(item.id, { state: 'cleared' })
      return result(true, 'QQ_OUTBOX_CLEARED', { removed: before - box.entries.length })
    }
    return result(false, 'QQ_OUTBOX_ACTION_REQUIRED')
  }
  async commit(args, scope) {
    const target = scope.target, prior = this.sendTails.get(target.id) ?? Promise.resolve()
    // Reserve the selected draft snapshot immediately, even if an earlier QQ
    // send is still running. New drafts stay available for a later send.
    const reservation = this.serial(target.id, async () => {
      scope.guard()
      const box = await this.load(target)
      let { relevant, previousDrafts } = this.selection(box, args, scope.anchor)
      let newDrafts = 0
      if (scope.review) {
        const ids = new Set(scope.review.ids), allRelevant = relevant
        relevant = allRelevant.filter(item => ids.has(item.id)); newDrafts = allRelevant.length - relevant.length
        if (relevant.length !== ids.size || scope.review.fingerprint !== this.reviewFingerprint(scope, args, relevant)) return { reviewChanged: true }
      }
      const reviewAccepted = args.confirmReviewed === true || args.sendNow === true || !!scope.review
      const reviewCount = reviewAccepted ? 0 : relevant.filter(item => item.needsReview).length
      const rows = reviewAccepted ? relevant : relevant.filter(item => !item.needsReview)
      for (const item of rows) { item.state = 'reserved'; this.running.add(item.id) }
      try { if (rows.length) await this.save(target, box) }
      catch (error) { for (const item of rows) this.running.delete(item.id); throw error }
      return { candidates: rows.map(item => item.id), previousDrafts, reviewCount, newDrafts }
    }).then(selection => selection, error => ({ error }))
    const work = prior.catch(() => {}).then(async () => {
      const selected = await reservation
      if (selected.error) throw selected.error
      if (selected.reviewChanged) return result(false, 'QQ_CONTEXT_REVIEW_CHANGED', { message: '待发内容已变化，请重新查看当前聊天后决定。' })
      if (!selected.candidates.length && selected.reviewCount) return result(false, 'QQ_OUTBOX_REVIEW_REQUIRED', { reviewCount: selected.reviewCount })
      if (!selected.candidates.length && selected.previousDrafts) return result(false, 'QQ_OUTBOX_CURRENT_BATCH_EMPTY', { previousDrafts: selected.previousDrafts })
      const answer = await this.runCommit(target, selected.candidates, scope)
      return { ...answer, ...(selected.previousDrafts ? { previousDrafts: selected.previousDrafts } : {}), ...(selected.reviewCount ? { reviewCount: selected.reviewCount } : {}), ...(selected.newDrafts ? { newDrafts: selected.newDrafts } : {}) }
    })
    this.sendTails.set(target.id, work)
    if (args.background === true) {
      const selected = await reservation
      if (selected.error || selected.reviewChanged || !selected.candidates?.length) {
        try { return await work } finally { if (this.sendTails.get(target.id) === work) this.sendTails.delete(target.id) }
      }
      const id = randomUUID(), job = { id, targetId: target.id, status: 'running', createdAt: Date.now(), waiters: 0, observed: false }
      for (const [oldId, old] of this.jobs) if (old.finishedAt && (Date.now() - old.finishedAt > 300000 || this.jobs.size >= 128)) this.jobs.delete(oldId)
      this.jobs.set(id, job)
      job.done = work.then(outcome => {
        job.status = 'done'; job.outcome = outcome
        const incomingWillWakeSameAgent = outcome.code === 'QQ_CONTEXT_CHANGED_DURING_TYPING' && outcome.context?.inputArriving === true && scope.target.sessionId === scope.agent?.id
        if (['QQ_TYPING_CONFIRM', 'QQ_CONTEXT_CHANGED_DURING_TYPING'].includes(outcome.code) && !incomingWillWakeSameAgent) queueMicrotask(() => this.wakeForDecision(job, scope))
      }, error => { job.status = 'failed'; job.outcome = result(false, String(error.code ?? 'QQ_OUTBOX_OPERATION_FAILED').slice(0, 80)) })
        .finally(() => { job.finishedAt = Date.now(); if (this.sendTails.get(target.id) === work) this.sendTails.delete(target.id) })
      return result(true, 'QQ_OUTBOX_TYPING_STARTED', { jobId: id, ids: selected.candidates, message: '正在准备发送，期间继续接收消息。用 watch 查看结果；聊天变化时会先暂停并请你重新决定。输入期间也可用 cancel_typing 停止后续发送。' })
    }
    try { return await work } finally { if (this.sendTails.get(target.id) === work) this.sendTails.delete(target.id) }
  }
  async runCommit(target, candidates, scope) {
    if (!candidates.length) return result(false, 'QQ_OUTBOX_EMPTY')
    const receipts = []; let changedContext, clockPending, affectedBatch
    try {
      for (const id of candidates) {
        if (!scope.allowPending && isQqGroupTurn(this.bridge, scope)) {
          const pending = pendingGroupInput(this.bridge, scope)
          if (pending.nextStep || pending.nextTurn || pending.receiving) {
            return await this.deferReply(scope, pending, undefined, receipts)
          }
        }
        const item = await this.serial(target.id, async () => {
          const box = await this.load(target), item = box.entries.find(row => row.id === id)
          if (!item || item.state !== 'reserved') throw Object.assign(new Error('Reservation changed'), { code: 'QQ_OUTBOX_RESERVATION_CHANGED' })
          item.attempts++; delete item.receipt
          await this.save(target, box)
          return copy(item)
        })
        if (scope.reviewId) this.reviews.delete(scope.reviewId)
        const key = 'outbox-send:' + digest(target.id, item.id, item.attempts)
        let receipt
        const delivery = copy(item.delivery)
        if (scope.typing) delivery.typing = scope.typing
        if (scope.clockReady) delivery.typing = { speed: 'instant' }
        if (!delivery.quoteChosen) delete delivery.replyTo
        delete delivery.quoteChosen
        const onSendStart = () => this.serial(target.id, async () => {
          const box = await this.load(target), stored = box.entries.find(row => row.id === id)
          if (!stored || stored.state !== 'reserved') throw Object.assign(new Error('Reservation changed'), { code: 'QQ_OUTBOX_RESERVATION_CHANGED' })
          stored.state = 'sending'; await this.save(target, box); await this.reconcile(id, { state: 'sending' })
        })
        const priorIds = receipts.filter(row => row.state === 'delivered').flatMap(row => String(row.externalMessageId ?? '').split(',').filter(Boolean))
        const onBeforeAction = ({ sentIds }) => this.checkLiveChat(scope, [...priorIds, ...sentIds], this.bridge.controller.signal)
        const onImmediateSend = () => this.checkImmediateInput(scope)
        const onTypingComplete = this.bridge.confirmTypingClock && !scope.clockReady ? () => { throw typingComplete() } : undefined
        const onTypingInput = externalMessageId => {
          const id = String(externalMessageId ?? '')
          if (!id || scope.sendNow || scope.releaseForFairness || scope.inputBaseline?.has(id) || scope.review?.history?.some(row => row.id === id)) return
          return contextChanged({ historyStatus: 'unavailable', incomingCount: 1, inputArriving: true })
        }
        try { receipt = await this.bridge._deliveryFlight(key, () => this.bridge._deliver(delivery, { signal: this.bridge.controller.signal, idempotencyKey: key, bufferCommit: true, onSendStart, onBeforeAction, onImmediateSend, onTypingComplete, onTypingInput })) }
        catch (error) {
          // _deliver persists sending before it invokes OneBot. An absent record proves preparation failed first.
          let stored, readable = true
          try { stored = await this.bridge.store.delivery(key) } catch { readable = false }
          if (readable && !stored) receipt = { state: 'failed', reason: String(error?.code ?? 'QQ_SEND_PREPARE_FAILED').slice(0, 80) }
          else if (stored?.state === 'delivered') receipt = { state: 'delivered', externalMessageId: stored.externalMessageId }
          else if (stored?.state === 'failed') receipt = { state: 'failed', reason: stored.reason ?? 'QQ_SEND_FAILED' }
          else receipt = { state: 'unknown', reason: String(error?.code ?? 'QQ_SEND_RESPONSE_UNKNOWN').slice(0, 80) }
        }
        await this.serial(target.id, async () => {
          const box = await this.load(target), stored = box.entries.find(row => row.id === id)
          if (!stored || !['reserved', 'sending'].includes(stored.state)) throw Object.assign(new Error('Send state changed'), { code: 'QQ_OUTBOX_RECEIPT_UNCONFIRMED' })
          const reconsider = ['QQ_CONTEXT_CHANGED_DURING_TYPING', 'QQ_TYPING_CONFIRM_REQUIRED'].includes(receipt.reason)
          stored.state = receipt.state === 'delivered' ? 'sent' : receipt.state === 'failed' && (reconsider || receipt.reason === 'QQ_TYPING_CANCELLED' && stored.state === 'reserved') ? 'draft' : receipt.state === 'failed' ? 'failed' : 'unknown'
          if (reconsider && stored.state === 'draft') { stored.needsReview = true; delete stored.receipt }
          else stored.receipt = reconsider ? { state: receipt.state, reason: receipt.reason, deliveredParts: receipt.deliveredParts, sentMessageIds: receipt.sentMessageIds } : receipt
          await this.save(target, box)
          await this.reconcile(id, reconsider && stored.state === 'draft' ? { state: 'content', content: stored.delivery.reply.content } : receipt)
        })
        this.running.delete(id)
        const { context: ignoredContext, ...receiptSummary } = receipt
        receipts.push({ id, ...receiptSummary })
        if (receipt.reason === 'QQ_CONTEXT_CHANGED_DURING_TYPING') { changedContext = receipt.context ?? { historyStatus: 'unavailable' }; affectedBatch = item.delivery.reply }
        if (receipt.reason === 'QQ_TYPING_CONFIRM_REQUIRED') clockPending = { id }
        if (receipt.state === 'delivered') this.replyDeferrals.delete(this.replyKey(scope))
        if (receipt.state !== 'delivered') break
      }
    } finally {
      await this.serial(target.id, async () => {
        const box = await this.load(target); let changed = false
        for (const id of candidates) {
          const item = box.entries.find(row => row.id === id)
          if (item?.state === 'reserved') { item.state = 'draft'; if (changedContext || clockPending) item.needsReview = true; changed = true }
          this.running.delete(id)
        }
        if (changedContext && affectedBatch) for (const item of box.entries) {
          if (item.state === 'draft' && currentBatch(item, { reply: affectedBatch }) && !item.needsReview) { item.needsReview = true; changed = true }
        }
        if (changed) await this.save(target, box)
      })
    }
    if (clockPending) {
      const current = () => {
        const live = this.target(target.id)
        if (this.bridge.closed || !this.bridge.networkEnabled() || !live || live.endpoint !== target.endpoint || live.sessionId !== target.sessionId) throw Object.assign(new Error('QQ target changed'), { code: 'QQ_OUTBOX_TARGET_CHANGED' })
      }
      const clockScope = { ...scope, guard: current }
      const sent = new Set(receipts.filter(row => row.state === 'delivered').map(row => row.id))
      const remainingDraftIds = candidates.filter(id => id !== clockPending.id && !sent.has(id))
      const clockArgs = { action: 'review', id: clockPending.id, finish: scope.finishRequested && !remainingDraftIds.length }
      const review = await this.prepareReview(clockScope, clockArgs, this.bridge.controller.signal, undefined, { allowUnavailable: true, clockReady: true, releaseForFairness: scope.releaseForFairness })
      if (review.code !== 'QQ_CONTEXT_REVIEW') return review
      return { ...review, code: 'QQ_TYPING_CONFIRM', id: clockPending.id, readyAfterTyping: true,
        ...(remainingDraftIds.length ? { remainingDraftIds, ...(scope.finishRequested ? { remainingBeforeFinish: true } : {}) } : {}),
        message: '计时结束。请查看最新聊天和这条草稿，自己决定发送、修改或清空。决定发送时用相同 id、finish 和 reviewId 调用 send；其余草稿留在待发箱供你逐条判断。持续有消息时也可选择 sendNow=true。' }
    }
    if (changedContext) {
      const key = this.replyKey(scope), now = performance.now()
      let wait = this.replyDeferrals.get(key)
      if (!wait || now - wait.started > 300000) wait = { started: now, rounds: 0, inputs: '' }
      const marker = JSON.stringify([...(incomingMarkers(this.bridge, scope)), ...(changedContext.changedMessageIds ?? [])])
      if (wait.inputs !== marker) { wait.rounds++; wait.inputs = marker }
      this.replyDeferrals.set(key, wait)
      return result(false, 'QQ_CONTEXT_CHANGED_DURING_TYPING', { context: changedContext, receipts, listeningRounds: wait.rounds, canSendNow: true,
        message: '输入期间聊天有新变化，待发内容已暂停。请结合最新消息判断是否仍需发送，合并、删减或改写；别人已经回答且无需补充时可清空草稿。如果此刻适合先回复，可明确选择 sendNow=true。已发出的分条保留回执。' })
    }
    return result(receipts.length > 0 && receipts.every(row => row.state === 'delivered'), 'QQ_OUTBOX_SEND_RESULT', { receipts })
  }
  definition(options = {}) {
    return {
      name: options.name ?? (options.binding ? 'qq_buffer' : 'qq_outbox'),
      description: '在任何 DSH 会话使用 QQ 待发箱：read 查看草稿和私聊对方近期上报的输入状态 peerInput；append 追加；replace 覆盖；clear 清空；review 对照最新聊天检查待发内容；send 发送。send 首次返回 QQ_CONTEXT_REVIEW 时先看实时聊天、对方输入状态和草稿，判断合时及任务状态，然后用相同选择和 finish 值携带 reviewId 再 send，或自行修改、暂缓。模拟输入计时结束返回 QQ_TYPING_CONFIRM，结合最新聊天决定是否发送；发送时传回结果中的 id、finish、reviewId，也可 replace 或 clear。期间聊天变化时返回 QQ_CONTEXT_CHANGED_DURING_TYPING。后台发送用 watch(jobId) 查看结果，计时到会唤醒本会话。群消息持续时可自主决定先发，后续消息继续进入会话。当前会话有 QQ 绑定时默认该聊天，其他目标可填 group:群号 或 private:QQ号。历史草稿可指定 id；明确要求全部历史草稿时用 includePrevious。失败可修改或 retry，unknown 先检查 QQ。',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'append', 'replace', 'clear', 'review', 'send', 'watch', 'cancel_typing'] },
        destination: { type: 'string', description: 'QQ 聊天目标：group:群号、private:QQ号、已配置名称或目标 ID；当前绑定会话可省略。' },
        id: { type: 'string', description: '操作指定条目的 ID；send 可以选择任何时间产生的待发条目，clear 省略 id 清空。' },
        all: { type: 'boolean', description: '发送当前批次全部草稿；省略 id 也是当前批次。' },
        includePrevious: { type: 'boolean', description: 'send 时连同历史批次的草稿一起发送；适合用户明确要求发送全部历史草稿。' },
        confirmReviewed: { type: 'boolean', description: '已经结合新消息复核过待发内容时，发送标记需要复核的草稿；也可用 replace 修改后发送。' },
        reviewId: { type: 'string', description: '查看 QQ_CONTEXT_REVIEW 后得到的编号；决定发送时传回，同一目标、条目和 finish 值有效。' },
        sendNow: { type: 'boolean', description: '群消息仍在到来时，决定先发送当前选定内容；后续消息继续进入会话，保留已设置的发送频率。' },
        offset: { type: 'integer', minimum: 0, description: 'read 时从最新记录向前跳过的条数，每页最多 100 条。' },
        typing: { type: 'object', description: '控制模拟打字速度。append/replace 为单条设置；send 为本次发送设置。可使用 instant 即刻发送，rate 为倍率。', properties: { speed: { type: 'string', enum: ['default', 'instant', 'slow', 'normal', 'fast'] }, rate: { type: 'number', minimum: 0.1, maximum: 20 } }, additionalProperties: false },
        background: { type: 'boolean', description: '模拟输入默认在后台进行并在计时结束后唤醒你；设为 false 则等待结果。可用 read 查看 activity 和 jobs，用 cancel_typing 停止。' },
        jobId: { type: 'string', description: 'watch 时填写后台发送返回的 jobId。' },
        waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'watch 最多等待的毫秒数，默认 5000。' },
        text: { type: 'string', description: '追加或覆盖的内容。可用 Markdown 指定图片、语音和文件。' },
        replyTo: { type: 'string', description: '可选：想引用的 QQ 消息 ID，从 qq_history 或 qq_recent 获取；留空表示不引用。replace 时传空字符串可取消引用。' },
        retry: { type: 'boolean', description: '仅对明确失败的条目再次提交；结果未知的条目先核对 QQ。' },
        finish: { type: 'boolean', description: '所有选中条目成功送达后结束本轮。' },
      }, required: ['action'], additionalProperties: false }, output,
      execute: (args = {}, exec, authorize) => this.execute(args, exec, { ...options, authorize }),
    }
  }
  register(binding, agent, tools, current) {
    try { const off = tools.register(this.definition({ binding, agent, current })); return { state: 'applied', dispose: () => off?.() } }
    catch { return { state: 'unavailable', dispose() {} } }
  }
}
