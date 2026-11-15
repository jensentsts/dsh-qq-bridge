/** External transport/storage/recognizer only; official Loader, speech/IO/Session/projections/prompt/tools stay real. */
import { createHash } from 'node:crypto'
import { createScope } from '@deepseek-ai/dsh-scope'
import SpeechController from '@deepseek-ai/dsh-experimental-api-speech-to-text'
export const name = 'qq-features-fixture-external'
export const inject = ['storage', 'sessions', 'agents', 'speechToText', 'tools', 'systemPrompt']
export async function apply(ctx) {
  const snapshots = new Map(), routes = new Map(), credentials = new Map(), input = [], files = new Map(); let recognitions = 0
  ctx.storage.backend.register('qq-features-fixture', { kv: { async open(descriptor) {
    const state = snapshots.get(descriptor.name) ?? { tables: {}, global: null }; snapshots.set(descriptor.name, state)
    return { loadAll: async () => structuredClone(state), putRecord: async (table, key, value) => { state.tables[table] ??= {}; state.tables[table][key] = structuredClone(value) }, deleteRecord: async (table, key) => { delete state.tables[table]?.[key] }, deleteRecords: async (table, keys) => { keys.forEach(key => delete state.tables[table]?.[key]) }, setGlobal: async value => { state.global = structuredClone(value) }, close: async () => {} }
  } } }); ctx.provide('storage.backend.qq-features-fixture', {})
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
  ctx.provide('connection', { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) })
  ctx.provide('credentials', { readRecord: async key => credentials.get(key), modifyRecord: async (key, fn) => { const value = await fn(credentials.get(key)); credentials.set(key, value); return value }, deleteRecord: async key => credentials.delete(key) })
  ctx.provide('attachments', { async saveFile({ data, name }) { const attachmentId = createHash('sha256').update(data).digest('hex'); files.set(attachmentId, Buffer.from(data)); return { attachmentId, name, bytes: data.length } } })
  const offRecognizer = ctx.speechToText.register({ info: { id: 'qq-local-fixture', name: 'fixture local recognizer', location: 'host-local', languages: ['auto'] }, transcribe: async () => { recognitions++; return { text: 'fixture ASR text', audioSeconds: .001, inferenceSeconds: .01 } } })
  ctx.effect(() => offRecognizer)
  new SpeechController(ctx, { maxAudioBytes: 1024, maxDurationSeconds: 1 })
  const session = ctx.sessions.create('qq-features-fixture-session')
  const agent = { id: session.id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup(message) { input.push(message); this.inbox.nextTurn.push(message); session.append('agent/inbox/spliced', { target: 'next-turn', start: this.inbox.nextTurn.length - 1, inserted: [message] }) }, steer(message) { input.push(message); this.inbox.nextStep.push(message); session.append('agent/inbox/spliced', { target: 'next-step', start: this.inbox.nextStep.length - 1, inserted: [message] }) }, cancel() {} }
  const scope = createScope(ctx, agent); agent.ctx = scope.ctx; ctx.effect(() => () => scope.dispose())
  await ctx.agents.register(agent)
  ctx.provide('sessionController', { modelCatalog: async () => ({ groups: [] }), resolveAgent: async id => id === session.id ? { agent } : { error: new Error('notfound') } })
  ctx.provide('sessionQuery', { observeSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents(), [Symbol.dispose]() {} }), readEvent: async ({ sessionId, seq, before, after }) => ({ events: ctx.sessions.get(sessionId).snapshotEvents().slice(Math.max(0, seq - before), seq + after + 1) }) })
  ctx.provide('sessionPersistence', { flush: async () => {} })
  ctx.provide('qqFeaturesFixture', { snapshots, routes, credentials, input, files, session, agent, recognitions: () => recognitions })
}
