import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { normalizeEvent } from '../lib/onebot.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const text = text => ({ type: 'text', data: { text } })
const sender = { user_id: 1234567890, nickname: '示例kite', card: '示例kite', title: '' }
const event = (message_id, message, author = sender) => ({
  post_type: 'message', message_type: 'group', group_id: 123, self_id: 555,
  user_id: author.user_id, message_id, sender: author, message,
})

async function fixture(t) {
  const config = { enabled: true, bindings: [{ id: 'group', endpoint: 'group:123', sessionId: 'dsh', enabled: true, preload: false }] }
  const inputs = [], image = { type: 'image', attachment: { attachmentId: 'image', name: 'quote.png' } }
  const state = { original: event(41, [text('原消息第一行\r\n原消息第二行'), { type: 'image', data: { file: 'quote.png', name: 'quote.png' } }]) }
  const io = {
    contractVersion: 1, registerTransport() { return () => {} }, putBinding: async binding => binding,
    async receive(input) { inputs.push(input); return { state: 'accepted', traceId: String(inputs.length) } },
  }
  const onebot = { async call(action) {
    if (action === 'get_msg') return state.original
    if (action === 'get_group_member_info') return sender
    assert.fail(`unexpected OneBot action ${action}`)
  } }
  const bridge = await new QqBridge({ io, onebot, config, store: new MemoryQqStore(config), media: { async admit() { return image } } }).start()
  t.after(() => bridge.dispose())
  return { bridge, inputs, image, state }
}

test('a QQ reply presents the quoted message before the sender body using Markdown quotes', async t => {
  const { bridge, inputs, image } = await fixture(t)
  await bridge.receive(event(42, [{ type: 'reply', data: { id: 41 } }, text('发言')]))
  assert.equal(inputs[0].replyTo, '41')
  assert.equal(inputs[0].senderId, '1234567890')
  assert.deepEqual(inputs[0].content, [
    { type: 'text', text: '1234567890 示例kite【示例kite】:\n\n> 原消息第一行\n> 原消息第二行\n> [图片 quote.png]\n\n发言' },
    image,
  ])
})

test('merged QQ messages repeat only the sender line and body', async t => {
  const { bridge } = await fixture(t)
  const binding = bridge.config.bindings[0]
  const messages = [
    normalizeEvent(event(42, [text('第一句')])),
    normalizeEvent(event(43, [text('第二句')], { user_id: 777, nickname: 'QQ名字', title: '群头衔', card: '群昵称' })),
  ]
  const items = []
  for (const event of messages) items.push({ event, content: (await bridge._prepare(event, binding)).content })
  assert.deepEqual(bridge._mergeContent(items), [{
    type: 'text', text: '1234567890 示例kite【示例kite】:\n\n第一句\n\n777 QQ名字<群头衔>【群昵称】:\n\n第二句',
  }])
})

test('a reply from another QQ group is excluded from the quote block', async t => {
  const { bridge, inputs, state } = await fixture(t)
  state.original = { ...state.original, group_id: 999 }
  await bridge.receive(event(42, [{ type: 'reply', data: { id: 41 } }, text('发言')]))
  assert.equal(inputs[0].content[0].text, '1234567890 示例kite【示例kite】:\n\n发言')
  assert.ok(inputs[0].content.every(block => block.type === 'text' && !block.text.includes('原消息')))
})

test('CQ reply segments produce the same quote as the OneBot array format', async t => {
  const { bridge, inputs } = await fixture(t)
  await bridge.receive(event(42, '[CQ:reply,id=41]发言'))
  assert.equal(inputs[0].replyTo, '41')
  assert.match(inputs[0].content[0].text, /\n> 原消息第一行\n> 原消息第二行/)
})
