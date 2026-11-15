/** Session-local binding defaults. This module never prompts, steers, retries or changes global defaults. */
const selectionKey = selection => selection ? JSON.stringify([selection.provider, selection.model, selection.reasoningEffort ?? null]) : 'null'
export const sameSelection = (left, right) => selectionKey(left) === selectionKey(right)
export function validateSelection(catalog, input) {
  const provider = catalog?.groups?.find(group => group.id === input?.provider)
  const model = provider?.models?.find(item => item.id === input?.model)
  if (!model) throw Object.assign(new Error('MODEL_NOT_ROUTABLE'), { code: 'MODEL_NOT_ROUTABLE' })
  if (input.reasoningEffort !== undefined && !model.reasoning?.efforts?.some(effort => effort.id === input.reasoningEffort)) throw Object.assign(new Error('EFFORT_NOT_SUPPORTED'), { code: 'EFFORT_NOT_SUPPORTED' })
  return { provider: input.provider, model: input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) }
}
export const modelRequestKey = binding => JSON.stringify([binding.id, binding.sessionId, binding.modelPolicy ?? 'native-wins', binding.modelRevision ?? 0, selectionKey(binding.modelSelection)])
/** Pure failure classifier: only explicit provider codes/status, never arbitrary error-message substring matching. */
export function classifyModelFailure(failure) {
  const code = String(failure?.code ?? '').toUpperCase(), status = Number(failure?.httpStatus ?? failure?.status)
  if (status === 401 || status === 403 || ['AUTHENTICATION_FAILED', 'PERMISSION_DENIED'].includes(code)) return 'authorization'
  if (['INSUFFICIENT_QUOTA', 'QUOTA_EXCEEDED', 'INSUFFICIENT_BALANCE', 'CREDIT_EXHAUSTED'].includes(code) || status === 402) return 'quota'
  if (['RATE_LIMITED', 'RATE_LIMIT_EXCEEDED'].includes(code) || status === 429) return 'rate-limit'
  if (['ABORTED', 'CANCELLED', 'USER_CANCELLED'].includes(code)) return 'cancelled'
  return 'other'
}
/** A plan only. No failure authorizes replay of a request, partial reply or tool side effect. */
export function planQuotaFallback({ enabled = false, failure, boundary, partialOutput = false, toolEffects = false, cancelled = false, candidates = [], attempts = 0, maxAttempts = 1 }) {
  const kind = classifyModelFailure(failure)
  if (!enabled) return { action: 'stop', reason: 'FALLBACK_DISABLED' }
  if (cancelled || kind === 'cancelled') return { action: 'stop', reason: 'CANCELLED' }
  if (!['fresh-turn', 'fresh-step'].includes(boundary)) return { action: 'stop', reason: 'SELECTION_ALREADY_CAPTURED' }
  if (partialOutput || toolEffects) return { action: 'stop', reason: 'SIDE_EFFECTS_OR_PARTIAL_OUTPUT' }
  if (!['quota', 'rate-limit'].includes(kind)) return { action: 'stop', reason: 'FAILURE_NOT_ELIGIBLE' }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || attempts >= maxAttempts || !candidates.length) return { action: 'stop', reason: 'FALLBACK_BUDGET_EXHAUSTED' }
  return { action: 'select-for-next-boundary', selection: structuredClone(candidates[0]), replay: false }
}
export class BindingModelPolicy {
  constructor({ resolveAgent, liveAgent, catalog, store, binding, watch = () => () => {}, timeoutMs = 10000 }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Invalid model policy timeout')
    this.resolveAgent = resolveAgent; this.liveAgent = liveAgent; this.catalog = catalog; this.store = store; this.binding = binding; this.watch = watch; this.timeoutMs = timeoutMs
    this.active = new Map(); this.operations = new Map(); this.controller = new AbortController(); this.closed = false
  }
  snapshot() { return [...this.active].map(([bindingId, record]) => ({ bindingId, state: record.state, durable: record.durable === true, ...(record.selection ? { selection: structuredClone(record.selection) } : {}), ...(record.reason ? { reason: record.reason } : {}) })) }
  prepare(binding) {
    if (this.closed || !binding.modelSelection || binding.modelPolicy === 'off' || !binding.enabled) return Promise.resolve({ state: 'off' })
    const key = modelRequestKey(binding), pending = this.operations.get(binding.id)
    if (pending?.key === key) return pending.promise
    const existing = this.active.get(binding.id)
    if (existing?.requestKey === key) return existing.state === 'pending' && existing.agent?.status === 'idle' ? this._apply(binding, existing, undefined, false) : Promise.resolve({ state: existing.state })
    const operation = this._prepare(binding, key)
    this.operations.set(binding.id, { key, promise: operation })
    operation.finally(() => { if (this.operations.get(binding.id)?.promise === operation) this.operations.delete(binding.id) }).catch(() => {})
    return operation
  }
  _current(binding, record) { const latest = this.binding(binding.id); return !this.closed && !record.controller.signal.aborted && latest?.enabled && latest.modelSelection && modelRequestKey(latest) === record.requestKey && this.active.get(binding.id) === record && (!record.agent || !this.liveAgent || this.liveAgent(binding.sessionId) === record.agent) }
  async _bounded(operation, record, outerSignal) {
    const signal = AbortSignal.any([this.controller.signal, record.controller.signal, AbortSignal.timeout(this.timeoutMs), ...(outerSignal ? [outerSignal] : [])])
    signal.throwIfAborted()
    let onAbort
    try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }), new Promise((_, reject) => { onAbort = () => reject(Object.assign(new Error('MODEL_POLICY_ABORTED_OR_TIMEOUT'), { code: 'MODEL_POLICY_ABORTED_OR_TIMEOUT' })); signal.addEventListener('abort', onAbort, { once: true }) })]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }
  async _persist(binding, record, fields) {
    try { await this.store.recordModelResult(binding.id, { requestKey: record.requestKey, ...fields }); record.durable = true; return true }
    catch { record.durable = false; record.reason = 'MODEL_POLICY_SIDECAR_UNCONFIRMED'; return false }
  }
  async _prepare(binding, key) {
    const previous = this.active.get(binding.id); previous?.off?.(); previous?.controller.abort()
    const record = { requestKey: key, state: 'validating', durable: false, controller: new AbortController() }
    this.active.set(binding.id, record)
    try {
      const persisted = await this.store.modelResult(binding.id)
      if (persisted?.requestKey === key && ['applied', 'native-wins', 'cancelled', 'selecting'].includes(persisted.state)) {
        record.state = persisted.state === 'selecting' ? 'unknown' : persisted.state; record.selection = persisted.lastApplied; record.durable = true; return { state: record.state }
      }
      const selection = validateSelection(await this._bounded(() => this.catalog(), record), binding.modelSelection)
      const result = await this._bounded(() => this.resolveAgent(binding.sessionId), record)
      if (result?.error) throw result.error
      const agent = result?.agent ?? result
      if (agent?.id !== binding.sessionId || typeof agent.model?.current !== 'function' || typeof agent.model?.select !== 'function') throw new Error('MODEL_POLICY_UNAVAILABLE')
      if (record.state !== 'validating' || !this._current(binding, record)) return { state: 'cancelled' }
      record.agent = agent; record.selection = selection; record.baseline = agent.model.current()
      if (persisted?.requestKey === key && persisted.state === 'pending' && !sameSelection(record.baseline, persisted.pendingBaseline ?? undefined) || (binding.modelPolicy ?? 'native-wins') === 'native-wins' && record.baseline && !sameSelection(record.baseline, selection)) {
        record.state = 'native-wins'; await this._persist(binding, record, { state: record.state }); return { state: record.state }
      }
      record.state = 'pending'
      if (!await this._persist(binding, record, { state: 'pending', ...(record.baseline ? { pendingBaseline: record.baseline } : {}) })) { record.state = 'failed'; return { state: 'failed', reason: record.reason } }
      if (!this._current(binding, record) || record.state !== 'pending') return { state: 'cancelled' }
      record.off = this.watch(agent, { stopping: signal => this._apply(binding, record, signal, true), cancelled: () => this.cancel(binding.id) })
      if (agent.status === 'idle') return this._apply(binding, record, undefined, false)
      return { state: 'pending', reason: 'RUNNING_SELECTION_RETAINED_UNTIL_FRESH_BOUNDARY' }
    } catch (error) {
      if (record.state === 'cancelled' || record.controller.signal.aborted) return { state: 'cancelled' }
      record.state = 'failed'; record.reason = /^[A-Z_]+$/.test(error?.code || '') ? error.code : 'MODEL_POLICY_FAILED'
      return { state: record.state, reason: record.reason }
    }
  }
  _apply(binding, record, signal, stopping) {
    if (record.applyWork) return record.applyWork
    const work = this._applyOnce(binding, record, signal, stopping)
    record.applyWork = work
    work.finally(() => { if (record.applyWork === work) record.applyWork = undefined }).catch(() => {})
    return work
  }
  async _applyOnce(binding, record, signal, stopping) {
    if (record.state !== 'pending' || signal?.aborted || !this._current(binding, record)) return { state: 'cancelled' }
    if (!stopping && record.agent.status !== 'idle') return { state: 'pending' }
    try {
      // Validate again at the actual future boundary: provider/effort topology may have changed while busy.
      const selection = validateSelection(await this._bounded(() => this.catalog(), record, signal), binding.modelSelection)
      if (record.state !== 'pending' || signal?.aborted || !this._current(binding, record) || !stopping && record.agent.status !== 'idle') return { state: 'cancelled' }
      if (!sameSelection(record.agent.model.current(), record.baseline)) {
        record.state = 'native-wins'; record.off?.(); record.off = undefined
        await this._persist(binding, record, { state: record.state }); return { state: record.state }
      }
      // Durable intent prevents a crash or failed post-select write from replaying selection after restart.
      if (!await this._persist(binding, record, { state: 'selecting' })) { record.state = 'failed'; return { state: record.state, reason: record.reason } }
      if (record.state !== 'pending' || signal?.aborted || !this._current(binding, record) || !stopping && record.agent.status !== 'idle') return { state: 'cancelled' }
      if (!sameSelection(record.agent.model.current(), record.baseline)) { record.state = 'native-wins'; await this._persist(binding, record, { state: record.state }); return { state: record.state } }
      // No await separates this final owner/cancel/native-selection check from the native durable selection.
      record.agent.model.select(selection)
      record.state = 'applied'; record.selection = selection; record.off?.(); record.off = undefined
      await this._persist(binding, record, { state: 'applied', lastApplied: selection })
      return { state: 'applied', durable: record.durable, selection: structuredClone(selection), appliesTo: 'next-unprepared-step' }
    } catch (error) {
      if (record.state === 'applied') return { state: 'applied', durable: false }
      if (record.controller.signal.aborted || signal?.aborted || record.state === 'cancelled') return { state: 'cancelled' }
      record.state = 'failed'; record.reason = /^[A-Z_]+$/.test(error?.code || '') ? error.code : 'MODEL_POLICY_FAILED'; record.off?.(); record.off = undefined
      return { state: record.state, reason: record.reason }
    }
  }
  async reconcile(bindings) {
    for (const [id, record] of this.active) {
      const binding = bindings.find(row => row.id === id)
      if (!binding?.enabled || binding.modelPolicy === 'off' || !binding.modelSelection || modelRequestKey(binding) !== record.requestKey) await this.cancel(id)
    }
  }
  async cancel(bindingId) {
    const record = this.active.get(bindingId)
    if (!record || record.state === 'applied') return
    record.controller.abort(); record.off?.(); record.off = undefined; record.state = 'cancelled'
    await this._persist({ id: bindingId }, record, { state: 'cancelled' })
  }
  async dispose() { this.closed = true; this.controller.abort(); for (const record of this.active.values()) { record.controller.abort(); record.off?.() } await Promise.allSettled([...this.operations.values()].map(value => value.promise).concat([...this.active.values()].map(record => record.applyWork).filter(Boolean))); this.active.clear() }
}
