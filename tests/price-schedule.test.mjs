import test from 'node:test'
import assert from 'node:assert/strict'
import { InboundPolicy } from '../lib/admission.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { deepseekPriceWindow } from '../lib/deepseek-pricing.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const beijing = value => Date.parse(value + ':00+08:00')

test('DeepSeek price windows observe Beijing time, the midday break, holidays and weekends', () => {
  for (const [time, window] of [
    ['2026-11-12T08:59', 'offPeak'], ['2026-11-12T09:00', 'peak'], ['2026-11-12T12:00', 'offPeak'],
    ['2026-11-12T14:00', 'peak'], ['2026-11-12T18:00', 'offPeak'], ['2026-10-10T10:00', 'offPeak'],
    ['2026-10-06T10:00', 'offPeak'], ['2027-09-15T14:00', 'offPeak'], ['2027-09-16T14:00', 'peak'],
  ]) assert.equal(deepseekPriceWindow(beijing(time)), window, time)
})

test('group scheduling gates ordinary inputs before routing while direct replies retain the group rules', async () => {
  const config = normalizeConfig({ bindings: [
    { endpoint: 'group:123', sessionId: 'group', priceSchedule: { enabled: true, peakProbability: 0, offPeakProbability: 100 } },
    { endpoint: 'private:456', sessionId: 'private', priceSchedule: { enabled: true, peakProbability: 0, offPeakProbability: 0 } },
  ] })
  const store = new MemoryQqStore(config)
  let now = beijing('2026-11-12T10:00')
  const admission = new InboundPolicy({ store, now: () => now })
  const [group, privateChat] = config.bindings
  const event = (id, endpoint = group.endpoint, mentions = []) => ({ endpoint, externalMessageId: String(id), senderId: '456', selfId: '789', text: '消息', mentions })
  assert.equal((await admission.decide(event(1), group)).reason, 'PRICE_PEAK_FILTERED')
  assert.equal((await admission.decide(event(2, group.endpoint, ['789']), group)).admitted, true)
  assert.equal((await admission.decide(event(3), group, { senderId: '789' })).admitted, true)
  assert.equal((await admission.decide(event(4, privateChat.endpoint), privateChat)).admitted, true)
  now = beijing('2026-11-12T12:00')
  assert.equal((await admission.decide(event(5), group)).admitted, true)
  assert.equal((await admission.decide(event(1), group)).reason, 'PRICE_PEAK_FILTERED')
})

test('enabling a price schedule replaces the ordinary probability and preserves allowlists', async () => {
  const [binding] = normalizeConfig({ bindings: [{
    endpoint: 'group:123', sessionId: 'group',
    admission: { enabled: true, allowedSenders: ['456'], mentionOnly: false, probability: 0 },
    priceSchedule: { enabled: true, peakProbability: 0, offPeakProbability: 100 },
  }] }).bindings
  const policy = new InboundPolicy({ store: new MemoryQqStore(), now: () => beijing('2026-11-12T12:00') })
  const event = { endpoint: binding.endpoint, externalMessageId: 'one', selfId: '789', senderId: '456', text: '普通消息', mentions: [] }
  assert.equal((await policy.decide(event, binding)).admitted, true)
  assert.equal((await policy.decide({ ...event, externalMessageId: 'two', senderId: '555' }, binding)).reason, 'SENDER_FILTERED')
})
