import test from 'node:test'
import assert from 'node:assert/strict'
import { BindingModelPolicy, validateSelection, planQuotaFallback, classifyModelFailure } from '../lib/model-policy.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
const selected = { provider: 'p', model: 'm', reasoningEffort: 'high' }, old = { provider: 'p', model: 'old' }
const catalog = { groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'high' }] } }, { id: 'old' }] }] }
async function setup({ status = 'idle', current = old, mode = 'binding-once' } = {}) {
  const store = new MemoryQqStore(), calls = []; let handler, offCount = 0
  let binding = { id: 'b', sessionId: 's', enabled: true, modelSelection: selected, modelPolicy: mode }
  const agent = { id: 's', status, model: { current: () => current, select: value => { calls.push(value); current = value } } }
  const policy = new BindingModelPolicy({ resolveAgent: async () => ({ agent }), catalog: async () => catalog, store, binding: () => binding, watch: (_, handlers) => { handler = handlers; return () => { offCount++ } } })
  return { policy, store, calls, agent, binding: () => binding, changeBinding: value => { binding = value }, nativeSelect: value => { current = value }, stopping: signal => handler.stopping(signal), offCount: () => offCount }
}
test('model/effort validates exact live catalog, rejects stale selection', () => {
  assert.deepEqual(validateSelection(catalog, selected), selected)
  assert.throws(() => validateSelection(catalog, { ...selected, model: 'gone' }), { code: 'MODEL_NOT_ROUTABLE' })
  assert.throws(() => validateSelection(catalog, { ...selected, reasoningEffort: 'impossible' }), { code: 'EFFORT_NOT_SUPPORTED' })
})
test('explicit binding-once applies native model+effort while idle and persists exactly once', async () => {
  const f = await setup(); assert.equal((await f.policy.prepare(f.binding())).state, 'applied'); assert.deepEqual(f.calls, [selected]); assert.equal((await f.store.modelResult('b')).state, 'applied')
  f.nativeSelect(old); await f.policy.prepare(f.binding()); assert.equal(f.calls.length, 1)
  await f.policy.dispose()
})
test('default native-wins never overrides an existing different native selection', async () => {
  const f = await setup({ mode: 'native-wins' }); assert.equal((await f.policy.prepare(f.binding())).state, 'native-wins'); assert.equal(f.calls.length, 0); await f.policy.dispose()
})
test('busy retains captured selection until unprepared boundary; user native changes after arming win', async () => {
  const f = await setup({ status: 'running' }); assert.equal((await f.policy.prepare(f.binding())).state, 'pending'); assert.equal(f.calls.length, 0)
  assert.equal((await f.store.modelResult('b')).state, 'pending')
  await f.stopping(new AbortController().signal); assert.equal(f.calls.length, 1)
  const g = await setup({ status: 'running' }); await g.policy.prepare(g.binding()); g.nativeSelect({ provider: 'p', model: 'user-choice' }); await g.stopping(new AbortController().signal)
  assert.equal(g.calls.length, 0); assert.equal(g.policy.snapshot()[0].state, 'native-wins')
  await f.policy.dispose(); await g.policy.dispose()
})
test('cancelled, disabled or rebound policy cannot select a stale running Agent', async () => {
  const f = await setup({ status: 'running' }); await f.policy.prepare(f.binding()); await f.policy.cancel('b'); await f.stopping(new AbortController().signal); assert.equal(f.calls.length, 0)
  const g = await setup({ status: 'running' }); await g.policy.prepare(g.binding()); g.changeBinding({ ...g.binding(), enabled: false }); await g.stopping(new AbortController().signal); assert.equal(g.calls.length, 0)
  const h = await setup({ status: 'running' }); await h.policy.prepare(h.binding()); const abort = new AbortController(); abort.abort(); await h.stopping(abort.signal); assert.equal(h.calls.length, 0)
  await f.policy.dispose(); await g.policy.dispose(); await h.policy.dispose()
})
test('cancellation while resolving cannot arm a late pending model application', async () => {
  let resolve; const gate = new Promise(done => { resolve = done }), store = new MemoryQqStore(), calls = []
  const binding = { id: 'b', sessionId: 's', enabled: true, modelSelection: selected, modelPolicy: 'binding-once' }
  const agent = { id: 's', status: 'idle', model: { current: () => old, select: value => calls.push(value) } }
  const policy = new BindingModelPolicy({ resolveAgent: () => gate, catalog: async () => catalog, store, binding: () => binding })
  const pending = policy.prepare(binding); await policy.cancel('b'); resolve({ agent }); await pending
  assert.equal(calls.length, 0); assert.equal(policy.snapshot()[0].state, 'cancelled'); await policy.dispose()
})
test('busy boundary revalidates catalog and native selection after awaited lookup', async () => {
  let modelCatalog = catalog, callback, current = old, resolver
  const store = new MemoryQqStore(), calls = [], binding = { id: 'b', sessionId: 's', enabled: true, modelSelection: selected, modelPolicy: 'binding-once' }
  const agent = { id: 's', status: 'running', model: { current: () => current, select: value => calls.push(value) } }
  const policy = new BindingModelPolicy({ resolveAgent: async () => ({ agent }), catalog: async () => modelCatalog, store, binding: () => binding, watch: (_, handlers) => { callback = handlers.stopping; return () => {} } })
  await policy.prepare(binding); modelCatalog = { groups: [] }; assert.equal((await callback(new AbortController().signal)).state, 'failed'); assert.equal(calls.length, 0)
  await policy.dispose()
  const g = await setup({ status: 'running' }); await g.policy.prepare(g.binding())
  g.policy.catalog = () => new Promise(resolve => { resolver = resolve })
  const pending = g.stopping(new AbortController().signal); await Promise.resolve(); await Promise.resolve(); g.nativeSelect({ provider: 'user', model: 'selected' }); resolver(catalog)
  assert.equal((await pending).state, 'native-wins'); assert.equal(g.calls.length, 0); await g.policy.dispose()
})
test('native select success with failed sidecar confirmation remains applied and never auto-replays', async () => {
  const f = await setup(), put = f.store.recordModelResult.bind(f.store)
  f.store.recordModelResult = async (id, record) => { if (record.state === 'applied') throw new Error('disk failure'); return put(id, record) }
  const result = await f.policy.prepare(f.binding()); assert.equal(result.state, 'applied'); assert.equal(result.durable, false); assert.equal(f.calls.length, 1)
  await f.policy.prepare(f.binding()); assert.equal(f.calls.length, 1); assert.equal((await f.store.modelResult('b')).state, 'selecting')
  const replacement = new BindingModelPolicy({ resolveAgent: async () => ({ agent: f.agent }), catalog: async () => catalog, store: f.store, binding: f.binding })
  assert.equal((await replacement.prepare(f.binding())).state, 'unknown'); assert.equal(f.calls.length, 1)
  await f.policy.dispose(); await replacement.dispose()
})
test('fallback classifies explicit quota only and never replays captured/partial/tool-effect requests', () => {
  assert.equal(classifyModelFailure({ code: 'QUOTA_EXCEEDED' }), 'quota'); assert.equal(classifyModelFailure({ status: 429 }), 'rate-limit'); assert.equal(classifyModelFailure({ message: 'quota exceeded' }), 'other')
  const input = { failure: { code: 'QUOTA_EXCEEDED' }, boundary: 'fresh-turn', candidates: [selected] }
  assert.equal(planQuotaFallback(input).reason, 'FALLBACK_DISABLED')
  assert.equal(planQuotaFallback({ ...input, enabled: true, boundary: 'same-step-retry' }).reason, 'SELECTION_ALREADY_CAPTURED')
  for (const extra of [{ partialOutput: true }, { toolEffects: true }, { cancelled: true }]) assert.equal(planQuotaFallback({ ...input, enabled: true, ...extra }).action, 'stop')
  assert.deepEqual(planQuotaFallback({ ...input, enabled: true }), { action: 'select-for-next-boundary', selection: selected, replay: false })
})
