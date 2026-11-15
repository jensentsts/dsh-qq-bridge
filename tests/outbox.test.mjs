import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { QqHistoryTools } from '../lib/history-tool.mjs'

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const text = value => [{ type: 'text', text: value }]
const reply = (sessionId, content) => ({ version: 1, sessionId, seq: 2, messageId: 'm1', turn: 1, step: 1, time: 1, source: { kind: 'model', provider: 'p', model: 'm' }, content })

async function fixture({ typingWait = async () => {}, confirmTypingClock = false } = {}) {
  const config = normalizeConfig({ enabled: true, sendEnabled: true, replyQuietMs: 0, bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, sendEnabled: true }], merge: { enabled: true, windowMs: 3000 } })
  const binding = config.bindings[0], facts = { active: true, exclusive: true, bindingId: binding.id, turn: 1, inputs: ['123'] }
  const modelEvent = { seq: 2, type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'call-1', name: 'qq_buffer', arguments: '{}' }] } } }
  const agent = { id: 's', session: { snapshotEvents: () => [modelEvent] }, inbox: { nextStep: [], nextTurn: [] } }, registered = new Map(), calls = [], reconciled = []
  const io = { contractVersion: 1, registerTransport(t) { this.transport = t; return () => {} }, listBindings: () => [], putBinding: async value => value, preload: async () => ({ ready: true }), receive: async () => ({ state: 'accepted' }), flushOutbound: async () => {}, updateBuffered: async (id, update) => { reconciled.push({ id, ...update }) } }
  const store = new MemoryQqStore(config), projection = { stateOf: () => facts }
  const bridge = new QqBridge({ io, store, config, typingWait, confirmTypingClock, nativeFeatures: { projection, reconcile: async () => {}, prepare: async () => {}, dispose: async () => {}, allowDelivery: async () => true }, onebot: { async call(action, params) { calls.push({ action, params }); return { message_id: calls.length } } } })
  await bridge.start()
  bridge.outbox.register(binding, agent, { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) } }, () => true)
  let callId = 1
  const exec = () => { const id = 'call-' + callId++; modelEvent.data.message.content[0].id = id; return { agent, callId: id, signal: new AbortController().signal } }
  const buffer = (args, context = exec()) => registered.get('qq_buffer').execute(args, context)
  const delivery = (id, content = text(id)) => ({ deliveryId: id, bindingId: binding.id, endpoint: binding.endpoint, reply: reply('s', content), traceIds: [], replyTo: '123' })
  return { bridge, store, binding, agent, facts, calls, io, buffer, delivery, exec, reconciled, modelEvent }
}

test('typing timer asks the agent to decide again before any QQ message is sent', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    let messages = [{ messageId: '123', text: '原来的话题' }]
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages }) }) }
    const draft = await f.buffer({ action: 'append', text: '准备回复' })
    const before = await f.buffer({ action: 'send', id: draft.id })
    messages = [...messages, { messageId: '124', text: '补充一句新消息' }]
    const clock = await f.buffer({ action: 'send', id: draft.id, reviewId: before.reviewId, background: false })
    assert.equal(clock.code, 'QQ_TYPING_CONFIRM')
    assert.equal(clock.readyAfterTyping, true)
    assert.equal(clock.timeline.at(-2).text, '补充一句新消息')
    assert.equal(f.calls.length, 0)
    const item = (await f.buffer({ action: 'read', id: draft.id })).items[0]
    assert.equal(item.state, 'draft'); assert.equal(item.needsReview, true)
    const sent = await f.buffer({ action: 'send', id: draft.id, reviewId: clock.reviewId })
    assert.equal(sent.ok, true); assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('a clock decision cannot accidentally send the other staged drafts', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages: [] }) }) }
    const first = await f.buffer({ action: 'append', text: '第一句' })
    const second = await f.buffer({ action: 'append', text: '另一句' })
    const preview = await f.buffer({ action: 'send' })
    const clock = await f.buffer({ action: 'send', reviewId: preview.reviewId, background: false })
    assert.equal(clock.code, 'QQ_TYPING_CONFIRM'); assert.equal(clock.id, first.id)
    assert.deepEqual(clock.remainingDraftIds, [second.id]); assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'send', id: first.id, reviewId: clock.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
    assert.equal((await f.buffer({ action: 'read', id: second.id })).items[0].state, 'draft')
  } finally { await f.bridge.dispose() }
})

test('plain multiline text gets a separate clock and decision for each QQ message', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages: [] }) }) }
    const draft = await f.buffer({ action: 'append', text: '第一句\n第二句\n\n第三句' })
    assert.equal(draft.ids.length, 3)
    const preview = await f.buffer({ action: 'send' })
    const clock = await f.buffer({ action: 'send', reviewId: preview.reviewId, background: false })
    assert.equal(clock.id, draft.ids[0]); assert.deepEqual(clock.remainingDraftIds, draft.ids.slice(1))
    assert.equal((await f.buffer({ action: 'send', id: clock.id, reviewId: clock.reviewId })).ok, true)
    assert.deepEqual(f.calls.map(call => call.params.message.find(part => part.type === 'text').data.text), ['第一句'])
    const rest = await f.buffer({ action: 'read' })
    assert.deepEqual(rest.items.map(item => item.state), ['sent', 'draft', 'draft'])
    const next = await f.buffer({ action: 'send', id: draft.ids[1] })
    const secondClock = await f.buffer({ action: 'send', id: draft.ids[1], reviewId: next.reviewId, background: false })
    assert.equal(secondClock.code, 'QQ_TYPING_CONFIRM'); assert.equal(f.calls.length, 1)
    assert.equal((await f.buffer({ action: 'clear', id: draft.ids[1] })).removed, 1)
    assert.equal((await f.buffer({ action: 'clear', id: draft.ids[2] })).removed, 1)
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('automatic multiline replies stage distinct drafts without duplicating them on replay', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    const delivery = f.delivery('auto-multiline', text('一\n二\n三'))
    assert.equal((await f.bridge.deliver(delivery)).state, 'buffered')
    assert.equal((await f.bridge.deliver(delivery)).state, 'buffered')
    const box = await f.store.outbox(f.binding.id)
    assert.deepEqual(box.entries.map(item => item.delivery.reply.content[0].text), ['一', '二', '三'])
    await f.buffer({ action: 'clear', id: 'auto-multiline' })
    await f.bridge.deliver(delivery)
    const after = await f.store.outbox(f.binding.id)
    assert.deepEqual(after.entries.map(item => item.delivery.reply.content[0].text), ['二', '三'])
  } finally { await f.bridge.dispose() }
})

test('a revised multiline draft also keeps independent message decisions', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    const draft = await f.buffer({ action: 'append', text: '旧稿' })
    const replacement = await f.buffer({ action: 'replace', id: draft.id, text: '改后的第一句\n改后的第二句' })
    assert.equal(replacement.ids.length, 2)
    const read = await f.buffer({ action: 'read' })
    assert.deepEqual(read.items.map(item => item.content[0].text), ['改后的第一句', '改后的第二句'])
  } finally { await f.bridge.dispose() }
})

test('a requested finish waits until the remaining split drafts have been considered', async () => {
  const f = await fixture({ confirmTypingClock: true })
  let concluded = 0
  try {
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages: [] }) }) }
    const draft = await f.buffer({ action: 'append', text: '先说一句\n另一句待定' })
    const preview = await f.buffer({ action: 'send', finish: true })
    const clock = await f.buffer({ action: 'send', finish: true, reviewId: preview.reviewId, background: false })
    assert.equal(clock.finishRequested, false); assert.equal(clock.remainingBeforeFinish, true)
    const call = f.exec(); call.concludeTurn = () => { concluded++ }
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: clock.reviewId }, call)).ok, true)
    assert.equal(concluded, 0)
    assert.equal((await f.buffer({ action: 'read', id: draft.ids[1] })).items[0].state, 'draft')
  } finally { await f.bridge.dispose() }
})

test('new chat after the clock review still pauses before the physical send', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    const messages = [{ messageId: '123', text: '问题' }]
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages }) }) }
    const draft = await f.buffer({ action: 'append', text: '准备回答' })
    const before = await f.buffer({ action: 'send', id: draft.id })
    const clock = await f.buffer({ action: 'send', id: draft.id, reviewId: before.reviewId, background: false })
    messages.push({ messageId: '124', text: '已经解决了' })
    const paused = await f.buffer({ action: 'send', id: draft.id, reviewId: clock.reviewId })
    assert.equal(paused.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'clear', id: draft.id })).removed, 1)
  } finally { await f.bridge.dispose() }
})

test('the bounded listening budget carries across the clock wake and agent decision', async () => {
  const f = await fixture({ confirmTypingClock: true })
  try {
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages: [] }) }) }
    const draft = await f.buffer({ action: 'append', text: '先回应一句' })
    const key = JSON.stringify([f.agent.id, f.binding.id])
    f.bridge.outbox.replyDeferrals.set(key, { started: performance.now(), rounds: 3, inputs: '' })
    const preview = await f.buffer({ action: 'send', id: draft.id })
    const clock = await f.buffer({ action: 'send', id: draft.id, reviewId: preview.reviewId, background: false })
    assert.equal(clock.code, 'QQ_TYPING_CONFIRM')
    f.facts.active = false
    f.agent.inbox.nextStep.push({ id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    const sent = await f.buffer({ action: 'send', id: draft.id, reviewId: clock.reviewId })
    assert.equal(sent.ok, true); assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('background typing timer wakes an idle agent to inspect and decide', async () => {
  const entered = defer(), release = defer(), awakened = defer()
  const f = await fixture({ confirmTypingClock: true, typingWait: async () => { entered.resolve(); await release.promise } })
  try {
    f.agent.status = 'idle'
    f.agent.followup = message => awakened.resolve(message)
    const draft = await f.buffer({ action: 'append', text: '计时后判断' })
    const started = await f.buffer({ action: 'send', id: draft.id, background: true })
    await entered.promise
    release.resolve()
    const wake = await awakened.promise
    assert.equal(wake.source.kind, 'schedule')
    assert.match(wake.content[0].text, /watch/)
    assert.equal(f.calls.length, 0)
    const clock = await f.buffer({ action: 'watch', jobId: started.jobId })
    assert.equal(clock.code, 'QQ_TYPING_CONFIRM')
    assert.equal(clock.id, draft.id)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: clock.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('the default clock can finish a turn only after the agent confirms and the message is delivered', async () => {
  const entered = defer(), release = defer(), f = await fixture({ confirmTypingClock: true, typingWait: async () => { entered.resolve(); await release.promise } })
  let concluded = 0
  try {
    const draft = await f.buffer({ action: 'append', text: '等计时确认' })
    const call = f.exec(); call.concludeTurn = () => { concluded++ }
    const started = await f.buffer({ action: 'send', id: draft.id, finish: true }, call)
    assert.equal(started.code, 'QQ_OUTBOX_TYPING_STARTED'); assert.equal(concluded, 0)
    await entered.promise; release.resolve()
    const clock = await f.buffer({ action: 'watch', jobId: started.jobId, waitMs: 1000 })
    assert.equal(clock.code, 'QQ_TYPING_CONFIRM'); assert.equal(clock.finishRequested, true)
    const finishCall = f.exec(); finishCall.concludeTurn = () => { concluded++ }
    const sent = await f.buffer({ action: 'send', id: draft.id, finish: true, reviewId: clock.reviewId }, finishCall)
    assert.equal(sent.ok, true); assert.equal(concluded, 1); assert.equal(f.calls.length, 1)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('a watcher receives the timer decision without a duplicate wakeup', async () => {
  const entered = defer(), release = defer(), f = await fixture({ confirmTypingClock: true, typingWait: async () => { entered.resolve(); await release.promise } })
  let wakes = 0
  try {
    f.agent.status = 'running'; f.agent.steer = () => { wakes++ }
    const draft = await f.buffer({ action: 'append', text: '正在等计时' })
    const started = await f.buffer({ action: 'send', id: draft.id, background: true })
    await entered.promise
    const watching = f.buffer({ action: 'watch', jobId: started.jobId, waitMs: 1000 })
    await new Promise(resolve => setImmediate(resolve))
    release.resolve()
    assert.equal((await watching).code, 'QQ_TYPING_CONFIRM')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(wakes, 0); assert.equal(f.calls.length, 0)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('an admitted new QQ message interrupts the typing clock promptly and keeps the draft', async () => {
  const entered = defer()
  const f = await fixture({ confirmTypingClock: true, typingWait: async (_ms, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const draft = await f.buffer({ action: 'append', text: '先准备的草稿' })
    const sending = f.buffer({ action: 'send', id: draft.id, background: false })
    await entered.promise
    await f.bridge.receive({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 888, self_id: 999,
      message_id: 124, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '后来的消息' } }] })
    const paused = await sending
    assert.equal(paused.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(f.calls.filter(call => call.action === 'send_group_msg' || call.action === 'send_private_msg').length, 0)
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).items[0].needsReview, true)
  } finally { await f.bridge.dispose() }
})

test('repolled duplicate QQ messages do not repeatedly interrupt the typing clock', async () => {
  const entered = defer(), release = defer(), f = await fixture({ confirmTypingClock: true, typingWait: async () => { entered.resolve(); await release.promise } })
  try {
    await f.store.recordIngressReceipt(f.binding.id, '124', { traceId: 'old-trace' })
    const draft = await f.buffer({ action: 'append', text: '可以继续等' })
    const sending = f.buffer({ action: 'send', id: draft.id, background: false })
    await entered.promise
    const duplicate = await f.bridge.receive({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 888, self_id: 999,
      message_id: 124, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '已收过' } }] })
    assert.equal(duplicate.duplicate, true)
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).activity.state, 'typing')
    release.resolve()
    assert.equal((await sending).code, 'QQ_TYPING_CONFIRM')
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('new input marks the other lines from the same reply for reconsideration', async () => {
  const entered = defer(), f = await fixture({ confirmTypingClock: true, typingWait: async (_ms, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const draft = await f.buffer({ action: 'append', text: '第一句\n另一句' })
    const sending = f.buffer({ action: 'send', id: draft.id, background: false })
    await entered.promise
    await f.bridge.receive({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 888, self_id: 999,
      message_id: 125, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text: '已经解决了' } }] })
    assert.equal((await sending).code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal((await f.buffer({ action: 'read', id: draft.ids[1] })).items[0].needsReview, true)
  } finally { await f.bridge.dispose() }
})

test('new live chat while typing pauses a stale draft for a shorter, updated reply', async () => {
  const entered = defer(), release = defer(), f = await fixture({ typingWait: async () => { entered.resolve(); await release.promise } })
  try {
    const messages = [{ messageId: '123', text: '第一个问题' }]
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages }) }) }
    const draft = await f.buffer({ action: 'append', text: '按照第一句话写的冗长回复' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    const send = f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })
    await entered.promise
    messages.push({ messageId: '124', text: '话题变了，简单说就好' })
    release.resolve()
    const paused = await send
    assert.equal(paused.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(paused.context.recentMessages.find(row => row.messageId === paused.context.changedMessageIds[0]).text, '话题变了，简单说就好')
    assert.equal(f.calls.length, 0)
    const saved = (await f.buffer({ action: 'read', id: draft.id })).items[0]
    assert.equal(saved.state, 'draft'); assert.equal(saved.needsReview, true)
    assert.equal((await f.buffer({ action: 'replace', id: draft.id, text: '好，我简短说。', typing: { speed: 'instant' } })).ok, true)
    const updated = await f.buffer({ action: 'send', id: draft.id })
    assert.equal(updated.code, 'QQ_CONTEXT_REVIEW')
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: updated.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('background typing exposes newly consumed input and permits an explicit send-now decision', async () => {
  const entered = defer(), release = defer(), f = await fixture({ typingWait: async () => { entered.resolve(); await release.promise } })
  try {
    const draft = await f.buffer({ action: 'append', text: '等待期间的草稿' })
    const job = await f.buffer({ action: 'send', id: draft.id, background: true })
    await entered.promise
    assert.equal((await f.buffer({ action: 'watch', jobId: job.jobId, waitMs: 0 })).code, 'QQ_OUTBOX_TYPING')
    f.facts.inputs.push('124')
    release.resolve()
    const watched = await f.buffer({ action: 'watch', jobId: job.jobId, waitMs: 1000 })
    assert.equal(watched.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(watched.context.incomingCount, 1)
    assert.equal(f.calls.length, 0)
    const item = (await f.buffer({ action: 'read', id: draft.id })).items[0]
    assert.equal(item.state, 'draft'); assert.equal(item.needsReview, true)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, sendNow: true, typing: { speed: 'instant' } })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('changed chat stops later split messages while keeping the first message receipt', async () => {
  const entered = defer(), release = defer(); let waits = 0
  const f = await fixture({ typingWait: async () => { if (++waits === 2) { entered.resolve(); await release.promise } } })
  try {
    const messages = [{ messageId: '123', text: '之前的话题' }]
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages }) }) }
    const draft = await f.buffer({ action: 'append', text: '先说一句\n后面这句也许过时了' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    const pending = f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })
    await entered.promise
    assert.equal(f.calls.length, 1)
    messages.push({ messageId: '124', text: '已经解决了' })
    release.resolve()
    const paused = await pending
    assert.equal(paused.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(paused.receipts[0].deliveredParts, 1)
    assert.deepEqual(paused.receipts[0].sentMessageIds, ['1'])
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).items[0].state, 'unknown')
    assert.equal((await f.buffer({ action: 'send', id: draft.id, retry: true })).code, 'QQ_OUTBOX_EMPTY')
    assert.equal(f.calls.length, 1)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('the first part of the same chosen reply does not count as an unexpected chat change', async () => {
  const f = await fixture()
  try {
    const messages = [{ messageId: '123', text: '原话题' }]
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages }) }) }
    f.bridge.onebot.call = async (_action, params) => {
      const id = String(f.calls.length + 1)
      f.calls.push({ params })
      messages.push({ messageId: id, text: params.message.find(part => part.type === 'text').data.text, own: true })
      return { message_id: id }
    }
    const draft = await f.buffer({ action: 'append', text: '第一句\n第二句' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    const sent = await f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })
    assert.equal(sent.ok, true); assert.equal(f.calls.length, 2)
  } finally { await f.bridge.dispose() }
})

test('the bridge checks again immediately before the transport performs its request', async () => {
  const f = await fixture()
  try {
    const draft = await f.buffer({ action: 'append', text: '这一句先缓缓' })
    f.bridge.onebot.call = async (_action, _params, options) => {
      f.agent.inbox.nextStep.push({ id: 'last-moment', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '125' } })
      options.beforeSend()
      f.calls.push('sent')
      return { message_id: 1 }
    }
    const answer = await f.buffer({ action: 'send', id: draft.id, typing: { speed: 'instant' } })
    assert.equal(answer.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
    assert.equal(f.calls.length, 0)
    const item = (await f.buffer({ action: 'read', id: draft.id })).items[0]
    assert.equal(item.state, 'draft'); assert.equal(item.needsReview, true)
  } finally { await f.bridge.dispose() }
})

test('continuous new input during typing gets reviewed but cannot defer every chosen send forever', async () => {
  let f, arrivals = 0
  f = await fixture({ typingWait: async () => { f.facts.inputs.push(String(200 + ++arrivals)) } })
  try {
    const draft = await f.buffer({ action: 'append', text: '先说一句' })
    for (let round = 1; round <= 3; round++) {
      const paused = await f.buffer({ action: 'send', id: draft.id })
      assert.equal(paused.code, 'QQ_CONTEXT_CHANGED_DURING_TYPING')
      assert.equal(paused.listeningRounds, round)
      assert.equal(f.calls.length, 0)
      assert.equal((await f.buffer({ action: 'replace', id: draft.id, text: `合并到第 ${round} 次` })).ok, true)
    }
    const sent = await f.buffer({ action: 'send', id: draft.id })
    assert.equal(sent.ok, true)
    assert.equal(f.calls.length, 1)
    assert.equal(arrivals, 4)
  } finally { await f.bridge.dispose() }
})

test('agent controls typing speed and the chosen override survives the review', async () => {
  const delays = [], f = await fixture({ typingWait: async ms => { delays.push(ms) } })
  try {
    f.bridge.nativeFeatures.history = { read: async () => ({ ok: true, text: JSON.stringify({ messages: [] }) }) }
    const draft = await f.buffer({ action: 'append', text: '你好 Hello', typing: { speed: 'slow' } })
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).items[0].typing.speed, 'slow')
    assert.equal((await f.buffer({ action: 'replace', id: draft.id, typing: { speed: 'fast' } })).ok, true)
    const review = await f.buffer({ action: 'send', id: draft.id, typing: { speed: 'instant' } })
    assert.equal(review.code, 'QQ_CONTEXT_REVIEW')
    assert.equal(review.timeline.at(-1).typing.speed, 'instant')
    assert.equal(review.timeline.at(-1).typing.estimatedMs, 0)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })).ok, true)
    assert.deepEqual(delays, [])
    assert.equal(f.calls.length, 1)
    assert.equal((await f.buffer({ action: 'append', text: 'x', typing: { speed: 'unknown' } })).code, 'QQ_TYPING_INVALID')
  } finally { await f.bridge.dispose() }
})

test('typing status is observable while a new QQ input can arrive, before the message is sent once', async () => {
  const entered = defer(), release = defer(), f = await fixture({ typingWait: async ms => { entered.resolve(ms); await release.promise } })
  try {
    const draft = await f.buffer({ action: 'append', text: '正在输入 English 文字' })
    const sending = f.buffer({ action: 'send', id: draft.id, sendNow: true })
    const duration = await entered.promise
    assert.ok(duration > 0)
    const during = await f.buffer({ action: 'read', id: draft.id })
    assert.equal(during.activity.state, 'typing')
    assert.ok(during.activity.remainingMs >= 0 && during.activity.remainingMs <= during.activity.durationMs)
    assert.equal(during.activity.id, draft.id)
    assert.equal(during.activity.durationMs, duration)
    assert.equal(during.items[0].state, 'reserved')
    assert.equal(f.calls.length, 0)
    f.agent.inbox.nextStep.push({ id: 'new-input', source: { kind: 'super-agent-io', bindingId: f.binding.id } })
    release.resolve()
    assert.equal((await sending).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 1)
    assert.equal(f.agent.inbox.nextStep.length, 1)
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).activity, undefined)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('stopping during simulated typing records a failed send without a physical QQ call', async () => {
  const entered = defer()
  const f = await fixture({ typingWait: async (_ms, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const draft = await f.buffer({ action: 'append', text: '等会儿发送' })
    const sending = f.buffer({ action: 'send', id: draft.id })
    await entered.promise
    f.bridge.controller.abort()
    const sent = await sending
    assert.equal(sent.receipts[0].state, 'failed')
    assert.equal(f.calls.length, 0)
    const box = await f.store.outbox(f.binding.id)
    assert.equal(box.entries.find(item => item.id === draft.id).state, 'failed')
  } finally { await f.bridge.dispose() }
})

test('background send lets the agent inspect and cancel its own typing before changing the draft', async () => {
  const entered = defer()
  const f = await fixture({ typingWait: async (_ms, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const draft = await f.buffer({ action: 'append', text: '我先打字' })
    const started = await f.buffer({ action: 'send', id: draft.id, background: true })
    assert.equal(started.code, 'QQ_OUTBOX_TYPING_STARTED')
    await entered.promise
    const during = await f.buffer({ action: 'read', id: draft.id })
    assert.equal(during.activity.id, draft.id)
    assert.equal(during.activity.state, 'typing')
    assert.equal(during.jobs[0].status, 'running')
    const ongoing = f.bridge.outbox.sendTails.get(f.binding.id)
    assert.equal((await f.buffer({ action: 'cancel_typing', id: draft.id })).code, 'QQ_TYPING_CANCEL_REQUESTED')
    await ongoing
    const cancelled = await f.buffer({ action: 'read', id: draft.id })
    assert.equal(cancelled.items[0].state, 'draft')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'replace', id: draft.id, text: '改好再发送', typing: { speed: 'instant' } })).ok, true)
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('cancelling typing after one split message retains the partial receipt without replay', async () => {
  const second = defer(); let count = 0
  const f = await fixture({ typingWait: async (_ms, signal) => {
    if (++count === 1) return
    second.resolve()
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  try {
    const draft = await f.buffer({ action: 'append', text: '第一条\n第二条' })
    await f.buffer({ action: 'send', id: draft.id, background: true })
    await second.promise
    assert.equal(f.calls.length, 1)
    const ongoing = f.bridge.outbox.sendTails.get(f.binding.id)
    assert.equal((await f.buffer({ action: 'cancel_typing', id: draft.id })).ok, true)
    await ongoing
    const read = await f.buffer({ action: 'read', id: draft.id })
    assert.equal(read.items[0].state, 'unknown')
    assert.equal((await f.buffer({ action: 'send', id: draft.id, retry: true })).code, 'QQ_OUTBOX_EMPTY')
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('switching models does not bulk-send old drafts; selected historical drafts remain sendable', async () => {
  const f = await fixture()
  try {
    const old = await f.buffer({ action: 'append', text: '之前留下的消息' })
    await f.bridge.deliver(f.delivery('old-auto', text('之前的自动草稿')))
    f.modelEvent.data.turn = 2
    f.modelEvent.data.message.source = { kind: 'model', provider: 'new-provider', model: 'new-model' }
    const current = await f.buffer({ action: 'append', text: '当前准备发送的消息' })
    const sent = await f.buffer({ action: 'send', all: true })
    assert.deepEqual(sent.receipts.map(row => row.id), [current.id])
    assert.equal(sent.previousDrafts, 2)
    assert.deepEqual(f.calls.map(call => call.params.message.find(part => part.type === 'text').data.text), ['当前准备发送的消息'])
    assert.equal((await f.buffer({ action: 'send', id: old.id })).receipts[0].state, 'delivered')
    assert.equal((await f.buffer({ action: 'send', all: true })).code, 'QQ_OUTBOX_CURRENT_BATCH_EMPTY')
    assert.equal((await f.buffer({ action: 'send', all: true, includePrevious: true })).receipts[0].id, 'old-auto')
  } finally { await f.bridge.dispose() }
})

test('a model change within the same turn keeps the former model drafts out of the default send', async () => {
  const f = await fixture()
  try {
    const earlier = await f.buffer({ action: 'append', text: '切换前' })
    f.modelEvent.data.message.source = { kind: 'model', provider: 'p', model: 'other-model' }
    const current = await f.buffer({ action: 'append', text: '切换后' })
    const sent = await f.buffer({ action: 'send' })
    assert.deepEqual(sent.receipts.map(row => row.id), [current.id])
    assert.equal((await f.buffer({ action: 'send', id: earlier.id })).receipts[0].state, 'delivered')
  } finally { await f.bridge.dispose() }
})

test('outbox read can page through older retained entries', async () => {
  const f = await fixture()
  try {
    const entries = Array.from({ length: 105 }, (_, i) => ({ id: `history-${i}`, state: 'draft', delivery: f.delivery(`history-${i}`), createdAt: i, attempts: 0 }))
    await f.store.recordOutbox(f.binding.id, { version: 1, bindingId: f.binding.id, endpoint: f.binding.endpoint, entries })
    const first = await f.buffer({ action: 'read' }), earlier = await f.buffer({ action: 'read', offset: 100 })
    assert.equal(first.items.length, 100); assert.equal(first.hasMore, true)
    assert.deepEqual(earlier.items.map(item => item.id), ['history-0', 'history-1', 'history-2', 'history-3', 'history-4'])
    assert.equal(earlier.hasMore, false)
  } finally { await f.bridge.dispose() }
})

test('only an explicit outbox send reaches QQ; read, edit and clear preserve ownership and receipts', async () => {
  const f = await fixture()
  try {
    assert.deepEqual(await f.bridge.deliver(f.delivery('a', text('初稿'))), { state: 'buffered', bufferId: 'a' })
    assert.deepEqual(await f.bridge.deliver(f.delivery('a', text('初稿'))), { state: 'buffered', bufferId: 'a' })
    assert.equal(f.calls.length, 0)
    let read = await f.buffer({ action: 'read' }); assert.equal(read.items.length, 1); assert.equal(read.items[0].content[0].text, '初稿')
    assert.equal((await f.buffer({ action: 'replace', id: 'a', text: '改稿' })).code, 'QQ_OUTBOX_REPLACED')
    assert.equal((await f.buffer({ action: 'send' })).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.message.find(p => p.type === 'text').data.text, '改稿'); assert.equal(f.calls[0].params.message.some(p => p.type === 'reply'), false)
    read = await f.buffer({ action: 'read' }); assert.equal(read.items[0].state, 'sent')
    assert.equal((await f.buffer({ action: 'send', id: 'a' })).code, 'QQ_OUTBOX_EMPTY')
    await f.buffer({ action: 'clear' }); assert.equal((await f.buffer({ action: 'read' })).items.length, 0)
    assert.deepEqual(f.reconciled.map(row => row.state), ['content', 'sending', 'delivered', 'cleared'])
  } finally { await f.bridge.dispose() }
})

test('the agent chooses which QQ message to quote for each draft', async () => {
  const f = await fixture()
  try {
    const unquoted = await f.buffer({ action: 'append', text: '普通发言' })
    const quoted = await f.buffer({ action: 'append', text: '引用另一句话', replyTo: '-97' })
    assert.equal((await f.buffer({ action: 'append', text: '无效引用', replyTo: 'not-a-message' })).code, 'QQ_INVALID_REPLY_ID')
    assert.equal((await f.buffer({ action: 'send', id: unquoted.id })).ok, true)
    assert.equal((await f.buffer({ action: 'send', id: quoted.id })).ok, true)
    assert.equal(f.calls[0].params.message.some(part => part.type === 'reply'), false)
    assert.deepEqual(f.calls[1].params.message.find(part => part.type === 'reply'), { type: 'reply', data: { id: '-97' } })
  } finally { await f.bridge.dispose() }
})

test('sending first shows the current QQ conversation and draft for an actual decision', async () => {
  const f = await fixture()
  try {
    const historyCalls = []
    f.bridge.onebot.call = async (action, params) => {
      if (action === 'get_login_info') return { user_id: 999 }
      if (action === 'get_group_msg_history') {
        historyCalls.push(params)
        return { messages: [{ message_id: 44, message_type: 'group', group_id: 456, user_id: 123, time: 10,
          sender: { user_id: 123, nickname: '群友' }, message: [{ type: 'reply', data: { id: 43 } }, { type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: '先等等，刚刚说错了' } }] }] }
      }
      f.calls.push({ action, params }); return { message_id: 101 }
    }
    f.bridge.nativeFeatures.history = new QqHistoryTools({ onebot: f.bridge.onebot, store: f.store,
      origin: () => f.bridge.config.baseUrl, binding: id => f.bridge.config.bindings.find(row => row.id === id), networkEnabled: () => true, enabled: () => true })
    const draft = await f.buffer({ action: 'append', text: '我来处理一下' })
    const review = await f.buffer({ action: 'send', id: draft.id, finish: true })
    assert.equal(review.code, 'QQ_CONTEXT_REVIEW'); assert.equal(review.historyStatus, 'live'); assert.equal(review.finishRequested, true)
    assert.equal(historyCalls.length, 1); assert.equal(f.calls.length, 0)
    assert.equal(review.timeline[0].text, '@999先等等，刚刚说错了'); assert.equal(review.timeline[0].replyTo, '43'); assert.deepEqual(review.timeline[0].mentions, ['999'])
    assert.deepEqual(review.timeline.at(-1).content, text('我来处理一下'))
    assert.match(review.message, /实际查完/)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, finish: true, reviewId: review.reviewId })).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('replacing a draft or changing the finish decision requests a fresh review', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read(_args, allowed) { assert.ok(allowed()); return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '我去查一下' })
    const first = await f.buffer({ action: 'send', id: draft.id, finish: true })
    await f.buffer({ action: 'replace', id: draft.id, text: '我查到了，结果是这样' })
    const second = await f.buffer({ action: 'send', id: draft.id, finish: true, reviewId: first.reviewId })
    assert.equal(second.code, 'QQ_CONTEXT_REVIEW'); assert.equal(second.timeline.at(-1).content[0].text, '我查到了，结果是这样')
    const changedFinish = await f.buffer({ action: 'send', id: draft.id, finish: false, reviewId: second.reviewId })
    assert.equal(changedFinish.code, 'QQ_CONTEXT_REVIEW'); assert.equal(changedFinish.finishRequested, false)
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, finish: false, reviewId: changedFinish.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('drafts created while the agent considers the review remain for a later decision', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read() { return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const original = await f.buffer({ action: 'append', text: '已检查的一条' })
    const review = await f.buffer({ action: 'send', finish: true })
    const later = await f.buffer({ action: 'append', text: '检查后新写的一条' })
    const sent = await f.buffer({ action: 'send', finish: true, reviewId: review.reviewId })
    assert.equal(sent.ok, true); assert.equal(sent.newDrafts, 1)
    assert.deepEqual(sent.receipts.map(row => row.id), [original.id])
    assert.equal((await f.buffer({ action: 'read', id: later.id })).items[0].state, 'draft')
    assert.deepEqual(f.calls.map(call => call.params.message.find(part => part.type === 'text').data.text), ['已检查的一条'])
  } finally { await f.bridge.dispose() }
})

test('a pending arrival preserves the reviewed draft and the agent can decide to send it now', async () => {
  const f = await fixture()
  try {
    let reads = 0
    f.bridge.nativeFeatures.history = { async read() { reads++; return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '经过检查的一句' })
    const review = await f.buffer({ action: 'send', id: draft.id, finish: true })
    const incoming = { id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } }
    f.agent.inbox.nextStep.push(incoming)
    const deferred = await f.buffer({ action: 'send', id: draft.id, finish: true, reviewId: review.reviewId })
    assert.equal(deferred.code, 'QQ_INPUT_PENDING'); assert.equal(deferred.reviewId, review.reviewId)
    const sent = await f.buffer({ action: 'send', id: draft.id, finish: true, reviewId: review.reviewId, sendNow: true })
    assert.equal(sent.ok, true); assert.equal(reads, 1); assert.deepEqual(f.agent.inbox.nextStep, [incoming])
  } finally { await f.bridge.dispose() }
})

test('an agent that has seen the contextual review can send its chosen draft after pending input is processed', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read() { return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '看过上下文后的答复' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    f.agent.inbox.nextStep.push({ id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })).code, 'QQ_INPUT_PENDING')
    f.agent.inbox.nextStep.length = 0; f.facts.inputs.push('124')
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('changing the model or QQ service refreshes the context review', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read() { return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '先检查当前内容' })
    const first = await f.buffer({ action: 'send', id: draft.id })
    f.modelEvent.data.message.source.model = 'another-model'
    const second = await f.buffer({ action: 'send', id: draft.id, reviewId: first.reviewId })
    assert.equal(second.code, 'QQ_CONTEXT_REVIEW')
    f.bridge.config.baseUrl = 'http://127.0.0.1:3001'
    const third = await f.buffer({ action: 'send', id: draft.id, reviewId: second.reviewId })
    assert.equal(third.code, 'QQ_CONTEXT_REVIEW'); assert.equal(f.calls.length, 0)
  } finally { await f.bridge.dispose() }
})

test('an aged review refreshes while explicit send-now retains a deliberate choice', async () => {
  const f = await fixture()
  try {
    let reads = 0
    f.bridge.nativeFeatures.history = { async read() { reads++; return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '准备回复' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    f.bridge.outbox.reviews.get(review.reviewId).createdAt -= 31000
    const refreshed = await f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })
    assert.equal(refreshed.code, 'QQ_CONTEXT_REVIEW'); assert.equal(reads, 2)
    f.bridge.outbox.reviews.get(refreshed.reviewId).createdAt -= 31000
    assert.equal((await f.buffer({ action: 'send', id: draft.id, reviewId: refreshed.reviewId, sendNow: true })).ok, true)
    assert.equal(reads, 2); assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('an unavailable live history is reported and the agent can still make the send decision', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read() { throw Error('offline') } }
    const draft = await f.buffer({ action: 'append', text: '根据已知情况先答一句' })
    const review = await f.buffer({ action: 'send', id: draft.id, sendNow: true })
    assert.equal(review.code, 'QQ_CONTEXT_REVIEW'); assert.equal(review.historyStatus, 'unavailable')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'send', id: draft.id, sendNow: true, reviewId: review.reviewId })).ok, true)
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('the latest chat is fetched after an existing group reply cooldown', async () => {
  const f = await fixture()
  try {
    Object.assign(f.bridge.config.bindings[0].rate, { enabled: true, cooldownMs: 100, perMinute: 60 })
    await f.bridge.admission.delivered(f.binding.id)
    let observedAt = 0
    f.bridge.nativeFeatures.history = { async read() { observedAt = performance.now(); return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    const draft = await f.buffer({ action: 'append', text: '先看一眼现在的聊天' })
    const start = performance.now(), review = await f.buffer({ action: 'send', id: draft.id })
    assert.equal(review.code, 'QQ_CONTEXT_REVIEW'); assert.ok(observedAt - start >= 65)
    assert.equal(f.calls.length, 0)
  } finally { await f.bridge.dispose() }
})

test('a changed draft during send waiting is not sent using an older review', async () => {
  const f = await fixture()
  try {
    f.bridge.nativeFeatures.history = { async read() { return { ok: true, text: JSON.stringify({ messages: [] }) } } }
    f.bridge.config.replyQuietMs = 80
    const draft = await f.buffer({ action: 'append', text: '初稿' })
    const review = await f.buffer({ action: 'send', id: draft.id })
    const sending = f.buffer({ action: 'send', id: draft.id, reviewId: review.reviewId })
    setTimeout(() => { void f.buffer({ action: 'replace', id: draft.id, text: '同时改过的稿子' }) }, 10)
    assert.equal((await sending).code, 'QQ_CONTEXT_REVIEW_CHANGED')
    assert.equal(f.calls.length, 0)
  } finally { await f.bridge.dispose() }
})

test('new QQ input arriving during the quiet window is considered before sending', async () => {
  const f = await fixture()
  try {
    f.bridge.config.replyQuietMs = 30
    const draft = await f.buffer({ action: 'append', text: '根据第一条消息写的草稿' })
    const pending = f.buffer({ action: 'send', id: draft.id })
    setTimeout(() => f.agent.inbox.nextStep.push({ id: 'new-input', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } }), 5)
    const delayed = await pending
    assert.equal(delayed.code, 'QQ_INPUT_PENDING'); assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).items[0].needsReview, true)
    f.agent.inbox.nextStep.length = 0; f.facts.inputs.push('124')
    assert.equal((await f.buffer({ action: 'replace', id: draft.id, text: '结合两条消息后的回复' })).ok, true)
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).receipts[0].state, 'delivered')
    assert.deepEqual(f.calls.map(call => call.params.message.find(part => part.type === 'text').data.text), ['结合两条消息后的回复'])
  } finally { await f.bridge.dispose() }
})

test('the agent can choose to send a draft while a newer group input stays pending', async () => {
  const f = await fixture()
  try {
    const draft = await f.buffer({ action: 'append', text: '先回应已讨论的事情' })
    const incoming = { id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } }
    f.agent.inbox.nextStep.push(incoming)
    const deferred = await f.buffer({ action: 'send', id: draft.id })
    assert.equal(deferred.code, 'QQ_INPUT_PENDING'); assert.equal(deferred.canSendNow, true)
    assert.equal((await f.buffer({ action: 'read', id: draft.id })).items[0].needsReview, true)
    const sent = await f.buffer({ action: 'send', id: draft.id, sendNow: true })
    assert.equal(sent.receipts[0].state, 'delivered')
    assert.deepEqual(f.agent.inbox.nextStep, [incoming])
    assert.deepEqual(f.calls.map(call => call.params.message.find(part => part.type === 'text').data.text), ['先回应已讨论的事情'])
  } finally { await f.bridge.dispose() }
})

test('continuous incoming messages cannot indefinitely defer an explicitly chosen group send', async () => {
  const f = await fixture()
  try {
    const draft = await f.buffer({ action: 'append', text: '一段综合回复' })
    for (let round = 1; round <= 3; round++) {
      f.agent.inbox.nextStep.push({ id: `later-${round}`, source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: String(123 + round) } })
      const paused = await f.buffer({ action: 'send', id: draft.id })
      assert.equal(paused.code, 'QQ_INPUT_PENDING'); assert.equal(paused.listeningRounds, round)
      if (round === 1) assert.equal((await f.buffer({ action: 'send', id: draft.id })).listeningRounds, 1)
      f.agent.inbox.nextStep.length = 0; f.facts.inputs.push(String(123 + round))
      await f.buffer({ action: 'replace', id: draft.id, text: `综合到第 ${round} 轮` })
    }
    const later = { id: 'later-4', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '127' } }
    f.agent.inbox.nextStep.push(later)
    const sent = await f.buffer({ action: 'send', id: draft.id })
    assert.equal(sent.receipts[0].state, 'delivered'); assert.deepEqual(f.agent.inbox.nextStep, [later])
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('the wait deadline releases the next chosen send without starting a send by itself', async () => {
  const f = await fixture()
  try {
    const draft = await f.buffer({ action: 'append', text: '已有上下文的回复' })
    f.agent.inbox.nextStep.push({ id: 'in-flight', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).code, 'QQ_INPUT_PENDING')
    await f.buffer({ action: 'replace', id: draft.id, text: '整理后的回复' })
    const wait = [...f.bridge.outbox.replyDeferrals.values()][0]
    wait.started = performance.now() - 15001
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).receipts[0].state, 'delivered')
    assert.equal(f.agent.inbox.nextStep.length, 1)
  } finally { await f.bridge.dispose() }
})

test('an old waiting budget expires before a later conversation', async () => {
  const f = await fixture()
  try {
    const draft = await f.buffer({ action: 'append', text: '稍后处理的新话题' })
    f.agent.inbox.nextStep.push({ id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).code, 'QQ_INPUT_PENDING')
    ;[...f.bridge.outbox.replyDeferrals.values()][0].started = performance.now() - 300001
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).code, 'QQ_INPUT_PENDING')
    assert.equal(f.calls.length, 0)
  } finally { await f.bridge.dispose() }
})

test('sending during pending input still follows the configured group send interval', async () => {
  const f = await fixture()
  try {
    Object.assign(f.bridge.config.bindings[0].rate, { enabled: true, cooldownMs: 100, perMinute: 60 })
    await f.bridge.admission.delivered(f.binding.id)
    const draft = await f.buffer({ action: 'append', text: '先发出这句' })
    f.agent.inbox.nextStep.push({ id: 'late', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    const start = performance.now()
    const sent = await f.buffer({ action: 'send', id: draft.id, sendNow: true })
    assert.equal(sent.receipts[0].state, 'delivered'); assert.ok(performance.now() - start >= 65)
    assert.equal(f.agent.inbox.nextStep.length, 1)
  } finally { await f.bridge.dispose() }
})

test('reply cooldown holds the send while allowing the next QQ input through', async () => {
  const f = await fixture()
  try {
    Object.assign(f.bridge.config.bindings[0].rate, { enabled: true, cooldownMs: 80, perMinute: 60 })
    await f.bridge.admission.delivered(f.binding.id)
    const draft = await f.buffer({ action: 'append', text: '下一次回复' })
    const start = performance.now(), sending = f.buffer({ action: 'send', id: draft.id })
    setTimeout(() => f.agent.inbox.nextStep.push({ id: 'next', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } }), 5)
    assert.equal((await sending).code, 'QQ_INPUT_PENDING')
    assert.equal(f.calls.length, 0)
    assert.ok(performance.now() - start < 500)
  } finally { await f.bridge.dispose() }
})

test('a proactive DSH send remains available while unrelated input is pending', async () => {
  const f = await fixture()
  try {
    Object.assign(f.facts, { active: false, exclusive: false, bindingId: '', inputs: [] })
    f.agent.inbox.nextStep.push({ id: 'other', source: { kind: 'user' } })
    const draft = await f.buffer({ action: 'append', text: '本机主动发出' })
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).receipts[0].state, 'delivered')
  } finally { await f.bridge.dispose() }
})

test('a queued send rechecks newly arrived QQ input before its first physical message', async () => {
  const f = await fixture(), started = defer(), release = defer()
  try {
    f.bridge.onebot.call = async () => { started.resolve(); await release.promise; return { message_id: 1 } }
    const firstDraft = await f.buffer({ action: 'append', text: '已开始发送' })
    const first = f.buffer({ action: 'send', id: firstDraft.id }); await started.promise
    const secondDraft = await f.buffer({ action: 'append', text: '尚未发送的草稿' })
    const second = f.buffer({ action: 'send', id: secondDraft.id })
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await f.store.outbox(f.binding.id)).entries.find(item => item.id === secondDraft.id)?.state === 'reserved') break
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    f.agent.inbox.nextStep.push({ id: 'new-input', source: { kind: 'super-agent-io', bindingId: f.binding.id, externalMessageId: '124' } })
    release.resolve()
    assert.equal((await first).receipts[0].state, 'delivered')
    assert.equal((await second).code, 'QQ_INPUT_PENDING')
    const old = (await f.buffer({ action: 'read', id: secondDraft.id })).items[0]
    assert.equal(old.state, 'draft'); assert.equal(old.needsReview, true)
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('a QQ-bound session can choose and send to another QQ group without a binding', async () => {
  const f = await fixture()
  try {
    const explicit = { ...f.delivery('owner'), intent: 'explicit', reply: reply('owner-session', text('主动消息')) }
    assert.equal((await f.bridge.deliver(explicit)).state, 'buffered')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.buffer({ action: 'send', id: 'owner' })).receipts[0].state, 'delivered')
    const draft = await f.buffer({ action: 'append', destination: 'group:789', text: '跨群发送' })
    assert.equal(draft.code, 'QQ_OUTBOX_APPENDED')
    assert.equal((await f.buffer({ action: 'send', destination: 'group:789', id: draft.id })).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 2); assert.equal(String(f.calls[1].params.group_id), '789')
  } finally { await f.bridge.dispose() }
})

test('outbox read, append and send remain available after local input or a mixed-source turn', async () => {
  const f = await fixture()
  try {
    Object.assign(f.facts, { active: false, exclusive: false, bindingId: '', inputs: [] })
    f.bridge.nativeFeatures.allowDelivery = async () => false
    const draft = await f.buffer({ action: 'append', text: '随时发出' })
    assert.equal(draft.code, 'QQ_OUTBOX_APPENDED')
    assert.equal((await f.buffer({ action: 'read' })).items.at(-1).id, draft.id)
    assert.equal((await f.buffer({ action: 'send', id: draft.id })).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('a disabled configured target and the master send switch remain effective for direct addresses', async () => {
  const f = await fixture()
  try {
    f.bridge.config.bindings[0].sendEnabled = false
    assert.equal((await f.buffer({ action: 'append', destination: 'group:456', text: '内容' })).code, 'QQ_OUTBOX_TARGET_REQUIRED')
    f.bridge.config.bindings[0].sendEnabled = true
    f.bridge.config.sendEnabled = false
    assert.equal((await f.buffer({ action: 'append', destination: 'private:789', text: '内容' })).code, 'QQ_OUTBOX_TARGET_REQUIRED')
    assert.equal(f.calls.length, 0)
  } finally { await f.bridge.dispose() }
})

test('incoming or newly generated drafts can enter while an already committed send is in flight', async () => {
  const f = await fixture(), start = defer(), release = defer()
  try {
    f.bridge.onebot.call = async () => { start.resolve(); await release.promise; return { message_id: 7 } }
    await f.bridge.deliver(f.delivery('old'))
    const sending = f.buffer({ action: 'send', id: 'old' })
    await start.promise
    const raced = await Promise.race([f.bridge.deliver(f.delivery('new')), new Promise(resolve => setTimeout(() => resolve('blocked'), 250))])
    assert.equal(raced.state, 'buffered')
    release.resolve()
    assert.equal((await sending).receipts[0].state, 'delivered')
    const read = await f.buffer({ action: 'read' }); assert.deepEqual(read.items.map(item => [item.id, item.state]), [['old', 'sent'], ['new', 'draft']])
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('a queued send reserves its current drafts immediately and survives a later interrupted tool', async () => {
  const f = await fixture(), started = defer(), release = defer(), controller = new AbortController(), contents = []
  try {
    f.bridge.onebot.call = async (_action, params) => {
      contents.push(params.message.find(part => part.type === 'text').data.text)
      if (contents.length === 1) { started.resolve(); await release.promise }
      return { message_id: contents.length }
    }
    await f.bridge.deliver(f.delivery('first', text('第一条')))
    const first = f.buffer({ action: 'send', id: 'first' }); await started.promise
    const secondDraft = await f.buffer({ action: 'append', text: '第二条' })
    const exec = f.exec(); exec.signal = controller.signal
    const second = f.buffer({ action: 'send' }, exec)
    let reserved = false
    for (let attempt = 0; attempt < 50; attempt++) {
      const box = await f.store.outbox(f.binding.id)
      if (box.entries.find(item => item.id === secondDraft.id)?.state === 'reserved') { reserved = true; break }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(reserved, true)
    await f.bridge.deliver(f.delivery('later', text('随后草稿')))
    controller.abort(); release.resolve()
    assert.equal((await first).receipts[0].state, 'delivered')
    assert.equal((await second).receipts[0].state, 'delivered')
    assert.deepEqual(contents, ['第一条', '第二条'])
    const box = await f.store.outbox(f.binding.id)
    assert.equal(box.entries.find(item => item.id === 'later').state, 'draft')
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('failed and ambiguous sends remain inspectable; retry needs an explicit choice and never retries unknown', async () => {
  const f = await fixture()
  try {
    f.bridge.onebot.call = async () => { throw Object.assign(new Error('rejected'), { code: 'ONEBOT_API_REJECTED', deliveryState: 'failed' }) }
    await f.bridge.deliver(f.delivery('failed'))
    assert.equal((await f.buffer({ action: 'send', id: 'failed' })).receipts[0].state, 'failed')
    assert.equal((await f.buffer({ action: 'send', id: 'failed' })).code, 'QQ_OUTBOX_EMPTY')
    f.bridge.onebot.call = async () => { throw Object.assign(new Error('timeout'), { code: 'ONEBOT_RESPONSE_UNKNOWN', deliveryState: 'unknown' }) }
    assert.equal((await f.buffer({ action: 'send', id: 'failed', retry: true })).receipts[0].state, 'unknown')
    assert.equal((await f.buffer({ action: 'send', id: 'failed', retry: true })).code, 'QQ_OUTBOX_EMPTY')
    assert.equal((await f.buffer({ action: 'read', id: 'failed' })).items[0].state, 'unknown')
  } finally { await f.bridge.dispose() }
})

test('fast ingress serializes same-group messages individually without a three-second window', async () => {
  const f = await fixture(), firstStart = defer(), firstDone = defer(), requests = []
  try {
    f.bridge.onebot.call = async action => action === 'get_group_member_info' ? { nickname: 'name', card: 'card', title: 'title' } : { message_id: 88, message_type: 'group', group_id: 456, sender: { user_id: 789 }, message: text('quoted').map(block => ({ type: 'text', data: { text: block.text } })) }
    f.bridge.media.admit = async part => ({ type: 'image', attachment: { attachmentId: part.file, mediaType: 'image/png', bytes: 5, width: 1, height: 1 } })
    f.io.receive = async request => { requests.push(request); if (requests.length === 1) { firstStart.resolve(); await firstDone.promise } return { state: 'accepted', traceId: `t${requests.length}` } }
    const event = (id, textValue) => ({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 789, self_id: 111, message_id: id, sender: { nickname: 'name', card: 'card', title: 'title' }, message: [{ type: 'text', data: { text: textValue } }, ...(id === 2 ? [{ type: 'reply', data: { id: 88 } }, { type: 'image', data: { file: 'photo.png' } }] : [])] })
    const a = f.bridge.receive(event(1, 'one'))
    assert.equal(await Promise.race([firstStart.promise.then(() => 'started'), new Promise(resolve => setTimeout(() => resolve('delayed'), 500))]), 'started')
    const b = f.bridge.receive(event(2, 'two'))
    firstDone.resolve()
    await Promise.all([a, b])
    assert.deepEqual(requests.map(row => row.externalMessageId), ['1', '2'])
    assert.deepEqual(requests.map(row => row.senderId), ['789', '789'])
    assert.deepEqual(requests.map(row => row.replyTo), [undefined, '88'])
    assert.equal(requests[1].content.find(block => block.type === 'image').attachment.attachmentId, 'photo.png')
  } finally { firstDone.resolve(); await f.bridge.dispose() }
})

test('an image remains a native attachment and a stopped tool does not cancel a committed multi-message send', async () => {
  const f = await fixture(), firstStart = defer(), release = defer(), controller = new AbortController(), calls = []
  try {
    f.bridge.media.export = async () => ({ file: 'base64://YQ==' })
    f.bridge.onebot.call = async (action, params) => { calls.push({ action, params }); if (calls.length === 1) { firstStart.resolve(); await release.promise } return { message_id: calls.length } }
    const image = { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
    await f.bridge.deliver(f.delivery('first', text('first')))
    await f.bridge.deliver(f.delivery('second', [image]))
    const exec = f.exec(); exec.signal = controller.signal
    const sending = f.buffer({ action: 'send', all: true }, exec)
    await firstStart.promise; controller.abort(); release.resolve()
    const value = await sending
    assert.equal(value.ok, true); assert.equal(calls.length, 2)
    assert.equal(calls[1].params.message.find(part => part.type === 'image').data.file, 'base64://YQ==')
  } finally { release.resolve(); await f.bridge.dispose() }
})

test('restart distinguishes unsent reservations and uncertain sends; a failed send does not finish the turn', async () => {
  const f = await fixture()
  try {
    await f.bridge.deliver(f.delivery('reserved'))
    await f.bridge.deliver(f.delivery('sending'))
    const box = await f.store.outbox(f.binding.id)
    box.entries[0].state = 'reserved'; box.entries[1].state = 'sending'
    await f.store.recordOutbox(f.binding.id, box)
    const read = await f.buffer({ action: 'read' })
    assert.deepEqual(read.items.map(item => item.state), ['draft', 'unknown'])
    f.bridge.onebot.call = async () => { throw Object.assign(new Error('rejected'), { code: 'ONEBOT_API_REJECTED', deliveryState: 'failed' }) }
    let finished = 0; const exec = f.exec(); exec.concludeTurn = () => { finished++ }
    const send = await f.buffer({ action: 'send', id: 'reserved', finish: true }, exec)
    assert.equal(send.ok, false); assert.equal(finished, 0)
  } finally { await f.bridge.dispose() }
})

test('a partially completed multi-line delivery is unknown and never repeated automatically', async () => {
  const f = await fixture(); let count = 0
  try {
    f.bridge.onebot.call = async () => { if (++count === 1) return { message_id: 1 }; throw Object.assign(new Error('connection lost'), { code: 'ONEBOT_RESPONSE_UNKNOWN' }) }
    await f.bridge.deliver(f.delivery('partial', text('first\nsecond')))
    const send = await f.buffer({ action: 'send', id: 'partial' })
    assert.equal(send.receipts[0].state, 'unknown'); assert.equal(count, 2)
    assert.equal((await f.buffer({ action: 'send', id: 'partial', retry: true })).code, 'QQ_OUTBOX_EMPTY')
    assert.equal(count, 2)
  } finally { await f.bridge.dispose() }
})

test('failed media preparation records a retryable failure before any network call', async () => {
  const f = await fixture()
  try {
    const image = { type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
    f.bridge.media.export = async () => { throw Object.assign(new Error('missing image'), { code: 'ATTACHMENT_NOT_FOUND' }) }
    await f.bridge.deliver(f.delivery('image', [image]))
    const failed = await f.buffer({ action: 'send', id: 'image' })
    assert.equal(failed.receipts[0].state, 'failed'); assert.equal(f.calls.length, 0)
    f.bridge.media.export = async () => ({ file: 'base64://YQ==' })
    assert.equal((await f.buffer({ action: 'send', id: 'image', retry: true })).receipts[0].state, 'delivered')
    assert.equal(f.calls.length, 1)
  } finally { await f.bridge.dispose() }
})

test('capacity cleanup removes only oldest confirmed sends, keeping unsent and uncertain drafts', async () => {
  const f = await fixture()
  try {
    const entries = Array.from({ length: 500 }, (_, i) => ({ id: `old-${i}`, state: i === 1 ? 'unknown' : i === 2 ? 'draft' : 'sent', delivery: f.delivery(`old-${i}`), createdAt: i, attempts: 1 }))
    await f.store.recordOutbox(f.binding.id, { version: 1, bindingId: f.binding.id, endpoint: f.binding.endpoint, entries })
    assert.equal((await f.bridge.deliver(f.delivery('new'))).state, 'buffered')
    const box = await f.store.outbox(f.binding.id)
    assert.equal(box.entries.length, 500); assert.ok(!box.entries.some(item => item.id === 'old-0'))
    assert.ok(box.entries.some(item => item.id === 'old-1')); assert.ok(box.entries.some(item => item.id === 'old-2')); assert.ok(box.entries.some(item => item.id === 'new'))
  } finally { await f.bridge.dispose() }
})

test('earlier queue settings load, save, restart and allow switching the group binding', async () => {
  const old = { enabled: true, sendEnabled: true, bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, sendEnabled: true }], merge: { enabled: true, windowMs: 3000, maxWaitMs: 20000, maxMessages: 12, maxChars: 16000 } }
  const config = normalizeConfig(old), store = new MemoryQqStore(config)
  assert.equal(config.merge.maxMessages, 256); assert.equal(config.merge.maxChars, 1048576)
  await store.setConfig(config)
  const loaded = store.config()
  assert.deepEqual(loaded.merge, config.merge); assert.equal(loaded.bindings[0].endpoint, 'group:456')
  await store.setConfig({ ...loaded, bindings: [{ ...loaded.bindings[0], id: undefined, endpoint: 'group:789' }] })
  const restarted = new MemoryQqStore(store.config()).config()
  assert.equal(restarted.bindings[0].endpoint, 'group:789'); assert.equal(restarted.merge.maxMessages, 256)
})

test('a burst of a hundred same-group messages is held in order while the first is prepared', async () => {
  const f = await fixture(), firstStart = defer(), release = defer(), seen = []
  try {
    f.io.receive = async request => { seen.push(request.externalMessageId); if (seen.length === 1) { firstStart.resolve(); await release.promise } return { state: 'accepted', traceId: `t${seen.length}` } }
    f.bridge.onebot.call = async () => ({ nickname: 'name', card: 'card', title: 'title' })
    const event = id => ({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 789, self_id: 111, message_id: id, sender: { nickname: 'name', card: 'card', title: 'title' }, message: [{ type: 'text', data: { text: String(id) } }] })
    const first = f.bridge.receive(event(1)); await firstStart.promise
    const pending = Array.from({ length: 99 }, (_, i) => f.bridge.receive(event(i + 2)))
    release.resolve(); await Promise.all([first, ...pending])
    assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => String(i + 1)))
  } finally { release.resolve(); await f.bridge.dispose() }
})
