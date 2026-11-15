import test from 'node:test'
import assert from 'node:assert/strict'
import { boundGroupModerationTool, moderationTool } from '../lib/moderation.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const signal = new AbortController().signal
const original = () => ({ notice_id: 'old-notice', sender_id: 55, publish_time: 100, read_num: 3,
  pinned: 1, type: 1, settings: { tip_window_type: 0, confirm_required: 1, is_show_edit_card: 0 },
  message: { text: '原公告', images: [{ id: 'pic', url: 'https://gdynamic.qpic.cn/gdynamic/pic/0' }] } })

function fixture() {
  const writes = [], reads = [], approvals = [], deliveries = new MemoryQqStore(), active = new Map()
  const target = { id: 'group', endpoint: 'group:123', sessionId: 'session', label: '测试群' }
  const state = { notices: [original()], role: 'admin', requesterRole: 'admin', requester: '456', requesterGroup: '123', approve: 'allowed-once', send: { ok: true }, remove: { ok: true } }
  const bridge = { config: { baseUrl: 'http://127.0.0.1:3000' }, controller: new AbortController(), store: deliveries,
    networkEnabled: () => true, sendTarget: () => target, _deliveryFlight(key, action) { if (active.has(key)) return active.get(key); const p = Promise.resolve().then(action).finally(() => active.delete(key)); active.set(key, p); return p },
    onebot: {
      async call(action, params, options = {}) {
        options.beforeSend?.(); reads.push({ action, params })
        if (action === 'get_login_info') return { user_id: 789 }
        if (action === 'get_group_member_info') return { group_id: '123', user_id: String(params.user_id), role: String(params.user_id) === '789' ? state.role : state.requesterRole }
        if (action === 'get_msg') return { message_id: -9, message_type: 'group', group_id: state.requesterGroup, sender: { user_id: state.requester }, message: [{ type: 'text', data: { text: '请修改群公告' } }] }
        if (action === '_get_group_notice') return structuredClone(state.notices)
        throw new Error('Unexpected read action ' + action)
      },
      async callRaw(action, params, options = {}) {
        options.beforeSend?.(); writes.push({ action, params: structuredClone(params) })
        if (action === '_send_group_notice') { state.onPublish?.(); return state.send }
        if (action === '_del_group_notice') return state.remove
        throw new Error('Unexpected write action ' + action)
      },
    },
  }
  const approval = () => ({ async request(input) { approvals.push(input.reason); state.onApprove?.(); return state.approve } })
  const tool = moderationTool(bridge, { networkEnabled: () => true, approval })
  const run = (id, args) => tool.execute({ destination: 'group', ...args }, { agent: {}, name: tool.name, callId: id, signal }, () => ({ callId: id, reply: { sessionId: 'owner', seq: 1 } }))
  return { run, state, writes, reads, approvals, bridge, target, approval }
}

function boundFixture() {
  const f = fixture(), binding = f.target
  const source = { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId: binding.id, endpoint: binding.endpoint, traceId: 'trace-1', externalMessageId: '-9', senderId: '456' }
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 10 } },
    { seq: 2, type: 'step/start', data: { turn: 10, step: 1 } },
    { seq: 3, type: 'user/message', data: { role: 'user', source } },
    { seq: 4, time: 100, type: 'assistant/message', surfaceOp: 'append', data: { turn: 10, step: 1, message: { id: 'model', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'call-1', name: 'qq_group_moderate' }] } } },
    { seq: 5, type: 'tool/call', data: { turn: 10, step: 1, callId: 'call-1', name: 'qq_group_moderate' } },
  ]
  const agent = { id: 'session', session: { snapshotEvents: () => events } }
  const turn = { active: true, exclusive: true, bindingId: 'group', inputs: ['-9'], turn: 10 }
  const tool = boundGroupModerationTool(f.bridge, binding, agent, () => true, { projection: { stateOf: () => turn }, approval: f.approval })
  const exec = { agent, name: 'qq_group_moderate', callId: 'call-1', signal }
  const run = args => tool.execute({ requestMessageId: '-9', ...args }, exec)
  return { ...f, source, events, agent, turn, tool, exec, run }
}

test('list notices and edit a draft without publishing', async () => {
  const f = fixture()
  const list = await f.run('list', { action: 'list_announcements' })
  assert.equal(list.ok, true); assert.equal(list.notices[0].noticeId, 'old-notice')
  assert.equal(list.notices[0].popup, true); assert.equal(list.notices[0].images.length, 1)
  const draft = await f.run('draft', { action: 'draft_announcement', content: '新公告草稿', pinned: true, popup: true })
  assert.deepEqual(draft.draft, { content: '新公告草稿', pinned: true, newMembers: false, popup: true, confirmRequired: false, promptEditCard: false })
  assert.deepEqual(f.writes, []); assert.equal(f.approvals.length, 0)
})

test('publish supports QQ announcement options', async () => {
  const f = fixture()
  const result = await f.run('publish', { action: 'announce', content: '欢迎新成员', pinned: true, newMembers: true, popup: true, confirmRequired: true, promptEditCard: true })
  assert.equal(result.ok, true); assert.equal(f.approvals.length, 1)
  assert.deepEqual(f.writes, [{ action: '_send_group_notice', params: { group_id: '123', content: '欢迎新成员', type: 20, pinned: 1, tip_window_type: 0, confirm_required: 1, is_show_edit_card: 1 } }])
})

test('editing publishes a replacement and only then removes the selected old notice', async () => {
  const f = fixture(), args = { action: 'edit_announcement', noticeId: 'old-notice', content: '更新后的公告' }
  const result = await f.run('replace', args)
  assert.equal(result.ok, true); assert.deepEqual(result.replacement, { published: true, originalRemoved: true })
  assert.deepEqual(f.writes, [
    { action: '_send_group_notice', params: { group_id: '123', content: '更新后的公告', type: 1, pinned: 1, tip_window_type: 0, confirm_required: 1, is_show_edit_card: 0, image: 'https://gdynamic.qpic.cn/gdynamic/pic/0' } },
    { action: '_del_group_notice', params: { group_id: '123', notice_id: 'old-notice' } },
  ])
  assert.match(f.approvals[0], /新公告发布成功后删除原公告/)
  const again = await f.run('replace', args)
  assert.deepEqual(again.replacement, { published: true, originalRemoved: true }); assert.equal(f.writes.length, 2)
})

test('a failed publish preserves the old announcement; failed deletion reports partial success', async () => {
  const f = fixture(), args = { action: 'edit_announcement', noticeId: 'old-notice', content: '新公告' }
  f.state.send = { ok: false, code: 'ONEBOT_API_REJECTED' }
  const failed = await f.run('publish-failed', args)
  assert.deepEqual(failed.replacement, { published: false, originalRemoved: false })
  assert.deepEqual(f.writes.map(row => row.action), ['_send_group_notice'])
  f.state.send = { ok: true }; f.state.remove = { ok: false, code: 'ONEBOT_API_REJECTED' }
  const partial = await f.run('delete-failed', args)
  assert.equal(partial.code, 'QQ_NOTICE_PUBLISHED_DELETE_FAILED')
  assert.deepEqual(partial.replacement, { published: true, originalRemoved: false })
  const repeat = await f.run('delete-failed', args)
  assert.deepEqual(repeat.replacement, { published: true, originalRemoved: false }); assert.equal(f.writes.length, 3)
})

test('an unknown publish result never causes the original announcement to be removed', async () => {
  const f = fixture()
  f.state.send = { ok: false, code: 'ONEBOT_RESPONSE_UNKNOWN' }
  const result = await f.run('unknown-publish', { action: 'edit_announcement', noticeId: 'old-notice', content: '修改' })
  assert.equal(result.state, 'unknown')
  assert.deepEqual(result.replacement, { published: null, originalRemoved: false })
  assert.deepEqual(f.writes.map(row => row.action), ['_send_group_notice'])
})

test('the selected notice and administrator permission are checked before changes', async () => {
  const f = fixture()
  assert.equal((await f.run('missing', { action: 'delete_announcement', noticeId: 'missing' })).code, 'QQ_ANNOUNCEMENT_NOT_FOUND')
  f.state.role = 'member'
  assert.equal((await f.run('member', { action: 'announce', content: '公告' })).code, 'QQ_GROUP_ADMIN_REQUIRED')
  f.state.role = 'admin'; f.state.approve = 'rejected'
  assert.equal((await f.run('rejected', { action: 'delete_announcement', noticeId: 'old-notice' })).code, 'APPROVAL_NOT_GRANTED')
  assert.deepEqual(f.writes, [])
})

test('multiple or inaccessible original images are preserved by refusing replacement', async () => {
  const f = fixture()
  f.state.notices[0].message.images.push({ id: 'second', url: 'https://gdynamic.qpic.cn/gdynamic/second/0' })
  assert.equal((await f.run('many-images', { action: 'edit_announcement', noticeId: 'old-notice', content: '修改' })).code, 'QQ_ANNOUNCEMENT_IMAGES_UNSUPPORTED')
  f.state.notices[0].message.images = [{ id: 'pic', url: 'http://127.0.0.1/private' }]
  assert.equal((await f.run('unsafe-image', { action: 'edit_announcement', noticeId: 'old-notice', content: '修改' })).code, 'QQ_ANNOUNCEMENT_IMAGE_UNAVAILABLE')
  assert.deepEqual(f.writes, [])
})

test('unknown existing announcement options require explicit choices when replacing', async () => {
  const f = fixture()
  f.state.notices[0].settings = null
  const args = { action: 'edit_announcement', noticeId: 'old-notice', content: '修改' }
  assert.equal((await f.run('unknown-options', args)).code, 'QQ_ANNOUNCEMENT_SETTINGS_UNKNOWN')
  assert.deepEqual(f.writes, [])
  const result = await f.run('explicit-options', { ...args, popup: false, confirmRequired: true, promptEditCard: false })
  assert.equal(result.ok, true)
  assert.equal(f.writes[0].params.tip_window_type, 1)
  assert.equal(f.writes[0].params.confirm_required, 1)
})

test('a verified QQ group member can list the current group notices', async () => {
  const f = boundFixture(); f.state.requesterRole = 'member'
  const result = await f.run({ action: 'list_announcements' })
  assert.equal(result.ok, true); assert.equal(result.notices[0].noticeId, 'old-notice')
  assert.deepEqual(f.writes, []); assert.equal(f.approvals.length, 0)
})

test('a QQ-origin group write requires both requester and bot to be group administrators', async () => {
  const f = boundFixture(); f.state.requesterRole = 'member'
  assert.equal((await f.run({ action: 'announce', content: '公告' })).code, 'QQ_REQUESTER_ADMIN_REQUIRED')
  f.state.requesterRole = 'admin'; f.state.role = 'member'
  assert.equal((await f.run({ action: 'announce', content: '公告' })).code, 'QQ_GROUP_ADMIN_REQUIRED')
  assert.deepEqual(f.writes, []); assert.equal(f.approvals.length, 0)
})

test('a QQ group administrator publishes to the current group after native approval', async () => {
  const f = boundFixture()
  const result = await f.run({ action: 'announce', content: '公告', destination: 'group:999' })
  assert.equal(result.ok, true)
  assert.equal(f.writes[0].params.group_id, '123')
  assert.match(f.approvals[0], /请求者 QQ 456（消息 -9）/)
  assert.match(f.approvals[0], /原始请求：请修改群公告/)
})

test('current QQ message identity and group are verified against OneBot', async () => {
  const f = boundFixture()
  assert.equal((await f.run({ action: 'announce', content: '公告', requestMessageId: '-10' })).code, 'QQ_REQUESTER_UNVERIFIED')
  f.state.requesterGroup = '999'
  assert.equal((await f.run({ action: 'announce', content: '公告' })).code, 'QQ_REQUESTER_UNVERIFIED')
  f.state.requesterGroup = '123'; f.state.requester = '777'
  assert.equal((await f.run({ action: 'announce', content: '公告' })).code, 'QQ_REQUESTER_UNVERIFIED')
  assert.deepEqual(f.writes, [])
})

test('merged QQ input proves the original requester through the ingress receipt', async () => {
  const f = boundFixture()
  f.source.externalMessageId = 'merged-input'; delete f.source.senderId
  f.turn.inputs = ['merged-input']
  await f.bridge.store.recordIngressReceipt('group', '-9', { traceId: 'trace-1' })
  const result = await f.run({ action: 'announce', content: '合并输入中的请求' })
  assert.equal(result.ok, true); assert.equal(f.writes.length, 1)
})

test('requester and bot group roles are rechecked after DSH approval', async () => {
  const requester = boundFixture(); requester.state.onApprove = () => { requester.state.requesterRole = 'member' }
  assert.equal((await requester.run({ action: 'announce', content: '公告' })).code, 'QQ_REQUESTER_ADMIN_REQUIRED')
  assert.deepEqual(requester.writes, [])
  const bot = boundFixture(); bot.state.onApprove = () => { bot.state.role = 'member' }
  assert.equal((await bot.run({ action: 'announce', content: '公告' })).code, 'QQ_GROUP_ADMIN_REQUIRED')
  assert.deepEqual(bot.writes, [])
})

test('a role revoked after replacement publication keeps the old notice', async () => {
  const f = boundFixture(); f.state.onPublish = () => { f.state.requesterRole = 'member' }
  const result = await f.run({ action: 'edit_announcement', noticeId: 'old-notice', content: '更新' })
  assert.deepEqual(result.replacement, { published: true, originalRemoved: false })
  assert.deepEqual(f.writes.map(row => row.action), ['_send_group_notice'])
})

test('an unanchored, expired, or mixed-source QQ tool call cannot write', async () => {
  const wrong = boundFixture(); wrong.events[4].data.name = 'another_tool'
  assert.equal((await wrong.run({ action: 'announce', content: '公告' })).code, 'QQ_TOOL_ANCHOR_UNAVAILABLE')
  const expired = boundFixture(); expired.state.onApprove = () => expired.events.push({ seq: 6, type: 'step/end', data: { turn: 10, step: 1 } })
  assert.equal((await expired.run({ action: 'announce', content: '公告' })).code, 'OUTBOUND_FORBIDDEN')
  const mixed = boundFixture(); mixed.turn.exclusive = false
  assert.equal((await mixed.run({ action: 'announce', content: '公告' })).code, 'QQ_REQUESTER_UNVERIFIED')
  assert.deepEqual([...wrong.writes, ...expired.writes, ...mixed.writes], [])
})

test('a native nested tool dispatch is traced to its model tool call', async () => {
  const f = boundFixture()
  f.events[3].data.message.content = [{ type: 'tool-call', id: 'root', name: 'parent_tool' }]
  f.events[4].data = { turn: 10, step: 1, callId: 'root', name: 'parent_tool' }
  f.events.push({ seq: 6, type: 'tool/ptc-dispatch-start', data: { parentCallId: 'root', rootCallId: 'root', subCallId: 'child', name: 'qq_group_moderate' } })
  Object.assign(f.exec, { callId: 'child', rootCallId: 'root', parent: { callId: 'root' } })
  const result = await f.run({ action: 'announce', content: '嵌套调用公告' })
  assert.equal(result.ok, true); assert.equal(f.writes.length, 1)
})
