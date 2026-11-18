import test from 'node:test'
import assert from 'node:assert/strict'
import { QuotaPolicy, quotaTurnFacts } from '../lib/quota-policy.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
const old = { provider: 'p', model: 'old' }, next = { provider: 'p', model: 'next', reasoningEffort: 'high' }
function turn({ local = false, partial = false, tool = false, code = 'QUOTA_EXCEEDED', number = 1 } = {}) {
  const events = [{ type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: { source: local ? { kind: 'user' } : { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId: 'b', externalMessageId: '41' } } }]
  events.push({ type: 'request/header', data: { header: { config: old } } })
  if (partial) events.push({ type: 'assistant/attempt', data: { stream: [{ type: 'text-chunks', texts: ['partial'] }] } })
  if (tool) events.push({ type: 'tool/call', data: { turn: number, name: 'write' } })
  events.push({ type: 'turn/end', data: { turn: number, reason: { kind: 'error', error: { code } } } })
  return events.map((event, seq) => ({ ...event, seq }))
}
async function setup(extra = {}) {
  let current = old, observe, logs = turn(), binding = extra.binding ?? { id: 'b', sessionId: 's', enabled: true, quotaPolicy: { mode: 'next-input', maxSwitches: 1, candidates: [next] } }
  const calls = [], store = extra.store ?? new MemoryQqStore(), agent = { id: 's', status: 'idle', session: { snapshotEvents: () => logs }, model: { current: () => current, select: value => { calls.push(value); current = value } } }
  const options = { resolveAgent: async () => ({ agent }), liveAgent: () => agent, catalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'next', reasoning: { efforts: [{ id: 'high' }] } }] }] }), store, binding: () => binding, notice: extra.notice, watch: (_, fn) => { observe = fn; return () => {} } }
  const policy = new QuotaPolicy(options); await policy.arm(binding)
  return { policy, options, calls, store, binding: () => binding, changeBinding: value => { binding = value }, agent, native: value => { current = value }, logs: value => { logs = value }, observe: event => observe(event), failure: async values => { logs = turn(values); logs.find(event => event.type === 'request/header').data.header.config = current; await observe(logs.at(-1)) } }
}
test('quota facts reject local/mixed sources, partial attempts, tool effects and missing bounded turn start', () => {
  assert.equal(quotaTurnFacts(turn(), 1, 'b').eligible, true)
  for (const flags of [{ local: true }, { partial: true }, { tool: true }]) assert.equal(quotaTurnFacts(turn(flags), 1, 'b').eligible, false)
  assert.equal(quotaTurnFacts(turn().slice(1), 1, 'b').eligible, false)
})
test('quota failure persists pending but selects only before the next distinct idle human input, never replay', async () => {
  const f = await setup(); await f.failure(); assert.equal(f.calls.length, 0); assert.equal((await f.store.quotaResult('b')).state, 'pending')
  await f.policy.beforeInput(f.binding(), '41'); assert.equal(f.calls.length, 0)
  const result = await f.policy.beforeInput(f.binding(), '42'); assert.equal(result.state, 'applied'); assert.equal(result.replay, false); assert.deepEqual(f.calls, [next]); assert.equal((await f.store.quotaResult('b')).used, 1)
  await f.policy.dispose()
})
test('authorization/nonquota errors, partial outputs and local turns never arm fallback', async () => {
  for (const flags of [{ code: 'AUTHENTICATION_FAILED' }, { code: 'INVALID_REQUEST' }, { partial: true }, { tool: true }, { local: true }]) {
    const f = await setup(); await f.failure(flags); await f.policy.beforeInput(f.binding(), '42'); assert.equal(f.calls.length, 0); await f.policy.dispose()
  }
})
test('native changes and cancellation win; running input does not replace captured selection', async () => {
  const f = await setup(); await f.failure(); f.agent.status = 'running'; assert.equal((await f.policy.beforeInput(f.binding(), '42')).state, 'pending'); assert.equal(f.calls.length, 0)
  f.agent.status = 'idle'; f.native({ provider: 'user', model: 'chosen' }); assert.equal((await f.policy.beforeInput(f.binding(), '43')).state, 'native-wins'); assert.equal(f.calls.length, 0)
  const g = await setup(); await g.failure(); await g.policy.cancel('b'); await g.policy.beforeInput(g.binding(), '42'); assert.equal(g.calls.length, 0)
  await f.policy.dispose(); await g.policy.dispose()
})
test('durable switch budget survives restart and selecting ambiguity cannot auto replay', async () => {
  const f = await setup(); await f.failure(); await f.policy.beforeInput(f.binding(), '42'); await f.failure({ number: 2 }); assert.equal((await f.store.quotaResult('b')).state, 'exhausted')
  const replacement = new QuotaPolicy(f.options); await replacement.arm(f.binding()); await replacement.beforeInput(f.binding(), '99'); assert.equal(f.calls.length, 1)
  const record = await f.store.quotaResult('b'); await f.store.recordQuotaResult('b', { ...record, state: 'selecting' })
  const uncertain = new QuotaPolicy(f.options); await uncertain.arm(f.binding()); assert.equal((await uncertain.beforeInput(f.binding(), '100')).state, 'selecting'); assert.equal(f.calls.length, 1)
  await f.policy.dispose(); await replacement.dispose(); await uncertain.dispose()
})

test('balance notices follow a replacement failure and exclude ordinary rate limits', async () => {
  const notices = [], f = await setup({ notice: async value => notices.push(value) })
  await f.failure()
  assert.equal(notices.length, 0)
  await f.policy.beforeInput(f.binding(), '42')
  await f.failure({ number: 2, code: 'RATE_LIMITED' })
  assert.equal(notices.length, 0)
  await f.failure({ number: 3, code: 'INSUFFICIENT_BALANCE' })
  assert.deepEqual(notices.map(row => row.externalMessageId), ['41'])
  await f.policy.dispose()
})

test('a binding without model fallback still observes an actual balance failure', async () => {
  const notices = [], f = await setup({ binding: { id: 'b', sessionId: 's', enabled: true }, notice: async value => notices.push(value) })
  await f.failure({ code: 'QUOTA' })
  await f.failure({ number: 2, code: 'ACCOUNT_QUOTA' })
  await f.failure({ number: 3, code: 'RATE_LIMIT' })
  assert.deepEqual(notices.map(row => row.externalMessageId), ['41', '41'])
  await f.policy.dispose()
})

test('a reused model header from an earlier turn still identifies the failed model', async () => {
  const notices = [], f = await setup({ binding: { id: 'b', sessionId: 's', enabled: true }, notice: async value => notices.push(value) })
  const rows = turn({ code: 'QUOTA', number: 4 })
  const header = rows.splice(2, 1)[0]
  rows.unshift(header)
  rows.forEach((row, seq) => { row.seq = seq })
  f.logs(rows)
  await f.observe(rows.at(-1))
  assert.deepEqual(notices.map(row => row.externalMessageId), ['41'])
  await f.policy.dispose()
})

test('an explicitly selected fallback model also receives a balance notice', async () => {
  const notices = [], f = await setup({ notice: async value => notices.push(value) })
  f.native(next)
  await f.failure({ code: 'QUOTA' })
  assert.deepEqual(notices.map(row => row.externalMessageId), ['41'])
  await f.policy.dispose()
})
