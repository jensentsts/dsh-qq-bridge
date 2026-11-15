import assert from 'node:assert/strict'
import test from 'node:test'
import { HistoryPoller } from '../lib/polling.mjs'
import { MergeWindow } from '../lib/merge.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { ScheduleTools } from '../lib/schedule-tools.mjs'
import { QzoneTools } from '../lib/qzone.mjs'

const binding = { id: 'one', sessionId: 'session-one', endpoint: 'private:123', enabled: true, sendEnabled: true }
const settings = { enabled: true, windowMs: 500, maxWaitMs: 1000, maxMessages: 8, maxChars: 1000 }
const event = id => ({ externalMessageId: id, text: id, media: [], rich: [] })

test('merge isolates chats, forwards one bounded batch and removes cancelled held input', async () => {
  const batches = []
  const merge = new MergeWindow({ settings: () => settings, ingest: async (events, row) => {
    batches.push({ id: row.id, events: events.map(value => value.externalMessageId) })
    return { state: 'accepted' }
  } })
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await merge.enqueue(event('already-cancelled'), binding, { signal: cancelled.signal })).ignored, true)
  const controller = new AbortController()
  const held = merge.enqueue(event('cancelled'), binding, { signal: controller.signal })
  controller.abort()
  assert.equal((await held).reason, 'CLIENT_ABORTED')
  const first = merge.enqueue(event('a'), binding)
  const second = merge.enqueue(event('b'), binding)
  const other = merge.enqueue(event('c'), { ...binding, id: 'two' })
  await merge.flushAll()
  await Promise.all([first, second, other])
  assert.deepEqual(batches, [{ id: 'one', events: ['a', 'b'] }, { id: 'two', events: ['c'] }])
  await merge.dispose()
})

test('disabling QQ drops held messages before any IO admission', async () => {
  const calls = []
  const config = normalizeConfig({ enabled: true, bindings: [binding], merge: settings })
  const io = { contractVersion: 1, registerTransport: () => () => {}, listBindings: () => [], putBinding: async value => value,
    preload: async () => ({ ready: true }), receive: async request => { calls.push(request); return { state: 'accepted', traceId: 't' } } }
  const bridge = new QqBridge({ io, config, store: new MemoryQqStore(config), onebot: { call() { throw new Error('Unexpected network call') } } })
  await bridge.start()
  const held = bridge.receive({ post_type: 'message', message_type: 'private', user_id: 123, message_id: 1, message: [{ type: 'text', data: { text: 'held' } }] })
  await bridge.save({ ...config, enabled: false })
  assert.equal((await held).reason, 'BRIDGE_DISABLED')
  assert.equal(calls.length, 0)
  await bridge.dispose()
})

test('history polling starts at enable time, singleflights, and resumes its durable watermark', async () => {
  const config = normalizeConfig({ enabled: true, bindings: [binding], polling: { enabled: true } })
  const store = new MemoryQqStore(config), admitted = []
  let now = 100000, history = [{ message_id: 1, time: 99, user_id: 123, message: [] }, { message_id: 2, time: 100, user_id: 123, message: [] }]
  const onebot = { call: async action => action === 'get_login_info' ? { user_id: 999 } : { messages: history } }
  const options = { onebot, store, receive: async message => { admitted.push(message.message_id); return { state: 'accepted' } }, config: () => config, interval: () => () => {}, now: () => now }
  const poller = new HistoryPoller(options)
  await poller.start(config)
  assert.equal(admitted.length, 0)
  const flight = poller.tick()
  assert.equal(poller.tick(), flight)
  await flight
  assert.deepEqual(admitted, [2])
  await poller.dispose()
  now = 102000; history = [{ message_id: 3, time: 101, user_id: 123, message: [] }]
  const restarted = new HistoryPoller(options)
  await restarted.start(config)
  await restarted.tick()
  assert.deepEqual(admitted, [2, 3])
  assert.equal((await store.pollingState(binding.id)).watermark, 101)
  await restarted.dispose()
})

test('group history polling pages through a burst larger than one SnowLuma history page', async () => {
  const group = { ...binding, endpoint: 'group:123' }
  const config = normalizeConfig({ enabled: true, bindings: [group], polling: { enabled: true, count: 10 } })
  const store = new MemoryQqStore(config), admitted = [], cursors = []
  let now = 1000000
  const history = Array.from({ length: 75 }, (_, index) => ({ message_id: index + 1, time: 1001 + index, user_id: 456, message: [{ type: 'text', data: { text: String(index + 1) } }] }))
  const onebot = { async call(action, params) {
    if (action === 'get_login_info') return { user_id: 999 }
    cursors.push(params.message_id)
    const end = params.message_id === undefined ? history.length : history.findIndex(row => row.message_id === params.message_id) + 1
    return { messages: history.slice(Math.max(0, end - params.count), end) }
  } }
  const poller = new HistoryPoller({ onebot, store, receive: async event => { admitted.push(event.message_id); return { state: 'accepted' } }, config: () => config, interval: () => () => {}, now: () => now })
  await poller.start(config); now = 1080000
  try {
    const result = await poller.tick()
    assert.equal(result.polls[0].state, 'ok')
    assert.deepEqual(admitted, history.map(row => row.message_id))
    assert.ok(cursors.some(value => value !== undefined))
  } finally { await poller.dispose() }
})

test('QQ schedule tools stay with their bound conversation', async () => {
  const other = { ...binding, id: 'two', sessionId: 'session-two' }, calls = []
  const service = { create: async (...args) => { calls.push(args); return { id: 'task', ...args[0] } },
    list: async () => ({ items: [{ id: 'foreign', target: { kind: 'session', sessionId: other.sessionId } }] }),
    view: async () => ({ id: 'foreign', target: { kind: 'session', sessionId: other.sessionId } }) }
  const adapter = new ScheduleTools({ schedule: () => service, binding: id => id === binding.id ? binding : other, bindings: () => [binding, other] })
  const tools = new Map(), agent = { session: { id: binding.sessionId } }
  adapter.register(binding, agent, { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } })
  const create = tools.get('qq_schedule_create')
  assert.equal((await create.execute({ title: 'later', prompt: 'hello', kind: 'after', after_seconds: 60, bindingId: other.id }, { agent })).ok, false)
  assert.equal(calls.length, 0)
  assert.equal((await tools.get('qq_schedule_view').execute({ id: 'foreign' }, { agent })).ok, false)
  assert.equal((await create.execute({ title: 'later', prompt: 'hello', kind: 'after', after_seconds: 60 }, { agent })).ok, true)
  assert.deepEqual(calls[0][0].target, { kind: 'session', sessionId: binding.sessionId })
})

test('Qzone writes require both the live send switch and the per-binding action switch', async () => {
  let sendEnabled = false
  const current = { ...binding, qzone: { enabled: true, post: true } }, calls = [], tools = new Map(), agent = {}
  const adapter = new QzoneTools({ binding: () => current, networkEnabled: () => true, sendEnabled: () => sendEnabled,
    onebot: { call: async (action, args) => { calls.push({ action, args }); return {} } } })
  adapter.register(current, agent, { register(definition) { tools.set(definition.name, definition); return () => {} } })
  const post = tools.get('qq_space_post')
  assert.equal((await post.execute({ content: 'hello' }, { agent })).ok, false)
  assert.equal(calls.length, 0)
  sendEnabled = true
  assert.equal((await post.execute({ content: 'hello' }, { agent })).ok, true)
  assert.equal(calls.length, 1)
  current.qzone.post = false
  assert.equal((await post.execute({ content: 'later' }, { agent })).ok, false)
  assert.equal(calls.length, 1)
})
