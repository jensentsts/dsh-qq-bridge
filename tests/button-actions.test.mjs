import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { QqButtonActions } from '../lib/button-tool.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const sender = { user_id: 777, card: '幽幽子', nickname: '幽幽子', title: '机器人' }
const command = { id: 'hint', label: '查看提示', type: 2, enter: false, is_reply: false, permission_type: 2, data: '/猜成语提示' }
const callback = { id: 'help', label: '使用帮助', type: 1, permission_type: 2, data: 'help:payload' }
const group = 123, self = 555
const at = (qq, text) => [{ type: 'at', data: { qq: String(qq) } }, { type: 'text', data: { text: ' ' + text } }]
const row = (id, seq, message, overrides = {}) => ({
  message_id: id, message_seq: seq, message_type: 'group', group_id: group, user_id: sender.user_id,
  time: Math.floor(Date.now() / 1000), sender, message, ...overrides,
})
const card = (buttons = [command, callback]) => row(-42, 12, [
  ...at(1234, '猜一个四字成语'),
  { type: 'inline_keyboard', data: { bot_appid: '56789', rows: [{ buttons }] } },
])

async function fixture(t) {
  const config = { enabled: true, sendEnabled: true, bindings: [{ id: 'group', endpoint: 'group:123', sessionId: 'qq-session', enabled: true, sendEnabled: true, preload: false }] }
  const store = new MemoryQqStore(config), writes = [], ingress = []
  const state = { original: card(), history: [row(90, 20, at(self, '旧提示'))], answer: { ok: true, data: { message_id: 101 } } }
  const io = {
    contractVersion: 1, registerTransport() { return () => {} },
    putBinding: async binding => binding,
    async receive(input) { ingress.push(input); return { state: 'accepted', traceId: 'trace-' + ingress.length } },
  }
  const onebot = {
    async call(action, args) {
      if (action === 'get_msg') { assert.equal(args.message_id, -42); return state.original }
      if (action === 'get_login_info') return { user_id: self }
      if (action === 'get_group_msg_history') { assert.equal(args.group_id, String(group)); return { messages: state.history } }
      assert.fail(`Unexpected read action ${action}`)
    },
    async callRaw(action, params, { beforeSend }) {
      beforeSend()
      writes.push({ action, params })
      await state.onWrite?.()
      return state.answer
    },
  }
  const bridge = await new QqBridge({ io, onebot, store, config }).start()
  t.after(() => bridge.dispose())
  const handler = new QqButtonActions(bridge, { networkEnabled: () => true, waitMs: 120, pollMs: 2 })
  bridge.buttonActions = handler
  const exec = (label = '查看提示', callId = 'one') => handler.definition().execute(
    { destination: 'group', messageId: '-42', buttonLabel: label },
    { signal: new AbortController().signal },
    () => ({ callId, reply: { sessionId: 'local-session', seq: 22 } }),
  )
  const receive = value => bridge.receive({ post_type: 'message', self_id: self, ...value })
  return { state, writes, ingress, exec, receive }
}

test('the actual type-2 hint button submits its recorded command and only returns an addressed new hint', async t => {
  const { state, writes, ingress, exec, receive } = await fixture(t)
  const hint = row(102, 22, at(self, '提示是第三个字为「山」。'))
  state.onWrite = async () => {
    const other = await receive(row(100, 21, at(999, '别人的提示。')))
    assert.equal(other.state, 'accepted')
    assert.equal((await receive(hint)).reason, 'QQ_BUTTON_RESPONSE')
  }
  const result = await exec()
  assert.equal(result.state, 'responded')
  assert.equal(result.response.text, '提示是第三个字为「山」。')
  assert.equal(result.sentMessageId, '101')
  assert.deepEqual(writes, [{
    action: 'send_group_msg',
    params: { group_id: '123', auto_escape: true, message: at(sender.user_id, '/猜成语提示') },
  }])
  assert.equal((await receive(hint)).reason, 'QQ_BUTTON_RESPONSE')
  assert.equal(ingress.length, 1)
  assert.equal((await exec()).code, 'QQ_BUTTON_ALREADY_SUBMITTED')
  assert.equal(writes.length, 1)
})

test('reply wait can read group history using the exact newly sent message ID', async t => {
  const { state, exec, writes } = await fixture(t)
  state.onWrite = () => {
    state.history = [
      ...state.history,
      row(103, 21, at(999, '别人的提示。')),
      row(104, 22, [{ type: 'reply', data: { id: 101 } }, { type: 'markdown', data: { content: '答案有一个 **风** 字。' } }]),
    ]
  }
  const value = await exec()
  assert.equal(value.state, 'responded')
  assert.deepEqual(value.response, { messageId: '104', senderId: '777', text: '答案有一个 **风** 字。' })
  assert.equal(writes.length, 1)
})

test('callback buttons use app ID, button ID and message sequence, and read the callback prompt', async t => {
  const { state, writes, exec } = await fixture(t)
  state.answer = { ok: true, data: { result: 0, promptText: '查看帮助' } }
  const result = await exec('使用帮助')
  assert.deepEqual(writes, [{ action: 'click_inline_keyboard_button', params: {
    group_id: '123', bot_appid: 56789, msg_seq: 12, button_id: 'help', callback_data: 'help:payload',
  } }])
  assert.deepEqual(result.response, { text: '查看帮助' })
  state.answer = { ok: true, data: { result: 9, errMsg: '权限不足' } }
  assert.deepEqual(await exec('使用帮助', 'second'), { ok: false, state: 'failed', code: 'QQ_BUTTON_REJECTED', detail: '权限不足' })
})

test('old, cross-group and unrelated responses do not become button results', async t => {
  const { state, exec, writes } = await fixture(t)
  state.onWrite = () => {
    state.history = [...state.history, row(103, 21, at(self, '别群提示'), { group_id: 999 }), row(104, 22, at(999, '别人的提示。'))]
  }
  const result = await exec()
  assert.equal(result.state, 'sent')
  assert.equal(result.code, 'QQ_BUTTON_REPLY_UNOBSERVED')
  assert.equal(writes.length, 1)
})

test('invalid group, restricted command and duplicate title cannot produce a QQ action', async t => {
  const { state, exec, writes } = await fixture(t)
  state.original.group_id = 999
  assert.equal((await exec()).code, 'QQ_BUTTON_MESSAGE_UNVERIFIED')
  state.original = card([{ ...command, permission_type: 0, specify_user_ids: ['999'] }])
  assert.equal((await exec()).code, 'QQ_BUTTON_PERMISSION_DENIED')
  state.original = card([command, command])
  assert.equal((await exec()).code, 'QQ_BUTTON_AMBIGUOUS')
  assert.equal(writes.length, 0)
})
