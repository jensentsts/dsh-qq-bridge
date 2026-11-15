import test from 'node:test'
import assert from 'node:assert/strict'
import { QqHistoryTools } from '../lib/history-tool.mjs'
const binding = (extra = {}) => ({ id: 'b', endpoint: 'group:456', sessionId: 's', enabled: true, admission: { enabled: true, allowedSenders: ['123'] }, ...extra })
const agent = { id: 's' }
const definition = (helper, value = binding()) => {
  const defs = []
  const registration = helper.register(value, agent, { register(tool) { defs.push(tool); return () => {} } })
  assert.equal(registration.state, 'applied')
  assert.equal(defs.length, 1)
  return defs[0]
}
test('qq_history reads only the current group, validates ownership, filters permission, bounds count/cursor and strips media payloads', async () => {
  const calls = [], rows = [
    { message_id: 101, message_type: 'group', group_id: 456, user_id: 123, sender: { user_id: 123, nickname: 'Alice' }, time: 100, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'image', data: { file: 'C:\\secret\\pic.png', name: 'C:\\secret\\pic.png', url: 'https://example.test/pic.png' } }, { type: 'json', data: { data: '{"title":"card"}' } }] },
    { message_id: 102, message_type: 'group', group_id: 999, user_id: 123, sender: { user_id: 123 }, time: 101, message: [{ type: 'text', data: { text: 'other group' } }] },
    { message_id: 103, message_type: 'group', group_id: 456, user_id: 777, sender: { user_id: 777 }, time: 102, message: [{ type: 'text', data: { text: 'not allowed' } }] },
    { message_id: 105, message_type: 'group', group_id: 456, user_id: 999, sender: { user_id: 999, nickname: 'Bot' }, time: 103, message: [{ type: 'text', data: { text: 'bot reply' } }] },
    { message_id: 'bad', group_id: 456, message: [] },
    { message_id: 106, message_type: 'group', user_id: 123, message: 'unconfirmed group' },
  ]
  const onebot = { async call(action, params) { calls.push({ action, params }); return action === 'get_login_info' ? { user_id: 999 } : { messages: rows } } }
  let current = binding()
  const helper = new QqHistoryTools({ onebot, binding: () => current, networkEnabled: () => true, enabled: () => true, now: () => 1000 })
  const output = await definition(helper).execute({ count: 50, cursor: '42', group_id: 999 }, { agent, signal: new AbortController().signal })
  assert.equal(output.ok, true)
  const historyCall = calls.find(call => call.action === 'get_group_msg_history')
  assert.deepEqual(historyCall.params, { group_id: 456, count: 20, message_seq: 42 })
  const value = JSON.parse(output.text)
  assert.equal(value.bindingId, 'b'); assert.equal(value.endpoint, 'group:456'); assert.equal(value.cursor, 42); assert.equal(value.count, 2); assert.equal(value.skipped, 4)
  assert.deepEqual(value.messages.map(message => message.messageId), ['101', '105'])
  assert.equal(value.messages[0].senderId, '123'); assert.equal(value.messages[0].time, 100); assert.equal(value.messages[0].text, 'hello')
  assert.deepEqual(value.messages[0].media, [{ type: 'image', name: 'pic.png' }])
  assert.deepEqual(value.messages[0].rich, [{ type: 'json' }])
  assert.match(value.messages[1].senderName, /Bot/)
  const wire = JSON.stringify(value)
  assert.doesNotMatch(wire, /C:\\\\secret|https:\/\/example\.test|file_id|base64|"card"/)
})
test('qq_history verifies private rows and refuses invalid cursor or disabled network/binding without requesting history', async () => {
  const calls = []
  const onebot = { async call(action, params) { calls.push({ action, params }); if (action === 'get_login_info') return { user_id: 999 }; return { messages: [
    { message_id: 201, message_type: 'private', user_id: 789, sender: { user_id: 789, nickname: 'Peer' }, time: 1, message: [{ type: 'text', data: { text: 'incoming' } }] },
    { message_id: 202, message_type: 'private', user_id: 999, target_id: 789, sender: { user_id: 999 }, time: 2, message: [{ type: 'text', data: { text: 'outgoing' } }] },
    { message_id: 203, message_type: 'private', user_id: 999, target_id: 123, sender: { user_id: 999 }, time: 3, message: [{ type: 'text', data: { text: 'other chat' } }] },
    { message_id: 204, message_type: 'group', group_id: 456, user_id: 789, sender: { user_id: 789 }, time: 4, message: [] },
  ] } } }
  let current = binding({ endpoint: 'private:789', admission: { enabled: false, allowedSenders: [] } })
  const helper = new QqHistoryTools({ onebot, binding: () => current, networkEnabled: () => true, enabled: () => true, now: () => 1000 })
  const tool = definition(helper, current)
  const output = await tool.execute({ count: 10 }, { agent, signal: new AbortController().signal })
  const value = JSON.parse(output.text)
  assert.deepEqual(value.messages.map(message => message.messageId), ['201', '202'])
  assert.equal(value.skipped, 2)
  const beforeCursor = calls.length
  assert.equal((await tool.execute({ cursor: 'abc' }, { agent, signal: new AbortController().signal })).ok, false)
  assert.equal(calls.length, beforeCursor)
  const offline = new QqHistoryTools({ onebot, binding: () => current, networkEnabled: () => false, enabled: () => true })
  const offlineTool = definition(offline, current)
  const offlineCalls = calls.length
  assert.equal((await offlineTool.execute({ count: 5 }, { agent, signal: new AbortController().signal })).ok, false)
  assert.equal(calls.length, offlineCalls)
  current = binding({ endpoint: 'private:789', enabled: false })
  const disabledCalls = calls.length
  assert.equal((await tool.execute({ count: 5 }, { agent, signal: new AbortController().signal })).ok, false)
  assert.equal(calls.length, disabledCalls)
})
test('qq_history discards a response when the binding is revoked during its read', async () => {
  let current = binding({ admission: { enabled: false, allowedSenders: [] } })
  const tool = definition(new QqHistoryTools({
    onebot: { async call() { current = { ...current, enabled: false }; return { messages: [{ message_id: 1, group_id: 456, message: 'revoked' }] } } },
    binding: () => current, networkEnabled: () => true, enabled: () => true,
  }), current)
  const output = await tool.execute({}, { agent, signal: new AbortController().signal })
  assert.equal(output.ok, false)
  assert.doesNotMatch(output.text, /revoked/)
})

test('history keeps same-second chat order and exposes mentions and reply targets', async () => {
  const current = binding({ admission: { enabled: false, allowedSenders: [] } })
  const helper = new QqHistoryTools({
    onebot: { async call(action) { return action === 'get_login_info' ? { user_id: 999 } : { messages: [
      { message_id: 90, message_type: 'group', group_id: 456, user_id: 123, time: 10, sender: { user_id: 123, title: '管理员' }, message: [{ type: 'text', data: { text: '上一句' } }] },
      { message_id: 2, message_type: 'group', group_id: 456, user_id: 123, time: 10, sender: { user_id: 123 }, message: [{ type: 'reply', data: { id: 90 } }, { type: 'at', data: { qq: 999 } }, { type: 'text', data: { text: '下一句' } }] },
    ] } } },
    binding: () => current, networkEnabled: () => true, enabled: () => true,
  })
  const value = JSON.parse((await definition(helper, current).execute({}, { agent, signal: new AbortController().signal })).text)
  assert.deepEqual(value.messages.map(row => row.messageId), ['90', '2'])
  assert.equal(value.messages[0].senderTitle, '管理员')
  assert.equal(value.messages[1].replyTo, '90'); assert.deepEqual(value.messages[1].mentions, ['999'])
})
