import { createHash } from 'node:crypto'
import { deepseekPriceWindow } from './deepseek-pricing.mjs'
export class BackpressureError extends Error {
  constructor(retryAfterMs = 1000, reason = 'RATE_LIMIT') { super('QQ_BACKPRESSURE'); this.code = 'QQ_BACKPRESSURE'; this.retryAfterMs = Math.max(100, retryAfterMs); this.reason = reason }
}
export function stableProbability(bindingId, messageId) { return createHash('sha256').update(JSON.stringify([bindingId, messageId])).digest().readUInt32BE(0) / 4294967296 * 100 }
export function mentioned(event, policy, quote) { return !!(event.selfId && event.mentions?.includes(event.selfId) || quote && quote.senderId === event.selfId || policy.keywords.some(word => event.text.includes(word))) }
/** Per-binding serial callers persist one decision before ASR/media/native admission. No hidden queue or delayed webhook. */
export class InboundPolicy {
  constructor({ store, now = Date.now }) { this.store = store; this.now = now; this.diagnostics = new Map(); this.tails = new Map() }
  async serial(bindingId, action) {
    const previous = this.tails.get(bindingId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    this.tails.set(bindingId, current)
    try { return await current } finally { if (this.tails.get(bindingId) === current) this.tails.delete(bindingId) }
  }
  snapshot() { return [...this.diagnostics].map(([bindingId, value]) => ({ bindingId, ...value })) }
  async restore(bindings) { for (const binding of bindings) { const value = await this.store.backpressure(binding.id); if (value) this.diagnostics.set(binding.id, value) } }
  async refuse(event, binding, retryAfterMs, reason) {
    const value = { state: 'backpressure', externalMessageId: event.externalMessageId, retryAfterMs, reason, at: this.now(), queued: false }
    await this.store.recordBackpressure(binding.id, value); this.diagnostics.set(binding.id, value); throw new BackpressureError(retryAfterMs, reason)
  }
  async precheck(event, binding) {
    const key = JSON.stringify([binding.id, event.externalMessageId]), existing = await this.store.admissionResult(key)
    if (existing) return existing
    if (binding.admission.enabled && binding.admission.allowedSenders.length && !binding.admission.allowedSenders.includes(event.senderId)) {
      const value = { admitted: false, mentioned: false, reason: 'SENDER_FILTERED', at: this.now() }
      await this.store.recordAdmissionResult(key, value); this.diagnostics.set(binding.id, value); return value
    }
  }
  async decide(event, binding, quote) { return this.serial(binding.id, () => this._decide(event, binding, quote)) }
  async _decide(event, binding, quote) {
    const key = JSON.stringify([binding.id, event.externalMessageId]), existing = await this.store.admissionResult(key)
    if (existing) return existing
    const policy = binding.admission, now = this.now(), state = await this.store.admissionState(binding.id) ?? { window: [], tailLeft: 0, tailUntil: 0, lastDelivered: 0 }
    const named = mentioned(event, policy, quote), group = event.endpoint.startsWith('group:')
    const priceSchedule = group && !named && binding.priceSchedule?.enabled ? binding.priceSchedule : undefined
    let reason
    if (policy.enabled) {
      if (policy.allowedSenders.length && !policy.allowedSenders.includes(event.senderId)) reason = 'SENDER_FILTERED'
      else if (group && policy.mentionOnly && !named && !(state.tailLeft > 0 && state.tailUntil >= now)) reason = 'NOT_MENTIONED'
      else if (group && !priceSchedule && !(named && policy.mentionAlways) && stableProbability(binding.id, event.externalMessageId) >= policy.probability) reason = 'PROBABILITY_FILTERED'
    }
    if (!reason && priceSchedule) {
      const peak = deepseekPriceWindow(now) === 'peak'
      const probability = peak ? priceSchedule.peakProbability : priceSchedule.offPeakProbability
      if (stableProbability(binding.id, event.externalMessageId) >= probability) reason = peak ? 'PRICE_PEAK_FILTERED' : 'PRICE_OFF_PEAK_FILTERED'
    }
    if (reason) {
      const value = { admitted: false, mentioned: named, reason, at: now }
      await this.store.recordAdmissionResult(key, value); this.diagnostics.set(binding.id, value); return value
    }
    const window = state.window.filter(time => time > now - 60000)
    let tailLeft = state.tailLeft, tailUntil = state.tailUntil
    if (group && policy.enabled) {
      if (named) { tailLeft = policy.tailMessages; tailUntil = now + policy.tailMs }
      else if (tailLeft > 0 && tailUntil >= now) tailLeft--
    }
    const value = { admitted: true, mentioned: named, at: now }
    // Persist the attempt budget first. A crash may conservatively consume one slot, never lose a recorded rejection.
    await this.store.recordAdmissionState(binding.id, { ...state, window: [...window, now].slice(-60), tailLeft, tailUntil, lastDelivered: state.lastDelivered })
    await this.store.recordAdmissionResult(key, value); this.diagnostics.set(binding.id, value); return value
  }
  async sendDelay(binding) {
    if (!binding.rate?.enabled) return 0
    return this.serial(binding.id, async () => {
      const state = await this.store.admissionState(binding.id) ?? {}, now = this.now()
      const sent = (state.sentWindow ?? []).filter(time => time > now - 60000)
      return Math.max(0, (state.lastDelivered || 0) + binding.rate.cooldownMs - now, sent.length >= binding.rate.perMinute ? sent[0] + 60000 - now : 0)
    })
  }
  async delivered(bindingId) {
    return this.serial(bindingId, async () => {
      const state = await this.store.admissionState(bindingId) ?? { window: [], tailLeft: 0, tailUntil: 0 }
      const now = this.now(), sentWindow = (state.sentWindow ?? []).filter(time => time > now - 60000)
      await this.store.recordAdmissionState(bindingId, { ...state, lastDelivered: now, sentWindow: [...sentWindow, now].slice(-60) })
    })
  }
}
