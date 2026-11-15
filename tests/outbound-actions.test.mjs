import test from 'node:test'
import assert from 'node:assert/strict'
import { IoCore } from '../../dsh-super-agent-io/core.mjs'
import { MemoryStore } from '../../dsh-super-agent-io/store.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { InboundPolicy } from '../lib/admission.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { QqHistoryTools } from '../lib/history-tool.mjs'
import { moderationTool } from '../lib/moderation.mjs'
import { normalizeEvent } from '../lib/onebot.mjs'
import { createOneBotClient } from '../lib/onebot-http.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const signal = new AbortController().signal
const origin = callId => ({ callId, reply: { version: 1, sessionId: 'owner-dsh', seq: 4, messageId: 'assistant', turn: 1, step: 1, time: 0, source: { kind: 'model', provider: 'test', model: 'test' } } })
const outgoingGroup = 'qq-bridge-001:outbound:group:300'
const outgoingPrivate = 'qq-bridge-001:outbound:private:400'
const configured = {
  sendEnabled: true,
  outboundTargets: [
    { endpoint: 'group:300', label: '测试群' },
    { endpoint: 'private:400', label: '测试好友' },
    { endpoint: 'private:401', enabled: false },
  ],
}

async function fixture(t, config = configured) {
  const calls = [], store = new MemoryQqStore(config), ioStore = new MemoryStore()
  const io = await new IoCore({ store: ioStore, host: { resolveAgent() { assert.fail('Send-only QQ must not open a DSH session') } }, config: { enabled: true, sendEnabled: true } }).start()
  const backend = {
    selfId: 123, role: 'admin', recallAllowed: true, kickAllowed: true, groupId: 300, senderId: 456, type: 'group',
    noticeResponse: { status: 'ok', retcode: 0, data: null },
  }
  let bridge, ttsCalls = 0
  const onebot = createOneBotClient({
    config: () => bridge.config,
    async fetch(url, options) {
      const action = new URL(url).pathname.slice(1), params = JSON.parse(options.body)
      calls.push({ action, params })
      let data
      if (action === 'get_login_info') data = { user_id: backend.selfId }
      else if (action === 'get_group_member_info') data = { group_id: params.group_id, user_id: params.user_id, role: String(params.user_id) === String(backend.selfId) ? backend.role : 'member' }
      else if (action === 'get_group_admin_permissions') data = { recall_member_message: backend.recallAllowed, kick_member: backend.kickAllowed }
      else if (action === 'get_msg') data = { message_id: params.message_id, message_type: backend.type, group_id: backend.type === 'group' ? backend.groupId : undefined, target_id: backend.type === 'private' ? 400 : undefined, sender: { user_id: backend.senderId }, message: 'some text' }
      else if (action === 'get_group_msg_history') data = { messages: [
        { message_id: -77, message_type: 'group', group_id: 300, sender: { user_id: 456, card: '成员' }, time: 1, message: '最近一条' },
        { message_id: 50, message_type: 'group', group_id: 500, sender: { user_id: 456 }, message: '其他群' },
      ] }
      else if (action === 'send_group_msg' || action === 'send_private_msg') data = { message_id: 700 + calls.length }
      else if (action === '_send_group_notice') return Response.json(backend.noticeResponse)
      else if (['set_group_kick', 'set_group_ban', 'delete_msg'].includes(action)) data = null
      else assert.fail(`Unexpected mocked OneBot action ${action}`)
      return Response.json({ status: 'ok', retcode: 0, data })
    },
  })
  bridge = new QqBridge({ io, store, config, onebot, synthesize: async () => { ttsCalls++; return 'fake.amr' } })
  t.after(async () => { await bridge.dispose(); await io.close() })
  await bridge.start()
  return { bridge, io, ioStore, store, onebot, calls, backend, ttsCalls: () => ttsCalls }
}

test('QQ group native mentions are readable in array and CQ formats and match the bot mention rule', async () => {
  const store = new MemoryQqStore()
  const policy = new InboundPolicy({ store })
  const [binding] = normalizeConfig({ bindings: [{ endpoint: 'group:300', sessionId: 'group-session', admission: { enabled: true, mentionOnly: true } }] }).bindings
  const incoming = (message_id, message) => normalizeEvent({ post_type: 'message', message_type: 'group', message_id, group_id: 300, self_id: 123, user_id: 456, message })
  const native = incoming(1, [{ type: 'at', data: { qq: 123 } }, { type: 'text', data: { text: ' 你好' } }])
  const string = incoming(2, '[CQ:at,name=bot,qq=123] 你好')
  for (const event of [native, string]) {
    assert.deepEqual(event.mentions, ['123'])
    assert.equal(event.text, '@123 你好')
    assert.equal((await policy.decide(event, binding)).mentioned, true)
  }
  assert.equal((await policy.decide(incoming(3, '@123 你好'), binding)).reason, 'NOT_MENTIONED')
  assert.equal((await policy.decide(incoming(4, [{ type: 'at', data: { qq: '456' } }]), binding)).reason, 'NOT_MENTIONED')
})

test('an owner can discover, probe and explicitly send to a QQ group without a QQ input or DSH binding', async t => {
  const { bridge, io, ioStore, calls, ttsCalls } = await fixture(t, { ...configured, voice: { enabled: true } })
  const search = await io.destinations({ channel: 'qq', query: '测试群' }, origin('find'), signal)
  assert.deepEqual(search.items, [{ destination: outgoingGroup, label: '测试群', channel: 'qq', outboundOnly: true, textHint: 'QQ 群聊正文用 @QQ号 点名具体成员。' }])
  assert.equal((await io.probe({ destination: outgoingGroup }, origin('probe'), signal)).available, true)
  assert.deepEqual(calls.map(call => call.action), ['get_login_info'])
  const text = '请@456 看看。 @789 也来\n`@333` [@444](https://example.com/) https://example.com/path-@555 \\@666 x@777.example'
  assert.equal((await io.sendExplicit({ destination: outgoingGroup, text }, origin('send'), signal)).state, 'delivered')
  const [sent, second] = calls.filter(call => call.action === 'send_group_msg')
  assert.equal(sent.action, 'send_group_msg')
  assert.equal(sent.params.group_id, '300')
  assert.equal(sent.params.auto_escape, true)
  assert.deepEqual(sent.params.message.filter(part => part.type === 'at').map(part => part.data.qq), ['456', '789'])
  assert.equal(second.params.message.some(part => part.type === 'at'), false)
  assert.equal(ttsCalls(), 0)
  assert.equal(io.listBindings().length, 0)
  assert.equal(ioStore.entries('traces').length, 0)
  assert.equal(ioStore.entries('deliveries')[0][1].sessionId, 'owner-dsh')
  await bridge.save({ ...configured, outboundTargets: [{ endpoint: 'private:400' }] })
  await assert.rejects(io.sendExplicit({ destination: outgoingGroup, text }, origin('removed'), signal), { code: 'DESTINATION_UNAVAILABLE' })
  assert.equal((await io.probe({ destination: outgoingGroup }, origin('probe-removed'), signal)).available, false)
})

test('automatic group replies preserve the native quote and paragraph split alongside a mention', async t => {
  const { bridge, calls, ttsCalls } = await fixture(t, { enabled: true, sendEnabled: true, voice: { enabled: true }, bindings: [
    { id: 'group', endpoint: 'group:300', sessionId: 'group-session', enabled: true, sendEnabled: true, preload: false },
  ] })
  const reply = { ...origin('automatic').reply, sessionId: 'group-session', content: [{ type: 'text', text: '@456 收到\n\n第二条' }] }
  assert.equal((await bridge.deliver({ bindingId: 'group', endpoint: 'group:300', deliveryId: 'automatic', reply, replyTo: '-77' })).state, 'delivered')
  assert.deepEqual(calls[0].params.message.map(part => part.type), ['reply', 'at', 'text'])
  assert.equal(calls[0].params.message[0].data.id, '-77')
  assert.deepEqual(calls[1].params.message, [{ type: 'text', data: { text: '第二条' } }])
  assert.equal(ttsCalls(), 0)
})

test('private sends preserve @QQ text and a send-only chat cannot receive', async t => {
  const { bridge, io, calls } = await fixture(t)
  assert.equal((await io.sendExplicit({ destination: outgoingPrivate, text: '@456 你好' }, origin('private'), signal)).state, 'delivered')
  assert.deepEqual(calls[0].params.message, [{ type: 'text', data: { text: '@456 你好' } }])
  assert.throws(() => io.receive({ bindingId: outgoingPrivate, externalMessageId: '1', content: [{ type: 'text', text: 'input' }] }), { code: 'BINDING_NOT_FOUND' })
  assert.equal(bridge.config.enabled, false)
})

test('QQ moderation validates QQ admin permissions and sends exact actions after DSH approval', async t => {
  const { bridge, backend, calls } = await fixture(t)
  const approvals = []
  const tool = moderationTool(bridge, { networkEnabled: () => true, approval: () => ({ async request(req) { approvals.push(req); return 'allowed-once' } }) })
  const run = (id, params) => tool.execute({ destination: outgoingGroup, ...params }, { agent: {}, name: tool.name, signal, callId: id }, () => origin(id))
  const kick = { action: 'kick', userId: '456' }
  const results = await Promise.all([run('kick', kick), run('kick', kick)])
  assert.ok(results.every(result => result.ok))
  assert.equal((await run('mute', { action: 'mute', userId: '456', durationSeconds: 600 })).ok, true)
  assert.equal((await run('unmute', { action: 'unmute', userId: '456' })).ok, true)
  assert.equal((await run('notice', { action: 'announce', content: '开会', pinned: true })).ok, true)
  assert.equal((await run('recall', { action: 'recall', messageId: '-77' })).ok, true)
  assert.deepEqual(calls.filter(call => /^(set_|delete_|_send_)/.test(call.action)), [
    { action: 'set_group_kick', params: { group_id: '300', user_id: '456', reject_add_request: false } },
    { action: 'set_group_ban', params: { group_id: '300', user_id: '456', duration: 600 } },
    { action: 'set_group_ban', params: { group_id: '300', user_id: '456', duration: 0 } },
    { action: '_send_group_notice', params: { group_id: '300', content: '开会', type: 1, pinned: 1, tip_window_type: 1, confirm_required: 0, is_show_edit_card: 0 } },
    { action: 'delete_msg', params: { message_id: -77 } },
  ])
  assert.equal(approvals.length, 5)
  assert.match(approvals.at(-1).reason, /group:300.*\n消息 -77，发送者 QQ 456/)
  assert.equal((await run('kick', { ...kick, userId: '457' })).code, 'QQ_ACTION_CONFLICT')
  backend.noticeResponse = { status: 'failed', retcode: 1200, wording: '群公告权限不足' }
  assert.deepEqual(await run('notice-rejected', { action: 'announce', content: '开会' }), { ok: false, state: 'failed', code: 'ONEBOT_API_REJECTED', retcode: 1200, detail: '群公告权限不足' })
})

test('QQ recall rejects another chat and unprivileged requests before dispatch', async t => {
  const { bridge, backend, calls } = await fixture(t)
  let answer = 'rejected'
  const tool = moderationTool(bridge, { networkEnabled: () => true, approval: () => ({ async request() { return answer } }) })
  const run = (id, destination = outgoingGroup) => tool.execute({ destination, action: 'recall', messageId: '-77' }, { agent: {}, name: tool.name, signal, callId: id }, () => origin(id))
  backend.groupId = 500
  assert.equal((await run('wrong-chat')).code, 'QQ_MESSAGE_TARGET_UNVERIFIED')
  backend.groupId = 300
  backend.role = 'member'
  assert.equal((await run('member')).code, 'QQ_GROUP_ADMIN_REQUIRED')
  backend.role = 'admin'
  backend.recallAllowed = false
  assert.equal((await run('admin-disabled')).code, 'QQ_GROUP_ADMIN_PERMISSION_DENIED')
  backend.recallAllowed = true
  assert.equal((await run('denied')).code, 'APPROVAL_NOT_GRANTED')
  backend.type = 'private'
  await bridge.store.recordMessage('-77', 'private:400')
  assert.equal((await run('someone-else', outgoingPrivate)).code, 'QQ_RECALL_OTHER_GROUP_ONLY')
  assert.equal(calls.filter(call => call.action === 'delete_msg').length, 0)
  answer = 'allowed-once'
  backend.senderId = 123
  assert.equal((await run('own', outgoingPrivate)).ok, true)
  assert.equal(calls.filter(call => call.action === 'delete_msg').length, 1)
})

test('QQ owner tools read bounded recent message IDs and revalidate an approved action', async t => {
  const { bridge, onebot, calls } = await fixture(t)
  const history = new QqHistoryTools({ onebot, networkEnabled: () => true }).ownerTool(bridge)
  const receipt = await history.execute({ destination: outgoingGroup, count: 2 }, { signal }, () => origin('history'))
  assert.deepEqual(JSON.parse(receipt.text).messages.map(message => [message.messageId, message.senderId]), [['-77', '456']])
  let active = true
  const tool = moderationTool(bridge, { networkEnabled: () => true, approval: () => ({ async request() { active = false; return 'allowed-once' } }) })
  const cancelled = await tool.execute({ destination: outgoingGroup, action: 'mute', userId: '456', durationSeconds: 600 }, { agent: {}, name: tool.name, signal, callId: 'revoke' }, () => {
    if (!active) throw new Error('owner turn ended')
    return origin('revoke')
  })
  assert.equal(cancelled.code, 'OUTBOUND_FORBIDDEN')
  assert.equal(calls.some(call => call.action === 'set_group_ban'), false)
})
