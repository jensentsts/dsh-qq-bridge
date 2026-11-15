import test from 'node:test'
import assert from 'node:assert/strict'
import { QqGroupAlbums } from '../lib/group-album.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const pic = id => ({ type: 'image', attachment: { attachmentId: id, bytes: 4 } })
function fixture() {
  const one = { id: 'qq-bridge-001:group:100', endpoint: 'group:100', label: '一群', sessionId: 'session-1', enabled: true, sendEnabled: true }
  const two = { id: 'qq-bridge-001:group:200', endpoint: 'group:200', label: '二群', sessionId: 'session-2', enabled: true, sendEnabled: true }
  const facts = { turn: 3, active: true, exclusive: true, bindingId: one.id, inputs: ['42'] }
  const messages = [{ role: 'user', source: { kind: 'super-agent-io', bindingId: one.id }, content: [pic('a'), pic('b')] }]
  const agent = { id: one.sessionId, session: { deriveMessages: () => messages } }
  const exec = { agent, signal: new AbortController().signal, callId: 'c1' }
  const state = { albums: [{ id: 'A', name: '相册 A', picNum: 5 }], uploads: [], reads: [], active: true, online: true, exported: [] }
  const bridge = {
    controller: new AbortController(), store: new MemoryQqStore(),
    config: { enabled: true, sendEnabled: true, bindings: [one, two], outboundTargets: [], baseUrl: 'http://127.0.0.1:3000' },
    networkEnabled: () => state.online,
    sendTarget: id => bridge.config.sendEnabled && bridge.config.bindings.find(row => row.id === id && row.enabled && row.sendEnabled),
    statusTarget: id => bridge.config.bindings.find(row => row.id === id && row.enabled),
    async _deliveryFlight(key, fn) { return fn() },
    onebot: {
      async callRaw(action, params, options) {
        options.beforeSend()
        if (action === 'get_group_album_list') { state.reads.push(params); return { ok: true, data: state.albums } }
        assert.equal(action, 'upload_image_to_qun_album')
        state.uploads.push(params)
        return state.answer ?? { ok: true, data: null }
      },
      async call(action, params, options) {
        options.beforeSend(); assert.equal(action, 'get_msg')
        return state.qqMessages?.[params.message_id]
      },
    },
    media: {
      async admit(part) { return pic(part.file) },
      async resolveOutbound(part) { return pic(part.path ?? part.url) },
      async export(block) { state.exported.push(block.attachment.attachmentId); return { file: 'base64://dGVzdA==' } },
    },
  }
  const projection = { stateOf: () => facts }
  const service = new QqGroupAlbums(bridge, { projection })
  const bound = service.definitions({ binding: one, agent, current: () => state.active })
  const owner = service.definitions()
  const authorize = () => ({ callId: exec.callId, reply: { sessionId: exec.agent.id, seq: 2 } })
  return { one, two, facts, messages, agent, exec, state, bridge, bound, owner, authorize }
}

test('读取当前群和指定群相册，其他会话可选择目标', async () => {
  const f = fixture()
  const current = await f.bound.list.execute({}, f.exec)
  assert.equal(JSON.parse(current.text).group, '100')
  assert.equal(JSON.parse(current.text).albums[0].name, '相册 A')
  assert.equal(JSON.parse((await f.bound.list.execute({ group: '二群' }, f.exec)).text).group, '200')
  const selection = JSON.parse((await f.owner.list.execute({}, f.exec, f.authorize)).text)
  assert.equal(selection.groups.length, 2)
  f.state.albums = Array.from({ length: 101 }, (_, i) => ({ id: String(i), name: `相册${i}` }))
  const page = JSON.parse((await f.bound.list.execute({}, f.exec)).text)
  assert.equal(page.albums.length, 100); assert.equal(page.nextOffset, 100)
  assert.equal(JSON.parse((await f.bound.list.execute({ offset: 100 }, f.exec)).text).albums.length, 1)
})

test('按相册上传最近消息的指定图片，重复调用只提交一次', async () => {
  const f = fixture()
  const result = await f.bound.upload.execute({ imageIndex: 2 }, f.exec)
  assert.equal(result.ok, true)
  assert.deepEqual(f.state.exported, ['b'])
  assert.deepEqual(f.state.uploads, [{ group_id: '100', album_id: 'A', album_name: '相册 A', file: 'base64://dGVzdA==' }])
  assert.equal((await f.bound.upload.execute({ imageIndex: 2 }, f.exec)).code, 'QQ_ALBUM_ALREADY_UPLOADED')
  assert.equal((await f.bound.upload.execute({ imageIndex: 1 }, f.exec)).code, 'QQ_ALBUM_ACTION_CONFLICT')
  assert.equal(f.state.uploads.length, 1)
})

test('缺少相册或多相册时要求选择；图片序号仅对应最近一条有图片的消息', async () => {
  const f = fixture()
  f.state.albums = []
  assert.equal((await f.bound.upload.execute({}, f.exec)).code, 'QQ_ALBUM_NOT_FOUND')
  f.state.albums = [{ id: 'A', name: '相册 A' }, { id: 'B', name: '相册 B' }]
  assert.equal((await f.bound.upload.execute({}, f.exec)).code, 'QQ_ALBUM_SELECTION_REQUIRED')
  f.messages.push({ role: 'user', content: [pic('new')] })
  assert.equal((await f.bound.upload.execute({ albumName: '相册 B', imageIndex: 2 }, f.exec)).ok, false)
  assert.equal(f.state.uploads.length, 0)
  assert.equal((await f.bound.upload.execute({ albumName: '相册 B' }, f.exec)).ok, true)
  assert.equal(f.state.uploads[0].album_id, 'B'); assert.equal(f.state.exported[0], 'new')
})

test('接受当前 QQ 群的图片或回复图片，并校验来源群', async () => {
  const f = fixture()
  f.state.qqMessages = {
    1: { message_id: 1, message_type: 'group', group_id: 100, sender: { user_id: 10 }, message: [{ type: 'reply', data: { id: '2' } }] },
    2: { message_id: 2, message_type: 'group', group_id: 100, sender: { user_id: 10 }, message: [{ type: 'image', data: { file: 'from-qq' } }] },
    3: { message_id: 3, message_type: 'group', group_id: 200, sender: { user_id: 10 }, message: [{ type: 'image', data: { file: 'wrong-group' } }] },
  }
  assert.equal((await f.bound.upload.execute({ messageId: '3' }, f.exec)).ok, false)
  assert.equal((await f.bound.upload.execute({ messageId: '1' }, f.exec)).ok, true)
  assert.equal(f.state.exported[0], 'from-qq')
})

test('其他本机会话可指定群和工作区图片，发送关闭或上下文变化时停止', async () => {
  const f = fixture()
  const value = await f.owner.upload.execute({ group: '200', file: 'picture.png' }, f.exec, f.authorize)
  assert.equal(value.ok, true); assert.equal(f.state.uploads[0].group_id, '200'); assert.equal(f.state.exported[0], 'picture.png')
  f.exec.callId = 'c2'; f.bridge.config.sendEnabled = false
  assert.equal((await f.owner.upload.execute({ group: '200', file: 'a.png' }, f.exec, f.authorize)).ok, false)
  f.bridge.config.sendEnabled = true; f.facts.exclusive = false
  assert.equal((await f.bound.upload.execute({}, f.exec)).code, 'QQ_ALBUM_TURN_CHANGED')
})

test('结果未确认时同一操作不重复提交', async () => {
  const f = fixture()
  f.state.answer = { ok: false, code: 'ONEBOT_RESPONSE_UNKNOWN' }
  assert.equal((await f.bound.upload.execute({}, f.exec)).ok, false)
  assert.equal((await f.bound.upload.execute({}, f.exec)).ok, false)
  assert.equal(f.state.uploads.length, 1)
})
