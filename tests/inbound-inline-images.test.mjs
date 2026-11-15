import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { normalizeSegments } from '../lib/onebot.mjs'
import { createMediaAdapter } from '../lib/media.mjs'
import { MemoryQqStore } from '../lib/store.mjs'

const imageUrl = 'https://qqbot.ugcimg.cn/102076836/example/image'
const fakeImage = Buffer.from('89504e470d0a1a0a', 'hex')
const sourceText = `@群友\n![图片 #780px #780px](${imageUrl})`
const button = { type: 'inline_keyboard', data: { rows: [{ buttons: [{ label: '查看提示' }] }] } }

function fixture({ rich = { cards: true, forwards: true, forwardMedia: true }, getForward } = {}) {
  const config = { enabled: true, rich, bindings: [{ id: 'group', endpoint: 'group:123', sessionId: 'dsh', enabled: true }] }
  const received = [], fetched = [], saved = []
  const media = createMediaAdapter({
    fetch: async url => { fetched.push(url); return new Response(fakeImage, { headers: { 'content-type': 'image/png' } }) },
    attachments: { async saveImage({ data, mediaType }) { saved.push(Buffer.from(data)); return { attachmentId: 'image-' + saved.length, bytes: data.length, mediaType, width: 1, height: 1 } } },
  })
  const onebot = { async call(action, args) {
    if (action === 'get_forward_msg' && getForward) return getForward(args.message_id)
    if (action === 'get_group_member_info') return {}
    throw new Error('Unexpected OneBot action: ' + action)
  } }
  const io = { contractVersion: 1, registerTransport: () => () => {}, putBinding: async binding => binding,
    async receive(input) { received.push(input); return { state: 'accepted', traceId: String(received.length) } } }
  const bridge = new QqBridge({ config, store: new MemoryQqStore(config), onebot, io, media })
  return { bridge, received, fetched, saved }
}
const event = (id, message) => ({ post_type: 'message', message_type: 'group', group_id: 123, user_id: 456,
  self_id: 789, message_id: id, sender: { nickname: '游戏机器人' }, message })

test('QQ bot Markdown image reaches the incoming DSH message as an image with its buttons intact', async t => {
  const normalized = normalizeSegments([{ type: 'text', data: { text: sourceText } }, button])
  assert.equal(normalized.media.length, 1)
  assert.equal(normalized.media[0].url, imageUrl)
  const f = fixture(); await f.bridge.start(); t.after(() => f.bridge.dispose())
  await f.bridge.receive(event(1, [{ type: 'text', data: { text: sourceText } }, button]))
  assert.equal(f.received.length, 1)
  assert.ok(f.received[0].content.some(block => block.type === 'image' && block.attachment.attachmentId === 'image-1'))
  assert.ok(f.received[0].content.some(block => block.text?.includes('查看提示')))
  assert.deepEqual(f.fetched, [imageUrl]); assert.deepEqual(f.saved, [fakeImage])
})

test('SnowLuma Markdown and identical text fallback produce one card and one image', async t => {
  const message = [{ type: 'at', data: { qq: '789' } }, { type: 'markdown', data: { content: sourceText } },
    { type: 'text', data: { text: sourceText } }, button]
  const normalized = normalizeSegments(message)
  assert.equal(normalized.media.length, 1)
  assert.equal(normalized.text.split(sourceText).length - 1, 1)
  const f = fixture(); await f.bridge.start(); t.after(() => f.bridge.dispose())
  await f.bridge.receive(event(11, message))
  assert.equal(f.received[0].content.filter(block => block.type === 'image').length, 1)
  assert.deepEqual(f.fetched, [imageUrl])
})

test('the Markdown message segment and image inside nested forwarded messages are admitted', async t => {
  const f = fixture({ getForward: id => id === 'outer' ? { messages: [{ sender: { nickname: 'A' }, content: [
    { type: 'markdown', data: { text: sourceText } }, { type: 'forward', data: { id: 'inner' } },
  ] }] } : { messages: [{ sender: { nickname: 'B' }, content: [
    { type: 'text', data: { text: `![另一张](${imageUrl}?second=1)` } },
  ] }] } })
  await f.bridge.start(); t.after(() => f.bridge.dispose())
  await f.bridge.receive(event(2, [{ type: 'forward', data: { id: 'outer' } }]))
  const content = f.received[0].content
  assert.equal(content.filter(block => block.type === 'image').length, 2)
  assert.ok(content.some(block => block.text?.includes('A')))
  assert.ok(content.some(block => block.text?.includes('B')))
  assert.equal(f.fetched.length, 2)
})

test('an image field in a QQ shared card reaches DSH as an attachment', async t => {
  const f = fixture(); await f.bridge.start(); t.after(() => f.bridge.dispose())
  const card = { app: 'share', meta: { news: { title: '卡片', preview: imageUrl } } }
  await f.bridge.receive(event(3, [{ type: 'json', data: { data: JSON.stringify(card) } }]))
  assert.equal(f.received[0].content.filter(block => block.type === 'image').length, 1)
  assert.deepEqual(f.fetched, [imageUrl])
})

test('inline extraction respects the configured forward-image switch and media origins', async t => {
  const f = fixture({ rich: { cards: true, forwards: true, forwardMedia: false }, getForward: () => ({ messages: [
    { sender: { nickname: 'A' }, content: [{ type: 'text', data: { text: sourceText } }] },
  ] }) })
  await f.bridge.start(); t.after(() => f.bridge.dispose())
  await f.bridge.receive(event(4, [{ type: 'forward', data: { id: 'outer' } }]))
  assert.equal(f.received[0].content.filter(block => block.type === 'image').length, 0)
  await f.bridge.receive(event(5, [{ type: 'text', data: { text: '![x](http://127.0.0.1/private)' } }]))
  assert.deepEqual(f.fetched, [])
  assert.ok(f.received[1].content.some(block => block.text?.includes('附件未读取')))
})
