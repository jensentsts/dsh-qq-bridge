import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { splitChatMessages } from '../lib/onebot.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const signal = new AbortController().signal
const text = value => ({ type: 'text', text: value })
const dataText = value => ({ type: 'text', data: { text: value } })
const quote = { type: 'reply', data: { id: '41' } }
const image = { type: 'image', data: { file: 'base64://image' } }

function fixture({ voice = {}, send = async (_, index) => ({ message_id: 700 + index }), synthesize, typingWait = async () => {} } = {}) {
  const calls = [], indicators = [], store = new MemoryQqStore()
  const config = {
    enabled: true, sendEnabled: true, voice, bindings: [
      { id: 'private', endpoint: 'private:123', sessionId: 'private-session', enabled: true, sendEnabled: true, preload: false },
      { id: 'group', endpoint: 'group:456', sessionId: 'group-session', enabled: true, sendEnabled: true, preload: false },
    ],
  }
  const io = { contractVersion: 1, registerTransport: () => () => {}, putBinding: async row => row, listBindings: () => [] }
  const bridge = new QqBridge({ io, store, config, synthesize, typingWait, confirmTypingClock: false,
    onebot: { async call(action, params) { if (action === 'set_input_status') { indicators.push(params); return {} } const item = { action, params }; calls.push(item); return send(item, calls.length) } },
    media: { async export() { return { file: image.data.file } } },
  })
  return { bridge, calls, indicators, store }
}

function delivery(id, content, { group = false, explicit = false } = {}) {
  return {
    deliveryId: id, bindingId: group ? 'group' : 'private', endpoint: group ? 'group:456' : 'private:123',
    ...(explicit ? { intent: 'explicit' } : { replyTo: '41', quoteChosen: true }),
    reply: {
      sessionId: explicit ? 'owner-session' : group ? 'group-session' : 'private-session',
      source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content,
    },
  }
}

async function sendFromBuffer(bridge, value) {
  const staged = await bridge.deliver(value, { signal })
  assert.equal(staged.state, 'buffered')
  const target = bridge.sendTarget(value.bindingId, true)
  const answer = await bridge.outbox.commit({ id: value.deliveryId }, { target, agent: { id: value.reply.sessionId }, guard() {} })
  return answer.receipts?.[0] ?? answer
}

test('typing delay follows each multilingual text message and skips image-only content', async t => {
  const events = [], { bridge, calls, indicators } = fixture({
    typingWait: async ms => events.push({ type: 'typing', ms }),
    send: async (action, index) => { events.push({ type: 'send', message: action.params.message }); return { message_id: index } },
  })
  await bridge.start()
  t.after(() => bridge.dispose())
  const content = [text('中文\nHello world\n'), { type: 'image', attachment: { name: 'x.png', bytes: 1 } }]
  assert.equal((await sendFromBuffer(bridge, delivery('typing-split', content))).state, 'delivered')
  assert.equal(calls.length, 3)
  assert.deepEqual(events.map(event => event.type), ['typing', 'send', 'typing', 'send', 'send'])
  assert.ok(events[0].ms > 0 && events[0].ms <= 10000)
  assert.ok(events[2].ms > events[0].ms && events[2].ms <= 10000)
  assert.deepEqual(indicators, [{ user_id: '123', event_type: 1 }, { user_id: '123', event_type: 1 }])
})

test('real CRLF, LF and CR break lines, while literal backslash sequences and blank lines stay distinct', () => {
  const message = { action: 'send_private_msg', params: { user_id: '123', auto_escape: true, message: [
    quote, dataText('第一行\r\n第二行\\n字面\\r\r第三行\n\n第四行\n'),
  ] } }
  const rows = splitChatMessages(message).map(item => item.params.message)
  assert.deepEqual(rows, [[quote, dataText('第一行')], [dataText('第二行\\n字面\\r')], [dataText('第三行')], [dataText('第四行')]])
  const unchanged = { ...message, params: { ...message.params, message: [dataText('原文\\n原文')] } }
  assert.equal(splitChatMessages(unchanged)[0], unchanged)
  assert.deepEqual(splitChatMessages(undefined), [])
})

test('sends mixed lines, native mentions, images and code in their original order from the buffer', async t => {
  const { bridge, calls } = fixture()
  await bridge.start()
  t.after(() => bridge.dispose())
  const content = [
    text('@789 第一行\n'),
    { type: 'image', attachment: { name: 'x.png', bytes: 1 } },
    text('\n第三行\\n字面\r第四行\n```\n@333\n```'),
  ]
  assert.equal((await sendFromBuffer(bridge, delivery('group-lines', content, { group: true }))).state, 'delivered')
  assert.deepEqual(calls.map(row => row.params.message), [
    [quote, { type: 'at', data: { qq: '789' } }, dataText(' 第一行')],
    [image],
    [dataText('第三行\\n字面')],
    [dataText('第四行')],
    [dataText('```')],
    [dataText('@333')],
    [dataText('```')],
  ])
})

test('a DSH-initiated send uses the same rule with no artificial limit on the number of lines', async t => {
  const { bridge, calls } = fixture()
  await bridge.start()
  t.after(() => bridge.dispose())
  const lines = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行`)
  assert.equal((await sendFromBuffer(bridge, delivery('explicit-lines', [text(lines.join('\n'))], { explicit: true }))).state, 'delivered')
  assert.deepEqual(calls.map(row => row.params.message[0].data.text), lines)
  assert.ok(calls.every(row => row.params.message.length === 1))
})

test('voice mode synthesizes each line and honors the keep-text setting and native quote', async t => {
  const spoken = []
  const { bridge, calls } = fixture({
    voice: { enabled: true, keepText: true },
    synthesize: async value => { spoken.push(value); return 'file:///' + spoken.length + '.mp3' },
  })
  await bridge.start()
  t.after(() => bridge.dispose())
  assert.equal((await sendFromBuffer(bridge, delivery('voice-lines', [text('第一句\n第二句')]))).state, 'delivered')
  assert.deepEqual(spoken, ['第一句', '第二句'])
  assert.deepEqual(calls.map(row => row.params.message), [
    [{ type: 'record', data: { file: 'file:///1.mp3' } }],
    [quote, dataText('第一句')],
    [{ type: 'record', data: { file: 'file:///2.mp3' } }],
    [dataText('第二句')],
  ])
})

test('voice-only mode emits one voice message per line', async t => {
  const spoken = []
  const { bridge, calls } = fixture({
    voice: { enabled: true, keepText: false },
    synthesize: async value => { spoken.push(value); return 'file:///' + spoken.length + '.mp3' },
  })
  await bridge.start()
  t.after(() => bridge.dispose())
  assert.equal((await sendFromBuffer(bridge, delivery('voice-only', [text('第一句\n第二句')]))).state, 'delivered')
  assert.deepEqual(spoken, ['第一句', '第二句'])
  assert.deepEqual(calls.map(row => row.params.message), [
    [{ type: 'record', data: { file: 'file:///1.mp3' } }],
    [{ type: 'record', data: { file: 'file:///2.mp3' } }],
  ])
})

test('a partially failed multi-line send is recorded and never automatically repeated', async t => {
  const { bridge, calls } = fixture({ send: async (_, index) => {
    if (index === 2) throw Object.assign(new Error('send failed'), { code: 'ONEBOT_API_REJECTED', deliveryState: 'failed' })
    return { message_id: 700 + index }
  } })
  await bridge.start()
  t.after(() => bridge.dispose())
  const value = delivery('partly-failed', [text('第一条\n第二条\n第三条')])
  assert.equal((await sendFromBuffer(bridge, value)).state, 'unknown')
  assert.equal((await sendFromBuffer(bridge, value)).code, 'QQ_OUTBOX_EMPTY')
  assert.equal(calls.length, 2)
})
