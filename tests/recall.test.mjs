import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { QqHistoryTools } from '../lib/history-tool.mjs'
import { boundRecallTool, moderationTool } from '../lib/moderation.mjs'
import { QqRecallFeed, snowLumaRecallSocket } from '../lib/recall-feed.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const origin = 'http://127.0.0.1:3000'
const sentAt = 1794463200
const group = { id: 'group', endpoint: 'group:300', sessionId: 'group-session', label: '群', enabled: true, sendEnabled: true, preload: false }
const direct = { id: 'direct', endpoint: 'private:400', sessionId: 'direct-session', label: '私聊', enabled: true, sendEnabled: true, preload: false }
const msg = (id, message, user = 456) => ({
  post_type: 'message', message_type: 'group', self_id: 123, group_id: 300, user_id: user, message_id: id,
  sender: { nickname: '原作者', card: '群昵称', title: '头衔' }, time: sentAt, message,
})
const notice = (id, options = {}) => ({
  post_type: 'notice', notice_type: 'group_recall', time: sentAt + 10, self_id: 123, group_id: 300,
  user_id: 456, operator_id: 789, message_id: id, ...options,
})
const body = value => [{ type: 'text', text: value }]

async function fixture(t, bindings = [group, direct]) {
  const config = { enabled: true, sendEnabled: true, bindings, baseUrl: origin }
  const store = new MemoryQqStore(config), inputs = [], actions = [], known = new Map()
  const io = {
    contractVersion: 1, registerTransport() { return () => {} }, async putBinding(row) { return row },
    async receive(input) { inputs.push(input); return { state: 'accepted', traceId: 'trace-' + inputs.length } },
  }
  const onebot = {
    async call(action, params) {
      if (action === 'get_login_info') return { user_id: 123 }
      if (action === 'get_msg') {
        if (!known.has(params.message_id)) throw new Error('original unavailable')
        return known.get(params.message_id)
      }
      if (action === 'get_group_member_info') return { role: 'owner', ...params }
      if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') return { messages: [...known.values()] }
      if (action === 'send_group_msg') { actions.push({ action, params }); return { message_id: -21 } }
      throw new Error(action)
    },
    async callRaw(action, params, { beforeSend }) {
      beforeSend()
      actions.push({ action, params })
      return { ok: true }
    },
  }
  const bridge = await new QqBridge({ io, onebot, store, config }).start()
  t.after(() => bridge.dispose())
  return { bridge, store, inputs, known, actions, onebot }
}

test('admin recall captures a prior original even when its ordinary reply was filtered, without waking the Agent', async t => {
  const { bridge, store, inputs } = await fixture(t, [{ ...group, admission: { enabled: true, mentionOnly: true } }])
  const original = msg(-10, [{ type: 'text', data: { text: '原句一\n原句二' } }, { type: 'image', data: {} }])
  assert.equal((await bridge.receive(original)).reason, 'NOT_MENTIONED')
  await Promise.all([bridge.receive(notice(-10)), bridge.receive(notice(-10))])
  assert.equal(inputs.length, 0)
  const [row] = await store.recallsFor(group.endpoint)
  assert.deepEqual({ ...row }, { origin, endpoint: group.endpoint, messageId: '-10', authorId: '456', operatorId: '789',
    at: (sentAt + 10) * 1000, authorName: '群昵称', excerpt: '原句一\n原句二 [图片]', messageTime: sentAt * 1000 })
  assert.equal((await store.recallsFor(group.endpoint)).length, 1)
  const mentioned = id => msg(id, [{ type: 'at', data: { qq: 123 } }, { type: 'text', data: { text: '继续' } }])
  await bridge.receive(mentioned(11))
  await bridge.receive(mentioned(12))
  assert.match(inputs[0].content[0].text, /789 撤回了 456 群昵称 的一条消息.*消息 -10，原消息发送于 .*\n> 原句一\n> 原句二 \[图片\]/)
  assert.doesNotMatch(inputs[1].content[0].text, /撤回记录/)
})

test('a private recall uses the verified original sender, and old or out-of-scope content stays unavailable', async t => {
  const { bridge, store, known } = await fixture(t)
  const privateNotice = id => notice(id, { notice_type: 'friend_recall', user_id: 400 })
  known.set(40, { message_id: 40, message_type: 'private', user_id: 400, sender: { user_id: 400, nickname: '好友' }, time: sentAt, message: '私聊旧消息' })
  known.set(41, { message_id: 41, message_type: 'private', user_id: 123, sender: { user_id: 123 }, target_id: 500, message: '其他聊天' })
  await bridge.receive(privateNotice(40))
  await bridge.receive(privateNotice(41))
  assert.equal((await bridge.receive(notice(42, { group_id: 999 }))).ignored, true)
  const rows = await store.recallsFor(direct.endpoint)
  assert.equal(rows.find(row => row.messageId === '40').operatorId, '400')
  const absent = rows.find(row => row.messageId === '41')
  assert.equal(absent.operatorId, '')
  assert.equal(absent.excerpt, undefined)
})

test('an authorized DSH tool recalls a verified own message and history retains the original', async t => {
  const { bridge, store, known, actions, onebot } = await fixture(t)
  known.set(-19, { message_id: -19, message_type: 'private', user_id: 123, sender: { user_id: 123, nickname: '大肥鱼' }, target_id: 400, time: sentAt, message: '刚才发错的文字' })
  const tool = moderationTool(bridge, { networkEnabled: () => true, approval: () => assert.fail('own recall requires no second confirmation') })
  const exec = { signal: new AbortController().signal }
  const run = () => tool.execute({ action: 'recall', destination: direct.id, messageId: '-19' }, exec, () => ({ callId: 'withdraw', reply: { sessionId: 'owner', seq: 2 } }))
  assert.equal((await run()).ok, true)
  assert.equal((await run()).ok, true)
  assert.deepEqual(actions, [{ action: 'delete_msg', params: { message_id: -19 } }])
  known.clear()
  const history = new QqHistoryTools({ onebot, store, networkEnabled: () => true, origin: () => origin }).ownerTool(bridge)
  const value = JSON.parse((await history.execute({ destination: direct.id }, exec, () => ({}))).text)
  assert.equal(value.recalls[0].excerpt, '刚才发错的文字')
  assert.equal(value.recalls[0].operatorId, '123')
  assert.equal(value.recalls[0].messageId, '-19')
  assert.equal((await store.recallsFor(direct.endpoint)).length, 1)
})

test('the bound Agent can withdraw its own delivered output, with other senders and expired scope rejected', async t => {
  const { bridge, store, known, actions } = await fixture(t)
  known.set(-21, { message_id: -21, message_type: 'group', group_id: 300, sender: { user_id: 123 }, time: sentAt, message: '已送达' })
  known.set(-22, { message_id: -22, message_type: 'group', group_id: 300, sender: { user_id: 456 }, time: sentAt, message: '群友发言' })
  await store.recordMessage('-21', group.endpoint, { outbound: true, origin, originSessionId: group.sessionId })
  let current = true
  const tool = boundRecallTool(bridge, group, () => current ? { sessionId: group.sessionId, seq: 10 } : undefined)
  const run = (messageId, callId) => tool.execute({ messageId }, { signal: new AbortController().signal, callId })
  assert.equal((await run('-22', 'other')).code, 'QQ_RECALL_NOT_OWN_MESSAGE')
  assert.equal((await run('-21', 'own')).ok, true)
  current = false
  assert.equal((await run('-21', 'stale')).code, 'QQ_RECALL_SCOPE_UNAVAILABLE')
  assert.equal(actions.filter(row => row.action === 'delete_msg').length, 1)
})

test('local SnowLuma events use the event URL and matching account and never enter normal message delivery', async t => {
  const { bridge, store, inputs } = await fixture(t)
  const config = { networks: { httpServers: [{ host: '127.0.0.1', port: 3000 }], wsServers: [
    { host: '127.0.0.1', port: 3001, path: '/', role: 'Universal', accessToken: 'mock-token' },
  ] } }
  assert.equal(snowLumaRecallSocket(config, 'http://localhost:9000'), undefined)
  assert.equal(snowLumaRecallSocket(config, origin).url, 'ws://127.0.0.1:3001/event')
  let ws
  class Socket extends EventTarget {
    constructor(url, options) {
      super()
      assert.equal(url, 'ws://127.0.0.1:3001/event')
      assert.equal(options.headers.Authorization, 'Bearer mock-token')
      ws = this
    }
    push(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
    close() { this.dispatchEvent(new Event('close')) }
  }
  const feed = new QqRecallFeed({ bridge, file: 'example', Socket, readConfig: async () => config })
  t.after(() => feed.dispose())
  await feed.sync()
  ws.dispatchEvent(new Event('open'))
  assert.equal(feed.status, 'connected')
  ws.push(msg(80, '先看到原消息'))
  const typing = { post_type: 'notice', notice_type: 'notify', sub_type: 'input_status', self_id: 123, user_id: 400, event_type: 1, status_text: '对方正在输入...' }
  ws.push({ ...typing, self_id: 999 })
  assert.equal(bridge.peerTyping('private:400').state, 'unknown')
  ws.push(typing)
  assert.equal(bridge.peerTyping('private:400').state, 'reported')
  assert.equal(bridge.peerTyping('private:400').statusText, '对方正在输入...')
  const read = await bridge.outbox.apply({ action: 'read' }, { target: bridge.config.bindings.find(row => row.id === 'direct'), anchor: {}, guard() {} })
  assert.equal(read.peerInput.statusText, '对方正在输入...')
  bridge.peerInputStates.get('private:400').expiresAt = Date.now() - 1
  assert.equal(bridge.peerTyping('private:400').state, 'unknown')
  assert.deepEqual(await bridge.receive(typing, { via: 'webhook' }), { recorded: true, kind: 'peer-input-status' })
  ws.push({ ...typing, user_id: 401 })
  assert.equal(bridge.peerTyping('private:401').state, 'unknown')
  ws.push(notice(80, { self_id: 999 }))
  ws.push(notice(80))
  await Promise.all([...feed.jobs])
  assert.equal(inputs.length, 0)
  const rows = await store.recallsFor(group.endpoint)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].excerpt, '先看到原消息')
  await bridge.save({ ...bridge.config, enabled: false })
  await feed.sync()
  assert.equal(feed.connection, undefined)
  assert.equal(bridge.peerTyping('private:400').state, 'unknown')
})
