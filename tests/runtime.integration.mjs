import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import * as qq from '../lib/host.js'
import { QqDomainStore } from '../lib/store.mjs'
import storagePlugin from '@deepseek-ai/dsh-storage'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import sessionPlugin from '@deepseek-ai/dsh-session'
import { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { BindingModelPolicy } from '../lib/model-policy.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { QuotaPolicy } from '../lib/quota-policy.mjs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { NativeFeatures, featureTurnFold } from '../lib/native-features.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import SpeechController from '@deepseek-ai/dsh-experimental-api-speech-to-text'
import { InboundAsr } from '../lib/asr.mjs'
import { qqStatusTool } from '../lib/status.mjs'
import { QqGroupAlbums } from '../lib/group-album.mjs'
import { QqOutbox } from '../lib/outbox.mjs'
test('merged QQ steers keep their turn ownership beyond the old sixteen-message limit', () => {
  let state = featureTurnFold.apply(featureTurnFold.init(), { type: 'turn/start', data: { turn: 1 } })
  for (let id = 1; id <= 24; id++) state = featureTurnFold.apply(state, { type: 'user/message', data: { source: { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId: 'group', externalMessageId: String(id) } } })
  assert.equal(state.exclusive, true); assert.equal(state.inputs.length, 24); assert.equal(state.inputs.at(-1), '24')
})
test('a QQ steer arriving before the first input commits keeps the matching turn and rejects a different sender binding', () => {
  const message = bindingId => ({ source: { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId, externalMessageId: '2' } })
  const start = featureTurnFold.apply(featureTurnFold.init(), { type: 'turn/start', data: { turn: 1 } })
  const early = featureTurnFold.apply(start, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [message('b')] } })
  assert.equal(early.exclusive, true); assert.equal(early.bindingId, 'b'); assert.equal(early.inputs.length, 0)
  const committed = featureTurnFold.apply(early, { type: 'user/message', data: { source: { ...message('b').source, externalMessageId: '1' } } })
  assert.equal(committed.exclusive, true); assert.deepEqual(committed.inputs, ['1'])
  const context = featureTurnFold.apply(committed, { type: 'user/message', data: { source: { kind: 'session-reference' } } })
  assert.equal(context.exclusive, true)
  assert.equal(featureTurnFold.apply(early, { type: 'user/message', data: { source: message('other').source } }).exclusive, false)
  assert.equal(featureTurnFold.apply(committed, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ source: { kind: 'user' } }] } }).exclusive, false)
})
const makeDomain = () => {
  let value = structuredClone(qq.domainSpec.global.initial), closed = 0
  const tables = new Map(Object.keys(qq.domainSpec.tables).map(name => [name, new Map()]))
  return { global: { get: () => structuredClone(value), set: async next => { value = qq.domainSpec.global.schema.parse(next) } }, table(name) { const table = tables.get(name); return { get: key => table.get(key), put: async (key, item) => table.set(key, qq.domainSpec.tables[name].valueSchema.parse(item)), get size() { return table.size } } }, close: async () => { closed++ }, closed: () => closed }
}
test('real exact-release Cordis lifecycle mounts isolated domain/routes/transport and removes them without network', async () => {
  const ctx = new Context(), routes = new Map(), registrations = new Set(), ownerTools = new Set(), channelTools = new Set(), domain = makeDomain(); let network = 0
  const originalFetch = globalThis.fetch; globalThis.fetch = () => { network++; throw new Error('No real network') }
  try {
    await ctx.plugin(Timer); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolsService); await ctx.plugin(NativeToolExecutor)
    ctx.provide('superAgentIo', { contractVersion: 1, registerTransport: transport => { registrations.add(transport); return () => registrations.delete(transport) }, registerOwnerTool: definition => { ownerTools.add(definition.name); return () => ownerTools.delete(definition.name) }, registerChannelTool: definition => { channelTools.add(definition.name); const stop = ctx.tools.register(definition); return () => { stop(); channelTools.delete(definition.name) } }, putBinding: async b => b, listBindings: () => [], preload: async () => ({ ready: true }) })
    ctx.provide('storageDomain', { open: async spec => { assert.equal(spec.name, 'qq_bridge_001'); assert.equal(spec.global.schema.safeParse({ enabled: true, bindings: [] }).success, true); return domain } })
    ctx.provide('webServer', { register: route => { assert.ok(route.path.startsWith('/dsh-qq-bridge-001/')); assert.equal(routes.has(route.path), false); routes.set(route.path, route); return () => routes.delete(route.path) } })
    ctx.provide('connection', { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
    ctx.provide('credentials', { readRecord: async () => undefined })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessionController', { resolveAgent: async () => ({ error: new Error('notfound') }), modelCatalog: async () => ({ groups: [] }) })
    const fiber = ctx.plugin(qq, { networkAccess: false }); await fiber
    assert.equal(registrations.size, 1); assert.ok(routes.has('/dsh-qq-bridge-001/state')); assert.ok(ownerTools.has('qq_albums')); assert.ok(ownerTools.has('qq_album_upload')); assert.ok(channelTools.has('qq_buffer')); assert.ok(channelTools.has('qq_outbox')); assert.equal(network, 0)
    assert.ok(ctx.tools.get('qq_buffer')); assert.ok(ctx.tools.get('qq_outbox'))
    let status, data
    await routes.get('/dsh-qq-bridge-001/state').handler({ method: 'GET', headers: {} }, { writeHead(code) { status = code }, end(raw) { data = JSON.parse(raw) } })
    assert.equal(status, 200); assert.equal(data.config.enabled, false); assert.equal(data.networkEnabled, false); assert.equal(data.credentials.onebot, false)
    await fiber.dispose(); assert.equal(routes.size, 0); assert.equal(registrations.size, 0); assert.equal(ownerTools.size, 0); assert.equal(channelTools.size, 0); assert.equal(domain.closed(), 1); assert.equal(network, 0)
    assert.equal(ctx.tools.get('qq_buffer'), undefined); assert.equal(ctx.tools.get('qq_outbox'), undefined)
  } finally { globalThis.fetch = originalFetch; await ctx.fiber.dispose() }
})
test('exact storageDomain validates legal unit name and persists fork configuration/sidecars', async () => {
  const ctx = new Context(), snapshots = new Map()
  try {
    await ctx.plugin(storagePlugin)
    ctx.storage.backend.register('qq-test', { kv: { open: async descriptor => {
      assert.match(descriptor.name, /^[a-z][a-z0-9_]*$/)
      const state = snapshots.get(descriptor.name) ?? { tables: {}, global: null }; snapshots.set(descriptor.name, state)
      return { loadAll: async () => structuredClone(state), putRecord: async (table, key, value) => { state.tables[table] ??= {}; state.tables[table][key] = structuredClone(value) }, deleteRecord: async (table, key) => { delete state.tables[table]?.[key] }, deleteRecords: async (table, keys) => { keys.forEach(key => delete state.tables[table]?.[key]) }, setGlobal: async value => { state.global = structuredClone(value) }, close: async () => {} }
    } } })
    ctx.provide('storage.backend.qq-test', {})
    await ctx.plugin(storageDomainPlugin, { backend: 'qq-test' })
    const domain = await ctx.storageDomain.open(qq.domainSpec)
    const store = new QqDomainStore(domain)
    await store.setConfig({ enabled: false, bindings: [] })
    await store.recordDelivery('d', { state: 'unknown', reason: 'TIMEOUT' })
    assert.equal(store.config().sendEnabled, false)
    assert.equal(snapshots.get('qq_bridge_001').tables.deliveries.d.state, 'unknown')
    await domain.close()
  } finally { await ctx.fiber.dispose() }
})
test('binding model+effort uses real AgentModel and native durable model/selection without changing global default', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(sessionPlugin)
    const session = ctx.sessions.create('model-policy-native')
    const state = () => session.snapshotEvents().reduce((value, event) => modelSelectionProjectionDefinition.apply(value, event), modelSelectionProjectionDefinition.init())
    const agent = { id: session.id, status: 'idle', model: new AgentModel(state, session, { provider: 'p', model: 'old' }) }
    const binding = { id: 'b', sessionId: session.id, enabled: true, modelPolicy: 'binding-once', modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
    const policy = new BindingModelPolicy({ resolveAgent: async () => ({ agent }), catalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'high' }] } }] }] }), store: new MemoryQqStore(), binding: () => binding })
    assert.equal((await policy.prepare(binding)).state, 'applied')
    const committed = session.snapshotEvents().find(event => event.type === 'model/selection')
    assert.equal(committed.data.model, 'm'); assert.equal(committed.data.reasoningEffort, 'high')
    assert.deepEqual(agent.model.current(), binding.modelSelection)
    await policy.dispose()
    const store = new MemoryQqStore(), write = store.recordModelResult.bind(store)
    store.recordModelResult = (id, value) => value.state === 'applied' ? Promise.reject(new Error('disk failed')) : write(id, value)
    const next = { ...binding, id: 'failing-confirmation', modelRevision: 1 }
    const second = new BindingModelPolicy({ resolveAgent: async () => ({ agent }), catalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'high' }] } }] }] }), store, binding: () => next })
    const applied = await second.prepare(next); assert.equal(applied.state, 'applied'); assert.equal(applied.durable, false)
    const count = session.snapshotEvents().filter(event => event.type === 'model/selection').length
    await second.prepare(next); assert.equal(session.snapshotEvents().filter(event => event.type === 'model/selection').length, count)
    assert.deepEqual(agent.model.current(), next.modelSelection); assert.equal((await store.modelResult(next.id)).state, 'selecting')
    await second.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('quota next-input switch uses native model/selection without replaying failed canonical turn', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(sessionPlugin)
    const session = ctx.sessions.create('quota-native'), events = () => session.snapshotEvents(), state = () => events().reduce((value, event) => modelSelectionProjectionDefinition.apply(value, event), modelSelectionProjectionDefinition.init())
    const agent = { id: session.id, status: 'idle', session, model: new AgentModel(state, session, { provider: 'p', model: 'old' }) }
    const binding = { id: 'b', sessionId: session.id, enabled: true, quotaPolicy: { mode: 'next-input', maxSwitches: 1, candidates: [{ provider: 'p', model: 'next', reasoningEffort: 'high' }] } }
    let observe
    const store = new MemoryQqStore(), policy = new QuotaPolicy({ resolveAgent: async () => ({ agent }), liveAgent: () => agent, store, binding: () => binding, catalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'next', reasoning: { efforts: [{ id: 'high' }] } }] }] }), watch: (_, fn) => { observe = fn; return () => {} } })
    await policy.arm(binding)
    session.append('turn/start', { turn: 1 }); session.append('user/message', { id: 'u', role: 'user', source: { kind: 'super-agent-io', version: 1, transport: 'qq-bridge-001', bindingId: 'b', endpoint: 'private:123', traceId: 't', externalMessageId: '41' }, content: [{ type: 'text', text: 'failed first input' }] }, { surfaceOp: 'append' })
    session.append('request/header', { header: { config: { provider: 'p', model: 'old' } }, reason: 'initial' })
    const error = session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA_EXCEEDED', message: 'quota' } } }); await observe(error)
    assert.equal(agent.model.current().model, 'old'); assert.equal((await store.quotaResult('b')).state, 'pending')
    const result = await policy.beforeInput(binding, '42'); assert.equal(result.state, 'applied'); assert.equal(agent.model.current().model, 'next')
    assert.equal(events().filter(event => event.type === 'user/message').length, 1); assert.equal(events().filter(event => event.type === 'assistant/message').length, 0)
    assert.equal(events().filter(event => event.type === 'model/selection').length, 1); assert.equal((await store.quotaResult('b')).used, 1)
    await policy.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('persona and reply gate use real native scoped registries, exclusive QQ facts and effect cleanup', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(sessionPlugin); await ctx.plugin(SystemPrompt, {}); await ctx.plugin(ToolsService); await ctx.plugin(NativeToolExecutor)
    const session = ctx.sessions.create('native-features'), agent = { id: session.id, session, status: 'idle' }; let scope
    await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent); agent.ctx = scope.ctx }, { inject: ['tools', 'systemPrompt'] }))
    const binding = normalizeConfig({ bindings: [{ endpoint: 'group:456', sessionId: session.id, enabled: true, persona: { enabled: true, text: 'Literal {{variable}} persona' }, replyGate: { enabled: true, conclude: true } }] }).bindings[0]
    const store = new MemoryQqStore(), projection = { stateOf: () => session.snapshotEvents().reduce(featureTurnFold.apply, featureTurnFold.init()) }
    // Native handles return reference-stable states; this fixture memoizes the fold at the actual log sequence.
    let foldedAt = -1, facts
    projection.stateOf = () => { if (foldedAt !== session.seq) { foldedAt = session.seq; facts = session.snapshotEvents().reduce(featureTurnFold.apply, featureTurnFold.init()) }; return facts }
    let liveBinding = binding
    const features = new NativeFeatures({ resolveAgent: async () => ({ agent }), liveAgent: () => agent, binding: () => liveBinding, store, projection })
    let statusText = '当前 QQ 账号已离线。'
    const statusBridge = { config: { baseUrl: 'http://127.0.0.1:3000' }, statusTarget: () => liveBinding, sendTarget: () => liveBinding,
      qqStatus: { async read() { return { account: { online: false }, reason: 'QQ_ACCOUNT_OFFLINE', canSend: false } } } }
    features.statusTool = (row, allowed) => qqStatusTool(statusBridge, row, allowed)
    features.statusText = row => row.endpoint === binding.endpoint ? statusText : '新绑定的 QQ 群状态正常。'
    features.groupAlbums = new QqGroupAlbums(statusBridge, { projection })
    features.outbox = new QqOutbox(statusBridge, { projection })
    await features.prepare(binding)
    const assembly = await ctx.systemPrompt.assemble({ scope: agent }); assert.ok(assembly.sections.some(section => section.text === binding.persona.text && section.interpolate === false)); assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.text === binding.persona.text), false)
    assert.ok(assembly.sections.some(section => section.text === statusText))
    assert.ok(assembly.sections.some(section => section.text.includes('qq_group_album_upload')))
    assert.equal(ctx.tools.get('qq_group_albums'), undefined)
    assert.ok(ctx.tools.get('qq_group_albums', agent)); assert.ok(ctx.tools.get('qq_group_album_upload', agent))
    assert.equal(ctx.tools.get('qq_buffer'), undefined); assert.ok(ctx.tools.get('qq_buffer', agent))
    assert.equal(ctx.tools.get('qq_chat_status'), undefined)
    const statusTool = ctx.tools.get('qq_chat_status', agent)
    assert.equal(JSON.parse((await statusTool.execute({}, { agent, signal: new AbortController().signal })).text).reason, 'QQ_ACCOUNT_OFFLINE')
    statusText = '当前 QQ 账号在本群被禁言。'
    assert.ok((await ctx.systemPrompt.assemble({ scope: agent })).sections.some(section => section.text === statusText))
    assert.equal(ctx.tools.get('qq_reply_gate'), undefined); const gate = ctx.tools.get('qq_reply_gate', agent); assert.ok(gate)
    session.append('turn/start', { turn: 1 }); session.append('user/message', { id: 'u', role: 'user', source: { kind: 'super-agent-io', version: 1, transport: 'qq-bridge-001', bindingId: binding.id, endpoint: binding.endpoint, traceId: 't', externalMessageId: '1' }, content: [{ type: 'text', text: 'unrelated' }] }, { surfaceOp: 'append' })
    await store.recordAdmissionResult(JSON.stringify([binding.id, '1']), { admitted: true, mentioned: false, at: 1 })
    let concluded = 0; const answer = await gate.execute({ reply: false }, { agent, signal: new AbortController().signal, concludeTurn: () => { concluded++ } })
    assert.equal(answer.code, 'QQ_REPLY_SUPPRESSED'); assert.equal(concluded, 1); assert.equal(await features.allowDelivery(binding, { turn: 1 }), false)
    session.append('user/message', { id: 'local', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'local input' }] }, { surfaceOp: 'append' })
    assert.equal((await gate.execute({ reply: false }, { agent, signal: new AbortController().signal })).code, 'NOT_EXCLUSIVE_QQ_TURN')
    liveBinding = { ...binding, endpoint: 'group:789' }
    await features.reconcile([liveBinding]); await features.prepare(liveBinding)
    const rebound = await ctx.systemPrompt.assemble({ scope: agent })
    assert.ok(rebound.sections.some(section => section.text === '新绑定的 QQ 群状态正常。'))
    assert.equal(rebound.sections.some(section => section.text === statusText), false)
    await features.dispose(); assert.equal(ctx.tools.get('qq_reply_gate', agent), undefined); assert.equal((await ctx.systemPrompt.assemble({ scope: agent })).sections.some(section => section.text === binding.persona.text), false)
    assert.equal(ctx.tools.get('qq_chat_status', agent), undefined)
    assert.equal(ctx.tools.get('qq_group_albums', agent), undefined); assert.equal(ctx.tools.get('qq_group_album_upload', agent), undefined)
    assert.equal(ctx.tools.get('qq_buffer', agent), undefined)
    await scope.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('ASR invokes real native speechController WAV/selection validation without preparation or Agent events', async () => {
  const ctx = new Context()
  try {
    const speech = new SpeechToText(ctx, SpeechToText.Config({ defaultProvider: 'local', language: 'auto' })); let recognizes = 0
    speech.register({ info: { id: 'local', name: 'local fixture', location: 'host-local', languages: ['auto'] }, transcribe: async () => { recognizes++; return { text: '原生转录', audioSeconds: .001, inferenceSeconds: .01 } } })
    const controller = new SpeechController(ctx, { maxAudioBytes: 1024, maxDurationSeconds: 1 }), store = new MemoryQqStore()
    const bytes = Buffer.alloc(76); bytes.write('RIFF'); bytes.writeUInt32LE(68, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32, 40)
    const asr = new InboundAsr({ controller, store, allowed: () => true, onebot: { call: async () => ({ base64: bytes.toString('base64') }) }, attachments: { saveFile: async input => ({ attachmentId: 'native-file', bytes: input.data.length, name: input.name }) } })
    const config = normalizeConfig({ asr: { enabled: true, providerId: 'local' } }), input = { config, bindingId: 'b', externalMessageId: '1', index: 0 }
    const content = await asr.admit({ file: 'voice.silk' }, input); assert.ok(content[1].text.includes('原生转录')); assert.equal(recognizes, 1)
    bytes.writeUInt16LE(2, 22); const bad = await asr.admit({ file: 'voice.silk' }, { ...input, externalMessageId: '2' }); assert.ok(bad[1].text.includes('不可用')); assert.equal(recognizes, 1)
    await asr.dispose()
  } finally { await ctx.fiber.dispose() }
})
test('production durable schemas reject malformed settings and delivery generations', () => {
  assert.equal(qq.domainSpec.global.schema.safeParse({ bindings: [{ endpoint: 'group:1', sessionId: 's' }, { endpoint: 'group:2', sessionId: 's' }] }).success, false)
  assert.equal(qq.domainSpec.tables.deliveries.valueSchema.safeParse({ version: 1, state: 'unknown', reason: 'TIMEOUT' }).success, true)
  assert.equal(qq.domainSpec.tables.deliveries.valueSchema.safeParse({ version: 2, state: 'delivered' }).success, false)
})
