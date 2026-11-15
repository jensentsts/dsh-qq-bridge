import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { createOneBotClient } from '../lib/onebot-http.mjs'
import { QqRecallFeed } from '../lib/recall-feed.mjs'
import { QqStatus, qqStatusText, qqStatusTool } from '../lib/status.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const origin = 'http://127.0.0.1:3000', endpoint = 'group:300', selfId = 123
const time = Date.parse('2026-11-12T11:30:00Z')
const binding = { id: 'group', endpoint, sessionId: 'group-session', label: '群', enabled: true, sendEnabled: true, preload: false }
const config = { enabled: true, sendEnabled: true, baseUrl: origin, bindings: [binding] }
const allowed = () => true
const notice = (options = {}) => ({
  post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban', self_id: selfId,
  group_id: 300, user_id: selfId, time: time / 1000, duration: 60, ...options,
})

function fixture() {
  const calls = [], backend = { role: 'member', online: true, good: true, whole: 0, muted: 0, joined: true, hasStatus: true }
  const controller = new AbortController()
  let now = time, beforeRequest
  const onebot = createOneBotClient({
    config: () => config,
    async token(url) { await beforeRequest?.(url); return '' },
    async fetch(url, options) {
      const action = new URL(url).pathname.slice(1), params = JSON.parse(options.body)
      calls.push({ action, params })
      let data
      if (action === 'get_status') {
        if (!backend.hasStatus) return Response.json({ status: 'failed', retcode: 1404 })
        data = { online: backend.online, good: backend.good }
      } else if (action === 'get_login_info') data = { user_id: selfId, nickname: '鱼' }
      else if (action === 'get_group_info') data = { group_id: 300, member_count: 18, group_all_shut: backend.whole }
      else if (action === 'get_group_member_info') data = {
        group_id: Number(params.group_id), user_id: Number(params.user_id), nickname: backend.joined ? '鱼' : '',
        role: backend.role, join_time: backend.joined ? 1700000000 : 0, shut_up_timestamp: backend.muted,
      }
      else if (action === 'get_group_list') data = backend.joined ? [{ group_id: 300 }] : []
      else if (action === 'send_group_msg') data = { message_id: 700 }
      else throw new Error('Unexpected action ' + action)
      return Response.json({ status: 'ok', retcode: 0, data })
    },
  })
  const status = new QqStatus({ onebot, origin: () => origin, networkEnabled: allowed, signal: () => controller.signal,
    groupAllowed: value => value === endpoint, now: () => now })
  return { status, calls, backend, controller, onebot, advance(ms) { now += ms }, onToken(fn) { beforeRequest = fn } }
}

test('coalesces queries and uses the verified account, group and mute expiry', async () => {
  const { status, calls, backend, advance } = fixture()
  backend.muted = time / 1000 + 60
  const states = await Promise.all([status.read(endpoint), status.read(endpoint), status.read(endpoint)])
  assert.ok(states.every(row => row.account.online && row.canSend === false && row.reason === 'QQ_GROUP_MEMBER_MUTED'))
  assert.equal(states[0].chat.mutedUntil, time + 60000)
  assert.match(qqStatusText(states[0]), /被禁言.*北京时间/)
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.find(row => row.action === 'get_group_member_info').params, { group_id: '300', user_id: '123', no_cache: true })
  advance(60001)
  assert.equal(status.snapshot(endpoint).canSend, true)
})

test('individual notices affect only this account in this group and survive a stale status read until lifted', async () => {
  const { status } = fixture()
  assert.equal((await status.read(endpoint)).canSend, true)
  assert.equal(status.observe(notice({ user_id: 456 }), selfId), false)
  assert.equal(status.observe(notice({ group_id: 999 }), selfId), false)
  assert.equal(status.observe(notice({ self_id: 789 }), selfId), false)
  assert.equal(status.observe(notice(), selfId), true)
  assert.equal((await status.read(endpoint, { refresh: true })).reason, 'QQ_GROUP_MEMBER_MUTED')
  assert.equal(status.observe(notice({ sub_type: 'lift_ban', time: time / 1000 + 1, duration: 0 }), selfId), true)
  status.observe(notice(), selfId)
  assert.equal(status.snapshot(endpoint).canSend, true)
})

test('zero target triggers verification and a confirmed whole-group mute only blocks a regular member', async () => {
  const { status, backend } = fixture()
  await status.read(endpoint)
  status.observe(notice({ user_id: 0 }), selfId)
  assert.equal((await status.read(endpoint)).canSend, true)
  backend.whole = -1
  status.observe(notice({ user_id: 0 }), selfId)
  assert.equal((await status.read(endpoint)).reason, 'QQ_GROUP_ALL_MUTED')
  backend.role = 'admin'
  const admin = await status.read(endpoint, { refresh: true })
  assert.equal(admin.chat.wholeMuted, true)
  assert.equal(admin.canSend, true)
  assert.match(qqStatusText(admin), /管理员/)
  backend.whole = 0
  status.observe(notice({ user_id: 0, sub_type: 'lift_ban', duration: 0 }), selfId)
  assert.equal((await status.read(endpoint)).chat.wholeMuted, false)
})

test('membership and offline status are confirmed separately, and unavailable status stays unknown', async () => {
  const { status, backend } = fixture()
  backend.joined = false
  assert.equal((await status.read(endpoint)).reason, 'QQ_NOT_IN_GROUP')
  backend.joined = true
  status.observe(notice({ notice_type: 'group_increase', sub_type: 'invite' }), selfId)
  assert.equal((await status.read(endpoint)).canSend, true)
  status.observe(notice({ notice_type: 'group_decrease', sub_type: 'kick_me' }), selfId)
  assert.equal(status.snapshot(endpoint).reason, 'QQ_NOT_IN_GROUP')
  status.streamClosed()
  backend.online = false
  assert.equal((await status.read('private:800')).reason, 'QQ_ACCOUNT_OFFLINE')
  backend.hasStatus = false
  const unknown = await status.read('private:800', { refresh: true })
  assert.equal(unknown.canSend, null)
  assert.equal(unknown.reason, undefined)
})

async function bridgeFixture(t) {
  const data = fixture()
  const inboundStates = [], store = new MemoryQqStore(config)
  const io = {
    contractVersion: 1, registerTransport() { return () => {} }, async putBinding(row) { return row },
    async receive(input) {
      inboundStates.push(data.status.snapshot(endpoint))
      return { state: 'accepted', traceId: 'trace-' + input.externalMessageId }
    },
  }
  const media = { async resolveOutbound() { assert.fail('Known mute must be checked before media preparation') } }
  const bridge = await new QqBridge({ io, store, config, media, onebot: data.onebot, qqStatus: data.status }).start()
  t.after(() => bridge.dispose())
  return { ...data, bridge, inboundStates }
}

const delivery = (key, text = '好') => ({ bindingId: binding.id, endpoint, deliveryId: key,
  reply: { sessionId: binding.sessionId, source: { kind: 'model' }, content: [{ type: 'text', text }] } })

test('DSH knows the restriction before admitting a normal input, and muted deliveries never call send', async t => {
  const { backend, bridge, inboundStates, calls } = await bridgeFixture(t)
  backend.muted = time / 1000 + 60
  await bridge.receive({
    post_type: 'message', message_type: 'group', self_id: selfId, group_id: 300, user_id: 456, message_id: 9,
    sender: { nickname: '群友', card: '群友', title: '成员' }, message: '你好', time: time / 1000,
  })
  assert.equal(inboundStates[0].reason, 'QQ_GROUP_MEMBER_MUTED')
  assert.deepEqual(await bridge.deliver(delivery('muted', '![图](picture.png)')), { state: 'failed', reason: 'QQ_GROUP_MEMBER_MUTED' })
  const testSend = await bridge.sendTest({ bindingId: binding.id, endpoint, text: '测试', requestId: '1ac36e39-8c2d-411b-a864-4866a78f88d0' })
  assert.equal(testSend.reason, 'QQ_GROUP_MEMBER_MUTED')
  assert.equal(calls.some(row => row.action === 'send_group_msg'), false)
  assert.equal((await bridge.probe(binding)).available, false)
})

test('a notice received while preparing the authenticated request cancels that send, and a later new reply can send', async t => {
  const { status, bridge, calls, onToken } = await bridgeFixture(t)
  await status.read(endpoint)
  onToken(() => status.observe(notice(), selfId))
  assert.deepEqual(await bridge.deliver(delivery('race')), { state: 'failed', reason: 'QQ_GROUP_MEMBER_MUTED' })
  assert.equal(calls.some(row => row.action === 'send_group_msg'), false)
  onToken(undefined)
  status.observe(notice({ sub_type: 'lift_ban', duration: 0, time: time / 1000 + 1 }), selfId)
  assert.equal((await bridge.deliver(delivery('new'))).state, 'delivered')
  assert.equal(calls.filter(row => row.action === 'send_group_msg').length, 1)
})

test('the existing authenticated event feed and the owner status tool report the same restriction without waking DSH', async t => {
  const { status, bridge, inboundStates } = await bridgeFixture(t)
  const feed = new QqRecallFeed({ bridge, file: 'fixture' })
  const connection = { selfId: String(selfId), origin, controller: new AbortController(), socket: { close() {} } }
  feed.connection = connection
  t.after(() => feed.dispose())
  feed.onMessage(connection, JSON.stringify(notice()))
  assert.equal(status.snapshot(endpoint).reason, 'QQ_GROUP_MEMBER_MUTED')
  assert.equal(inboundStates.length, 0)
  const tool = qqStatusTool(bridge)
  const exec = { signal: new AbortController().signal }
  const result = JSON.parse((await tool.execute({ destination: binding.id }, exec, allowed)).text)
  assert.equal(result.reason, 'QQ_GROUP_MEMBER_MUTED')
  assert.match((await tool.execute({ destination: 'random-group' }, exec, allowed)).text, /io_destinations/)
})
