const bounded = (value, max) => String(value ?? '').slice(0, max)
const retryable = error => error?.code === 'QQ_BACKPRESSURE' || error?.code === 'INGRESS_BUSY' || error?.code === 'BACKPRESSURE'
const busy = () => Object.assign(new Error('QQ_MERGE_BUSY'), { code: 'QQ_BACKPRESSURE', retryAfterMs: 1000, reason: 'MERGE_BUSY' })
/**
 * Real per-chat merge window. It holds only bounded input facts, never a model turn, and hands a batch to the
 * same bridge/IO ingress as single messages. Mentions/replies flush promptly; ordinary chatter waits for a quiet gap.
 */
export class MergeWindow {
  constructor({ settings, ingest, signal, report = () => {}, now = Date.now, serial = false }) {
    this.settings = settings; this.ingest = ingest; this.signal = signal; this.report = report; this.now = now; this.serial = serial
    this.states = new Map(); this.closed = false
    this.onAbort = () => { void this.dispose(new Error('QQ bridge disposed')) }
    if (signal) signal.addEventListener('abort', this.onAbort, { once: true })
  }
  _settings() { return this.settings() }
  snapshot() { return [...this.states].map(([bindingId, state]) => ({ bindingId, held: state.events.length, sending: state.sending, heldMs: state.events.length ? Math.max(0, this.now() - (state.events[0]?.heldAt ?? this.now())) : 0 })) }
  _state(binding) {
    let state = this.states.get(binding.id)
    if (!state) { state = { binding, events: [], chars: 0, timer: null, retryAt: 0, sending: false, flight: null, inFlight: new Set() }; this.states.set(binding.id, state) }
    return state
  }
  _size(event) { return (event.text?.length || 0) + (event.media?.length || 0) * 64 + (event.rich?.reduce((sum, part) => sum + (part?.payload?.length || 0) + 64, 0) || 0) + 64 }
  _priority(event) { return Boolean(event.selfId && event.mentions?.includes(String(event.selfId)) || event.replyTo !== undefined) }
  _schedule(state) {
    const settings = this._settings()
    if (this.closed || !settings.enabled || !state.events.length || state.sending) return
    if (state.timer) clearTimeout(state.timer)
    const now = this.now()
    const first = state.events[0]?.heldAt ?? now, last = state.events.at(-1)?.heldAt ?? now
    const due = state.retryAt ? Math.max(now, state.retryAt) : this.serial ? now : Math.min(last + settings.windowMs, first + settings.maxWaitMs)
    state.timer = setTimeout(() => { state.timer = null; state.retryAt = 0; void this._flush(state).catch(error => this._report(error)) }, Math.max(0, due - now))
    state.timer.unref?.()
  }
  _report(error) { try { this.report({ code: bounded(error?.code || 'MERGE_FAILED', 80), bindingId: bounded(error?.bindingId || '', 128) }) } catch { /* Diagnostics only. */ } }
  enqueue(event, binding, { signal } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('QQ_MERGE_CLOSED'), { code: 'QQ_MERGE_CLOSED' }))
    if (signal?.aborted) return Promise.resolve({ ignored: true, reason: 'CLIENT_ABORTED' })
    const settings = this._settings()
    if (!settings.enabled) return Promise.reject(Object.assign(new Error('QQ_MERGE_DISABLED'), { code: 'QQ_MERGE_DISABLED' }))
    const state = this._state(binding), existing = state.events.find(item => item.event.externalMessageId === event.externalMessageId)
    if (existing) return existing.promise
    if (state.inFlight.has(event.externalMessageId)) return state.flight ?? Promise.resolve({ ignored: true, duplicate: true })
    const size = this._size(event)
    if (state.sending && (state.events.length >= settings.maxMessages || state.chars + size > settings.maxChars)) return Promise.reject(busy())
    if (!state.sending && state.events.length && (state.events.length >= settings.maxMessages || state.chars + size > settings.maxChars)) void this._flush(state).catch(error => this._report(error))
    let waiter, detach = () => {}
    const item = { event, heldAt: this.now(), waiter: null, promise: null }
    const promise = new Promise((resolve, reject) => {
      waiter = {
        resolve(value) { detach(); resolve(value) },
        reject(error) { detach(); reject(error) },
      }
      if (signal) {
        const abort = () => {
          const index = state.events.indexOf(item)
          if (index === -1) return
          state.events.splice(index, 1); state.chars -= size
          if (!state.events.length && state.timer) { clearTimeout(state.timer); state.timer = null }
          waiter.resolve({ ignored: true, reason: 'CLIENT_ABORTED' })
        }
        signal.addEventListener('abort', abort, { once: true })
        detach = () => signal.removeEventListener('abort', abort)
      }
    })
    item.waiter = waiter; item.promise = promise
    state.events.push(item)
    state.chars += size
    if (this._priority(event) || size > settings.maxChars) void this._flush(state).catch(error => this._report(error))
    else this._schedule(state)
    return promise
  }
  async _flush(state) {
    if (this.closed || state.sending || !state.events.length) return state.flight ?? { ignored: true, reason: 'MERGE_EMPTY' }
    const settings = this._settings(), batch = state.events.splice(0, this.serial ? 1 : settings.maxMessages)
    state.chars = state.events.reduce((sum, item) => sum + this._size(item.event), 0)
    if (state.timer) { clearTimeout(state.timer); state.timer = null }
    state.sending = true
    state.inFlight = new Set(batch.map(item => item.event.externalMessageId))
    const flight = (async () => {
      try {
        const receipt = await this.ingest(batch.map(item => item.event), state.binding, this.signal)
        for (const item of batch) item.waiter.resolve(receipt)
        state.inFlight.clear()
        return receipt
      } catch (error) {
        if (retryable(error) && !this.closed && this._settings().enabled) {
          state.inFlight.clear()
          state.events = [...batch, ...state.events]; state.chars += batch.reduce((sum, item) => sum + this._size(item.event), 0)
          state.retryAt = this.now() + Math.max(250, Math.min(Number(error.retryAfterMs) || 1000, 60000))
          this._schedule(state)
        } else { state.inFlight.clear(); for (const item of batch) item.waiter.reject(error) }
        throw error
      } finally {
        state.sending = false; state.flight = null
        if (state.events.length && !state.timer) this._schedule(state)
      }
    })()
    state.flight = flight
    try { return await flight } catch (error) { this._report(error); return { failed: bounded(error?.code || 'MERGE_FAILED', 80) } }
  }
  async flushAll() {
    const jobs = []
    for (const state of this.states.values()) {
      if (state.sending && state.flight) { try { await state.flight } catch { /* The retry keeps its batch. */ } }
      if (state.events.length) jobs.push(this._flush(state))
    }
    await Promise.allSettled(jobs)
  }
  /** Drop held inputs when their binding or receive switch changes; admitted work retains its receipt. */
  cancelPending(bindingId, reason = 'SETTINGS_CHANGED') {
    for (const [id, state] of this.states) {
      if (bindingId !== undefined && id !== bindingId) continue
      if (state.timer) clearTimeout(state.timer)
      state.timer = null; state.retryAt = 0; state.chars = 0
      for (const item of state.events.splice(0)) item.waiter.resolve({ ignored: true, reason })
      if (!state.sending) this.states.delete(id)
    }
  }
  async dispose(reason = new Error('QQ merge disposed')) {
    if (this.disposePromise) return this.disposePromise
    this.closed = true
    this.disposePromise = (async () => {
      this.signal?.removeEventListener('abort', this.onAbort)
      for (const state of this.states.values()) {
        if (state.timer) clearTimeout(state.timer)
        for (const item of state.events.splice(0)) item.waiter.reject(reason)
        state.inFlight.clear(); state.chars = 0
      }
      await Promise.allSettled([...this.states.values()].map(state => state.flight).filter(Boolean))
      this.states.clear()
    })()
    return this.disposePromise
  }
}
