/** Test-only external transport, credentials and persistence medium; native Cordis/Session/IO remain real. */
export const name = 'qq-fixture-external'
export const inject = ['storage', 'sessions', 'agents']
export async function apply(ctx) {
  const snapshots = new Map(), routes = new Map(), credentials = new Map(), tools = new Map(), input = []
  ctx.storage.backend.register('qq-fixture', { kv: { async open(descriptor) {
    const state = snapshots.get(descriptor.name) ?? { tables: {}, global: null }; snapshots.set(descriptor.name, state)
    return { loadAll: async () => structuredClone(state), putRecord: async (table, key, value) => { state.tables[table] ??= {}; state.tables[table][key] = structuredClone(value) }, deleteRecord: async (table, key) => { delete state.tables[table]?.[key] }, deleteRecords: async (table, keys) => { keys.forEach(key => delete state.tables[table]?.[key]) }, setGlobal: async value => { state.global = structuredClone(value) }, close: async () => {} }
  } } })
  ctx.provide('storage.backend.qq-fixture', {})
  ctx.provide('webServer', { register(route) { if (routes.has(route.path)) throw new Error('Duplicate fixture route'); routes.set(route.path, route); return () => routes.delete(route.path) } })
  ctx.provide('connection', { requestRejection: req => req.headers['x-fixture-deny'] ? 401 : undefined, admit: req => ({ peer: { principal: { kind: req.headers['x-fixture-guest'] ? 'fixture-guest' : 'owner' } } }) })
  ctx.provide('credentials', { readRecord: async key => credentials.get(key), modifyRecord: async (key, fn) => { const value = await fn(credentials.get(key)); credentials.set(key, value); return value }, deleteRecord: async key => credentials.delete(key) })
  ctx.provide('tools', { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } })
  const session = ctx.sessions.create('qq-fixture-session')
  const agent = { id: session.id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup(message) { input.push(message); this.inbox.nextTurn.push(message); session.append('agent/inbox/spliced', { target: 'next-turn', start: this.inbox.nextTurn.length - 1, inserted: [message] }) }, steer(message) { input.push(message); this.inbox.nextStep.push(message); session.append('agent/inbox/spliced', { target: 'next-step', start: this.inbox.nextStep.length - 1, inserted: [message] }) }, cancel() { this.cancelled = true } }
  await ctx.agents.register(agent)
  ctx.provide('sessionController', { modelCatalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts: [{ id: 'high' }] } }] }] }), resolveAgent: async id => id === session.id ? { agent } : { error: Object.assign(new Error('notfound'), { code: 'session/not-found' }) } })
  ctx.provide('sessionQuery', { observeSession: async id => ({ events: ctx.sessions.get(id).snapshotEvents(), [Symbol.dispose]() {} }), readEvent: async ({ sessionId, seq, before, after }) => ({ events: ctx.sessions.get(sessionId).snapshotEvents().slice(Math.max(0, seq - before), seq + after + 1) }) })
  ctx.provide('sessionPersistence', { flush: async () => {} })
  ctx.provide('qqFixture', { snapshots, routes, credentials, tools, input, session, agent })
}
