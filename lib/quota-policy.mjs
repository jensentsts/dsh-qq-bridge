import { validateSelection, sameSelection, classifyModelFailure } from './model-policy.mjs'
import { TRANSPORT_ID } from './onebot.mjs'
import { isNativeContext } from './native-features.mjs'
const keyOf = binding => JSON.stringify([binding.id, binding.sessionId, binding.quotaPolicy])
/** Failure facts from a bounded canonical turn; ambiguous/mixed ownership is never eligible. */
export function quotaTurnFacts(events, turn, bindingId) {
  const start = events.findIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return { eligible: false, reason: 'TURN_OUTSIDE_BOUNDED_WINDOW' }
  let source, partial = false, tools = false
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start' && event.data.turn !== turn) break
    if (event.type === 'user/message') {
      const candidate = event.data.source
      if (isNativeContext(candidate)) continue
      if (candidate?.kind !== 'super-agent-io' || candidate.transport !== TRANSPORT_ID || candidate.bindingId !== bindingId) return { eligible: false, reason: 'MIXED_OR_LOCAL_INPUT' }
      if (source && source.externalMessageId !== candidate.externalMessageId) return { eligible: false, reason: 'MULTIPLE_EXTERNAL_INPUTS' }
      source = candidate
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') tools = true
    if (event.type === 'assistant/message') {
      const blocks = event.data.message?.content ?? []
      if (blocks.some(block => ['image', 'file', 'tool-call'].includes(block.type) || block.type === 'text' && block.text.length)) partial = true
    }
    if (event.type === 'assistant/attempt') {
      if (event.data.stream?.some(record => record.type === 'text-chunks' && record.texts.some(Boolean) || record.type === 'tool-call-chunks' || record.type === 'chunk' && ['text-delta', 'tool-call-delta'].includes(record.chunk?.type))) partial = true
    }
  }
  if (!source || partial || tools) return { eligible: false, reason: partial ? 'PARTIAL_OUTPUT' : tools ? 'TOOL_EFFECTS' : 'NO_EXCLUSIVE_QQ_INPUT' }
  return { eligible: true, externalMessageId: source.externalMessageId }
}
/** Quota failure never replays the failed turn. Selection is considered only before the next distinct QQ input. */
export class QuotaPolicy {
  constructor({ resolveAgent, liveAgent, catalog, store, binding, watch, notice, timeoutMs = 10000, maxTurnEvents = 512 }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000 || !Number.isSafeInteger(maxTurnEvents) || maxTurnEvents < 16 || maxTurnEvents > 4096) throw new Error('Invalid quota policy bounds')
    this.resolveAgent = resolveAgent; this.liveAgent = liveAgent; this.catalog = catalog; this.store = store; this.binding = binding; this.watch = watch; this.notice = notice; this.timeoutMs = timeoutMs; this.maxTurnEvents = maxTurnEvents
    this.records = new Map(); this.tails = new Map(); this.inputTails = new Map(); this.controller = new AbortController(); this.closed = false
  }
  snapshot() { return [...this.records].map(([bindingId, value]) => ({ bindingId, ...value.status })) }
  async arm(binding) {
    if (!binding.enabled || binding.quotaPolicy?.mode !== 'next-input' || this.closed) return
    const key = keyOf(binding), old = this.records.get(binding.id)
    if (old?.key === key && (!old.agent || !this.liveAgent || old.agent === this.liveAgent(binding.sessionId))) return
    old?.off?.(); old?.controller.abort()
    const record = { key, controller: new AbortController(), status: { state: 'armed' } }; this.records.set(binding.id, record)
    try {
      const activeSignal = AbortSignal.any([this.controller.signal, record.controller.signal, AbortSignal.timeout(this.timeoutMs)])
      let abort
      let found
      try { found = await Promise.race([Promise.resolve().then(() => { activeSignal.throwIfAborted(); return this.resolveAgent(binding.sessionId) }), new Promise((_, reject) => { abort = () => reject(new Error('QUOTA_RESOLVE_TIMEOUT')); activeSignal.addEventListener('abort', abort, { once: true }) })]) }
      finally { activeSignal.removeEventListener('abort', abort) }
      const agent = found?.agent ?? found
      if (found?.error || !agent?.model || !this._current(binding, record)) return
      record.agent = agent
      const saved = await this.store.quotaResult(binding.id)
      if (!this._current(binding, record)) return
      if (saved?.policyKey === key) record.status = { ...saved, state: saved.state === 'selecting' ? 'unknown' : saved.state }
      record.off = this.watch(agent, event => { const tail = (this.tails.get(binding.id) ?? Promise.resolve()).then(() => this._observe(binding, record, event)); this.tails.set(binding.id, tail.catch(() => { record.status = { ...record.status, state: 'unknown', reason: 'QUOTA_SIDECAR_UNCONFIRMED' } })); return tail })
    } catch { record.status = { state: 'failed', reason: 'QUOTA_POLICY_UNAVAILABLE' } }
  }
  _current(binding, record) { const latest = this.binding(binding.id); return !this.closed && !record.cancelled && latest?.enabled && latest.quotaPolicy?.mode === 'next-input' && keyOf(latest) === record.key && this.records.get(binding.id) === record && (!record.agent || !this.liveAgent || this.liveAgent(binding.sessionId) === record.agent) }
  async _observe(binding, record, event) {
    if (!this._current(binding, record) || event.type !== 'turn/end') return
    if (['aborted', 'interrupted'].includes(event.data.reason?.kind)) { await this.cancel(binding.id); return }
    if (event.data.reason?.kind !== 'error') return
    const failure = event.data.reason.error, kind = classifyModelFailure(failure)
    if (!['quota', 'rate-limit'].includes(kind)) return
    const session = record.agent.session
    const facts = quotaTurnFacts(session.snapshotEvents(Math.max(0, event.seq - this.maxTurnEvents), event.seq + 1), event.data.turn, binding.id)
    if (!facts.eligible) { record.status = { state: 'suppressed', reason: facts.reason }; return }
    const saved = await this.store.quotaResult(binding.id), used = saved?.policyKey === record.key ? saved.used : 0
    if (saved?.policyKey === record.key && saved.failureTurn === event.data.turn) return
    const state = used >= binding.quotaPolicy.maxSwitches ? 'exhausted' : 'pending'
    const failedEvents = session.snapshotEvents(Math.max(0, event.seq - this.maxTurnEvents), event.seq + 1)
    const turnStart = failedEvents.findIndex(item => item.type === 'turn/start' && item.data.turn === event.data.turn)
    const header = [...failedEvents.slice(turnStart + 1)].reverse().find(item => item.type === 'request/header')?.data.header
    const failedHeader = header?.config
    const selected = failedHeader ? { provider: failedHeader.provider, model: failedHeader.model, ...(failedHeader.reasoningEffort && header.adapterDefaults?.reasoningEffort !== true ? { reasoningEffort: failedHeader.reasoningEffort } : {}) } : undefined
    if (!selected || !sameSelection(selected, record.agent.model.current())) { record.status = { state: 'suppressed', reason: 'UNKNOWN_FAILED_SELECTION' }; return }
    const value = { policyKey: record.key, state, used, failureTurn: event.data.turn, failedSelection: structuredClone(selected), externalMessageId: facts.externalMessageId, failureKind: kind }
    if (!this._current(binding, record)) return
    await this.store.recordQuotaResult(binding.id, value); record.status = value
    if (this._current(binding, record)) await this.notice?.({ bindingId: binding.id, turn: event.data.turn, externalMessageId: facts.externalMessageId, state, kind })
  }
  beforeInput(binding, externalMessageId, signal) {
    const work = (this.inputTails.get(binding.id) ?? Promise.resolve()).then(() => this._beforeInput(binding, externalMessageId, signal))
    this.inputTails.set(binding.id, work.catch(() => {})); return work
  }
  async _beforeInput(binding, externalMessageId, signal) {
    await this.arm(binding)
    const record = this.records.get(binding.id)
    await this.tails.get(binding.id)
    if (!record || !this._current(binding, record)) return { state: 'off' }
    const saved = await this.store.quotaResult(binding.id)
    if (saved?.policyKey !== record.key || saved.state !== 'pending' || saved.externalMessageId === externalMessageId) return { state: saved?.state ?? 'armed' }
    if (record.agent.status !== 'idle' || record.agent.inbox?.nextTurn?.length || record.agent.inbox?.nextStep?.length) return { state: 'pending', reason: 'NOT_A_FRESH_IDLE_INPUT' }
    const activeSignal = AbortSignal.any([this.controller.signal, record.controller.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])])
    activeSignal.throwIfAborted()
    let onAbort
    try {
      const catalog = await Promise.race([Promise.resolve().then(() => { activeSignal.throwIfAborted(); return this.catalog() }), new Promise((_, reject) => { onAbort = () => reject(new Error('QUOTA_POLICY_CANCELLED')); activeSignal.addEventListener('abort', onAbort, { once: true }) })])
      const candidates = binding.quotaPolicy.candidates.map(selection => validateSelection(catalog, selection))
      const selection = candidates.find(candidate => !sameSelection(candidate, saved.failedSelection))
      if (!selection) return { state: 'failed', reason: 'NO_ELIGIBLE_FALLBACK' }
      if (activeSignal.aborted || !this._current(binding, record) || record.agent.status !== 'idle') return { state: 'cancelled' }
      if (!sameSelection(record.agent.model.current(), saved.failedSelection)) {
        await this.store.recordQuotaResult(binding.id, { ...saved, state: 'native-wins' }); record.status = { ...saved, state: 'native-wins' }; return { state: 'native-wins' }
      }
      const intent = { ...saved, used: saved.used + 1, state: 'selecting', selected: selection }
      await this.store.recordQuotaResult(binding.id, intent)
      if (activeSignal.aborted || !this._current(binding, record) || record.agent.status !== 'idle' || record.agent.inbox?.nextTurn?.length || record.agent.inbox?.nextStep?.length || !sameSelection(record.agent.model.current(), saved.failedSelection)) return { state: 'cancelled' }
      record.agent.model.select(selection)
      record.status = { ...intent, state: 'applied', durable: false }
      try { await this.store.recordQuotaResult(binding.id, { ...intent, state: 'applied' }); record.status.durable = true } catch { /* Applied native selection remains true; durable selecting prevents replay on restart. */ }
      return { state: 'applied', selection, durable: record.status.durable, replay: false }
    } catch { return { state: 'failed', reason: 'QUOTA_CATALOG_OR_STORAGE_FAILED' } }
    finally { activeSignal.removeEventListener('abort', onAbort) }
  }
  async cancel(bindingId) { const record = this.records.get(bindingId); if (!record) return; record.cancelled = true; record.controller.abort(); record.off?.(); const saved = await this.store.quotaResult(bindingId); if (saved?.policyKey === record.key && saved.state === 'pending') await this.store.recordQuotaResult(bindingId, { ...saved, state: 'cancelled' }); record.status = { state: 'cancelled' } }
  async reconcile(bindings) { for (const [id, record] of this.records) if (!bindings.some(binding => binding.id === id && binding.enabled && keyOf(binding) === record.key)) { await this.cancel(id); this.records.delete(id) } }
  async dispose() { this.closed = true; this.controller.abort(); for (const record of this.records.values()) record.off?.(); await Promise.allSettled([...this.tails.values(), ...this.inputTails.values()]); this.records.clear() }
}
