import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { QqHistoryTools } from '../lib/history-tool.mjs'
import { normalizeSegments } from '../lib/onebot.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const captions = ['查看提示', '猜词', '使用帮助']
const buttons = { type: 'inline_keyboard', data: {
  bot_appid: '1234',
  rows: [{ buttons: captions.map(label => ({ label, id: 'opaque-id', type: 2, data: 'button-action' })) }],
} }
const card = { message_id: 42, message_type: 'group', group_id: 123, user_id: 456,
  sender: { user_id: 456, card: '游戏机器人', nickname: '游戏机器人', title: '机器人' },
  message: [{ type: 'text', data: { text: '你有 10 次机会猜一个四字成语。' } }, buttons],
}

test('OneBot reads native QQ button captions in row order', () => {
  const nested = { type: 'keyboard', data: { content: {
    rows: [{ buttons: [{ render_data: { label: '下一页' }, action: { data: 'button-action' } }] }],
  } } }
  const result = normalizeSegments([...card.message, nested])
  assert.match(result.text, /你有 10 次机会猜一个四字成语/)
  assert.ok(result.text.includes(JSON.stringify([captions])))
  assert.ok(result.text.includes(JSON.stringify([['下一页']])))
  assert.doesNotMatch(result.text, /opaque-id|button-action/)
  assert.equal(result.truncated, false)
})

test('button text follows the inbound character budget', () => {
  const long = { type: 'inline_keyboard', data: { rows: [{ buttons: [{ label: '长'.repeat(150) }] }] } }
  const result = normalizeSegments([long], { maxTextChars: 50 })
  assert.equal(result.text.length, 50)
  assert.equal(result.truncated, true)
  const invalid = { type: 'inline_keyboard', data: { rows: [null, { buttons: [{ data: 'button-action' }, { label: {} }] }] } }
  assert.equal(normalizeSegments([invalid]).text, '')
})

test('incoming, quoted and historical QQ messages all expose the button captions', async t => {
  const config = { enabled: true, bindings: [{ id: 'group', endpoint: 'group:123', sessionId: 'dsh', enabled: true, preload: false }] }
  const store = new MemoryQqStore(config), received = []
  const io = {
    contractVersion: 1, registerTransport() { return () => {} },
    putBinding: async binding => binding,
    async receive(input) { received.push(input); return { state: 'accepted', traceId: 'trace-' + received.length } },
  }
  const onebot = { async call(action, params) {
    if (action === 'get_msg') { assert.equal(String(params.message_id), '42'); return card }
    if (action === 'get_group_msg_history') { assert.equal(String(params.group_id), '123'); return { messages: [card] } }
    assert.fail(`unexpected OneBot call ${action}`)
  } }
  const bridge = await new QqBridge({ io, onebot, store, config }).start()
  t.after(() => bridge.dispose())
  const event = { ...card, post_type: 'message', self_id: 789 }
  await bridge.receive(event)
  await bridge.receive({ ...event, message_id: 43, message: [
    { type: 'reply', data: { id: 42 } }, { type: 'text', data: { text: '有哪些按钮？' } },
  ] })
  assert.equal(received.length, 2)
  for (const input of received) {
    const text = input.content.map(block => block.text).join('\n')
    for (const caption of captions) assert.ok(text.includes(caption))
    assert.doesNotMatch(text, /button-action/)
  }
  const binding = bridge.config.bindings[0]
  const history = new QqHistoryTools({ onebot, binding: () => binding, enabled: () => true, networkEnabled: () => true })
  const agent = {}, signal = new AbortController().signal
  let tool
  history.register(binding, agent, { register(definition) { tool = definition; return () => {} } })
  const result = await tool.execute({}, { agent, signal })
  assert.equal(result.ok, true)
  assert.ok(JSON.parse(result.text).messages[0].text.includes(JSON.stringify([captions])))
})
