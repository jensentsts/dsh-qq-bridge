import { parseEndpoint } from './onebot.mjs'
const seconds = value => Math.floor(value / 1000)
const clip = (value, max) => String(value ?? '').slice(0, max)
const retryable = error => error?.code === 'QQ_BACKPRESSURE' || error?.code === 'INGRESS_BUSY' || error?.code === 'BACKPRESSURE'
/**
 * Explicit HTTP history polling. It only feeds the existing bridge/IO ingress; it never creates a session,
 * starts a model turn, or bypasses receive/send gates. A single flight serves every interval tick.
 */
export class HistoryPoller {
  constructor({ onebot, store, receive, config, interval, report = () => {}, now = Date.now }) {
    this.onebot = onebot; this.store = store; this.receive = receive; this.config = config; this.intervalFactory = interval
    this.report = report; this.now = now; this.active = false; this.closed = false; this.flight = null; this.offTimer = null
    this.fallbackTimer = null; this.intervalMs = 0; this.controller = null; this.selfId = ''; this.selfIdAt = 0
    this.lastError = ''; this.watermarks = new Map(); this.activeBindings = new Set()
  }
  snapshot() { return { enabled: this.active, intervalMs: this.intervalMs, lastError: this.lastError, watermarks: [...this.watermarks].map(([bindingId, watermark]) => ({ bindingId, watermark })) } }
  async start(config) { return this.sync(config, { initial: true }) }
  async sync(config, { initial = false } = {}) {
    if (this.closed) return this.snapshot()
    const enabled = config?.enabled === true && config?.polling?.enabled === true
    if (!enabled) {
      this._stopTimer(); this.active = false; this.watermarks.clear(); this.activeBindings.clear()
      this.controller?.abort(new Error('QQ polling disabled')); this.controller = null
      try { await this.store.recordPollingRun({ enabled: false, enabledAt: seconds(this.now()) }) } catch { /* Clear a stale enabled marker so a later enable starts at the then-current watermark. */ }
      return this.snapshot()
    }
    const run = await this.store.pollingRun().catch(() => undefined)
    const resumed = initial && run?.enabled === true
    const wasActive = this.active || resumed
    const enabledAt = wasActive && Number.isFinite(Number(run?.enabledAt)) ? Number(run.enabledAt) : seconds(this.now())
    if (!wasActive) {
      this.watermarks.clear(); this.activeBindings.clear()
      for (const binding of config.bindings) if (binding.enabled) { await this._writeWatermark(binding.id, seconds(this.now()), enabledAt); this.activeBindings.add(binding.id) }
      try { await this.store.recordPollingRun({ enabled: true, enabledAt }) } catch { /* Diagnostic only. */ }
    } else {
      const nextBindings = new Set()
      for (const binding of config.bindings) {
        if (!binding.enabled) continue
        nextBindings.add(binding.id)
        const saved = await this.store.pollingState(binding.id).catch(() => undefined)
        if (!resumed && !this.activeBindings.has(binding.id)) await this._writeWatermark(binding.id, seconds(this.now()), enabledAt)
        else if (!saved) await this._writeWatermark(binding.id, seconds(this.now()), enabledAt)
        else this.watermarks.set(binding.id, Number(saved.watermark) || 0)
      }
      this.activeBindings = nextBindings
      try { await this.store.recordPollingRun({ enabled: true, enabledAt }) } catch { /* Diagnostic only. */ }
    }
    this.active = true
    this.controller ??= new AbortController()
    this._schedule(config.polling.intervalMs)
    // A fresh enable waits one interval; a resumed run polls promptly without replaying enable-time history.
    if (wasActive && !this.flight) void this.tick().catch(error => this._fail(error))
    return this.snapshot()
  }
  _writeWatermark(bindingId, watermark, enabledAt) {
    this.watermarks.set(bindingId, watermark)
    return this.store.recordPollingState(bindingId, { watermark, enabledAt })
  }
  _schedule(intervalMs) {
    if (this.offTimer !== null || this.fallbackTimer !== null) {
      if (this.intervalMs === intervalMs) return
      this._stopTimer()
    }
    this.intervalMs = intervalMs
    const fire = () => { void this.tick().catch(error => this._fail(error)) }
    if (typeof this.intervalFactory === 'function') this.offTimer = this.intervalFactory(fire, intervalMs)
    else {
      this.fallbackTimer = setInterval(fire, intervalMs)
      this.fallbackTimer.unref?.()
    }
  }
  _stopTimer() {
    try { this.offTimer?.() } catch { /* Effect already disposed. */ }
    if (this.fallbackTimer) clearInterval(this.fallbackTimer)
    this.offTimer = null; this.fallbackTimer = null
  }
  _fail(error) {
    this.lastError = clip(error?.code || error?.message || 'POLL_FAILED', 120)
    try { this.report({ code: 'QQ_POLL_FAILED', reason: this.lastError }) } catch { /* Reporting is diagnostic. */ }
  }
  tick() {
    if (this.closed || !this.active) return Promise.resolve({ skipped: true })
    if (this.flight) return this.flight
    this.flight = this._tick().catch(error => { this._fail(error); return { failed: this.lastError } }).finally(() => { this.flight = null })
    return this.flight
  }
  async _loginId(signal) {
    const now = this.now()
    if (this.selfId && now - this.selfIdAt < 600000) return this.selfId
    try {
      const value = await this.onebot.call('get_login_info', {}, { signal, timeoutMs: 5000, maxBytes: 65536 })
      this.selfId = String(value?.user_id ?? value?.userId ?? '').replace(/[^0-9]/g, '').slice(0, 24)
      this.selfIdAt = now
    } catch { /* History can still be polled without a self identity; normalizeEvent drops only known self IDs. */ }
    return this.selfId
  }
  async _history(peer, polling, watermark, signal) {
    const action = peer.kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
    const count = peer.kind === 'group' ? polling.count : Math.min(polling.count, 20)
    const params = peer.kind === 'group' ? { group_id: Number(peer.id), count } : { user_id: Number(peer.id), count }
    const call = async extra => {
      const data = await this.onebot.call(action, { ...params, ...extra }, { signal, timeoutMs: 8000, maxBytes: 1048576 })
      return Array.isArray(data?.messages) ? data.messages.filter(row => row && typeof row === 'object') : []
    }
    const first = await call({}), rows = [...first], seen = new Set(first.map(row => String(row.message_id ?? row.id)))
    let page = first, full = first.length >= count, warning = ''
    for (let pages = 1; full; pages++) {
      const sorted = page.filter(row => (row.message_id ?? row.id) !== undefined && Number(row.time) > 0).sort((a, b) => Number(a.time) - Number(b.time))
      const oldest = sorted[0]
      if (!oldest || Number(oldest.time) < watermark || seconds(this.now()) - Number(oldest.time) > Math.floor(polling.catchupMs / 1000)) break
      if (pages >= 20) { warning = 'HISTORY_PAGE_LIMIT'; break }
      const anchor = oldest.message_id ?? oldest.id
      const numeric = Number(anchor)
      if (!Number.isSafeInteger(numeric)) { warning = 'HISTORY_CURSOR_UNAVAILABLE'; break }
      let older, response
      for (const cursor of [{ message_id: numeric }, { message_seq: numeric, reverseOrder: true }]) {
        try { response = await call(cursor) } catch { response = [] }
        older = response.filter(row => {
          const id = row.message_id ?? row.id
          return id !== undefined && !seen.has(String(id)) && Number(row.time) > 0 && Number(row.time) <= Number(oldest.time)
        })
        if (older.length || response.length < count && response.some(row => String(row.message_id ?? row.id) === String(anchor))) break
      }
      if (!older.length) {
        if (response.length >= count) warning = 'HISTORY_PAGINATION_UNAVAILABLE'
        break
      }
      for (const row of older) { seen.add(String(row.message_id ?? row.id)); rows.push(row) }
      page = older; full = response.length >= count
    }
    return { messages: rows, warning }
  }
  async _tick() {
    const config = this.config(), signal = this.controller?.signal
    if (!config?.enabled || !config?.polling?.enabled) return { skipped: true }
    if (!config.bindings.some(binding => binding.enabled)) return { polls: [] }
    const selfId = await this._loginId(signal)
    const results = []
    for (const binding of config.bindings) {
      if (!binding.enabled) continue
      if (signal?.aborted) break
      let watermark = this.watermarks.get(binding.id)
      if (!Number.isFinite(watermark)) watermark = Number((await this.store.pollingState(binding.id))?.watermark) || seconds(this.now())
      const peer = parseEndpoint(binding.endpoint)
      let messages, historyWarning = ''
      try {
        const history = await this._history(peer, config.polling, watermark, signal)
        messages = history.messages; historyWarning = history.warning
      } catch (error) {
        this.lastError = clip(error?.code || 'HISTORY_UNAVAILABLE', 120)
        results.push({ bindingId: binding.id, state: 'unavailable', reason: this.lastError })
        continue
      }
      messages = messages.filter(row => row && typeof row === 'object').sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
      let processed = 0, failure = ''
      const merging = this.config()?.merge?.enabled === true, rows = []
      for (const row of messages) {
        if (signal?.aborted) break
        const current = this.config()
        if (!current?.enabled || !current?.polling?.enabled || !current.bindings.some(value => value.id === binding.id && value.enabled)) break
        const messageId = row.message_id ?? row.id
        if (messageId === undefined || messageId === null) continue
        const eventTime = Number(row.time) || 0
        if (eventTime && eventTime < watermark) continue
        if (eventTime && seconds(this.now()) - eventTime > Math.floor(current.polling.catchupMs / 1000)) {
          watermark = Math.max(watermark, eventTime)
          await this._writeWatermark(binding.id, watermark, Number((await this.store.pollingRun())?.enabledAt) || seconds(this.now()))
          continue
        }
        const senderId = String(row.sender?.user_id ?? row.user_id ?? peer.id)
        if (peer.kind === 'private' && senderId !== peer.id) { watermark = Math.max(watermark, eventTime || watermark); await this._writeWatermark(binding.id, watermark, Number((await this.store.pollingRun())?.enabledAt) || seconds(this.now())); continue }
        if (selfId && senderId === selfId) { watermark = Math.max(watermark, eventTime || watermark); await this._writeWatermark(binding.id, watermark, Number((await this.store.pollingRun())?.enabledAt) || seconds(this.now())); continue }
        rows.push({
          eventTime,
          event: {
            post_type: 'message', message_type: peer.kind, ...(peer.kind === 'group' ? { group_id: Number(peer.id) } : { user_id: Number(peer.id) }),
            message_id: messageId, user_id: senderId, ...(selfId ? { self_id: Number(selfId) } : {}), time: eventTime,
            ...(row.sender && typeof row.sender === 'object' ? { sender: row.sender } : {}), message: row.message ?? row.content ?? [],
          },
        })
      }
      if (merging && rows.length) {
        const pending = rows.map(row => this.receive(row.event))
        const outcomes = await Promise.allSettled(pending)
        let next = watermark
        for (let index = 0; index < outcomes.length; index++) {
          const outcome = outcomes[index]
          if (outcome.status === 'fulfilled') { next = Math.max(next, rows[index].eventTime || seconds(this.now())); processed++ }
          else {
            const error = outcome.reason
            failure = retryable(error) ? 'BACKPRESSURE' : clip(error?.code || error?.message || 'INGRESS_FAILED', 120)
            break
          }
        }
        watermark = next
        await this._writeWatermark(binding.id, watermark, Number((await this.store.pollingRun())?.enabledAt) || seconds(this.now()))
      } else {
        for (const row of rows) {
          try { await this.receive(row.event) }
          catch (error) {
            failure = retryable(error) ? 'BACKPRESSURE' : clip(error?.code || error?.message || 'INGRESS_FAILED', 120)
            break
          }
          watermark = Math.max(watermark, row.eventTime || seconds(this.now()))
          await this._writeWatermark(binding.id, watermark, Number((await this.store.pollingRun())?.enabledAt) || seconds(this.now()))
          processed++
        }
      }
      if (failure || historyWarning) this.lastError = failure || historyWarning
      results.push({ bindingId: binding.id, state: failure ? 'deferred' : historyWarning ? 'partial' : 'ok', processed, watermark, ...(failure || historyWarning ? { reason: failure || historyWarning } : {}) })
    }
    return { polls: results }
  }
  async dispose() {
    this.closed = true; this.active = false; this._stopTimer()
    this.controller?.abort(new Error('QQ polling disposed')); this.controller = null
    await Promise.allSettled(this.flight ? [this.flight] : [])
  }
}
