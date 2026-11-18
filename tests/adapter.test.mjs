import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeEvent, normalizeQuote, planOutbound, planVoice, parseEndpoint, TRANSPORT_ID } from '../lib/onebot.mjs'
import { createOneBotClient, managementStatus, verifyWebhookSignature, boundedBytes } from '../lib/onebot-http.mjs'
import { normalizeConfig, migrateLegacyConfig } from '../lib/config.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { SETTINGS_SECTIONS, selectedBinding, PICKER_OPTIONS } from '../lib/ui-contract.mjs'
import { admittedMediaUrl, createMediaAdapter } from '../lib/media.mjs'
const text = value => [{ type: 'text', text: value }]
const msg = (extra = {}) => ({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 41, message: [{ type: 'text', data: { text: '原文。！？\n\n[QQ]not a protocol[/QQ]' } }], ...extra })
const config = extra => normalizeConfig({ enabled: true, sendEnabled: true, bindings: [{ endpoint: 'private:123', sessionId: 's', enabled: true, sendEnabled: true, preload: true }], ...extra })
async function fixture(extra = {}) {
  const settings = config(extra.config), store = new MemoryQqStore(settings), calls = [], received = [], preloads = [], bindings = []
  let transport
  const io = { contractVersion: 1, registerTransport: t => { transport = t; return () => { transport = null } }, putBinding: async b => { bindings.push(b); return b }, preload: async id => { preloads.push(id); return { sessionId: 's', ready: true } }, receive: async input => { received.push(input); return { traceId: 't', messageId: 'm', state: 'accepted', mode: 'queue' } } }
  const onebot = { call: async (...args) => { calls.push(args); return { message_id: 700 + calls.length } } }
  const bridge = new QqBridge({ io, onebot, store, config: settings, ...extra })
  await bridge.start()
  return { bridge, io, store, calls, received, preloads, bindings, transport: () => transport, delivery: (id = 'd', content = text('未改动。！？\n\n[QQ]原样[/QQ]')) => ({ deliveryId: id, bindingId: settings.bindings[0].id, endpoint: 'private:123', replyTo: '41', traceIds: ['t'], reply: { sessionId: 's', seq: 3, messageId: id, source: { kind: 'model', provider: 'real', model: 'real' }, content } }) }
}
test('balance reply is configurable, limited to direct inputs and sent once per message', async () => {
  const quotaPolicy = { reconcile: async () => {}, arm: async () => {}, beforeInput: async () => {}, dispose: async () => {} }
  const f = await fixture({ quotaPolicy })
  const binding = f.bridge.config.bindings[0]
  assert.equal(f.bridge.config.quotaReply, '(T_T)白饭吃干净了……')
  await f.bridge.receive(msg())
  await f.bridge.sendQuotaNotice({ bindingId: binding.id, externalMessageId: '41' })
  await f.bridge.sendQuotaNotice({ bindingId: binding.id, externalMessageId: '41' })
  const sent = f.calls.filter(call => call[0] === 'send_private_msg')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0][1].message, [{ type: 'text', data: { text: '(T_T)白饭吃干净了……' } }])
  await f.bridge.dispose()

  const group = await fixture({ quotaPolicy, config: { enabled: true, sendEnabled: true, quotaReply: '稍后再聊', bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, sendEnabled: true }] } })
  const groupBinding = group.bridge.config.bindings[0]
  await group.bridge.receive(msg({ message_type: 'group', group_id: 456, user_id: 123, message_id: 51, message: [{ type: 'text', data: { text: '普通群消息' } }] }))
  await group.bridge.sendQuotaNotice({ bindingId: groupBinding.id, externalMessageId: '51' })
  assert.equal(group.calls.filter(call => call[0] === 'send_group_msg').length, 0)
  await group.bridge.receive(msg({ message_type: 'group', group_id: 456, user_id: 123, message_id: 52, message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '你好' } }] }))
  await group.bridge.sendQuotaNotice({ bindingId: groupBinding.id, externalMessageId: '52' })
  const sentGroup = group.calls.filter(call => call[0] === 'send_group_msg')
  assert.equal(sentGroup.length, 1)
  assert.deepEqual(sentGroup[0][1].message, [{ type: 'text', data: { text: '稍后再聊' } }])
  await group.bridge.dispose()
})
test('OneBot private/group identity is strict and numeric precision cannot silently change recipient', () => {
  assert.deepEqual(parseEndpoint('group:123'), { kind: 'group', id: '123' })
  assert.throws(() => parseEndpoint('group:123/456')); assert.throws(() => normalizeEvent(msg({ message_id: 1e20 })))
  assert.equal(normalizeEvent(msg({ user_id: 999 })), null)
})
test('normal text remains byte-for-byte, reply metadata separate, unknown rich payload never executed', () => {
  const value = normalizeEvent(msg({ message: [{ type: 'reply', data: { id: 4 } }, ...msg().message, { type: 'json', data: { data: 'untrusted' } }] }))
  assert.equal(value.text, msg().message[0].data.text); assert.equal(value.replyTo, '4'); assert.equal(value.warnings.length, 1)
})
test('top-level file-only and group_upload notices are not dropped', () => {
  const value = normalizeEvent(msg({ message: [], file: { id: 'file-X', name: 'only.zip', size: 9 } }))
  assert.equal(value.media[0].fileId, 'file-X'); assert.equal(value.media[0].type, 'file')
  const upload = normalizeEvent({ post_type: 'notice', notice_type: 'group_upload', user_id: 123, group_id: 456, time: 1, file: { id: 'f', name: 'new.txt' } })
  assert.equal(upload.externalMessageId, 'upload:f'); assert.equal(upload.endpoint, 'group:456')
})
test('quote is bounded, includes author/media and refuses wrong-group or unverifiable scope', () => {
  const data = { message_id: 4, message_type: 'group', group_id: 456, sender: { user_id: 321, nickname: '作者' }, message: [{ type: 'text', data: { text: 'abcdef' } }, { type: 'image', data: { url: 'https://cdn.test/i' } }, { type: 'record', data: { url: 'https://cdn.test/a' } }] }
  const quote = normalizeQuote(data, { endpoint: 'group:456', messageId: '4', maxTextChars: 3, maxMedia: 1 })
  assert.equal(quote.text, 'abc'); assert.equal(quote.senderName, '作者'); assert.equal(quote.media.length, 1); assert.equal(quote.truncated, true)
  assert.throws(() => normalizeQuote(data, { endpoint: 'group:999', messageId: '4' }))
  assert.throws(() => normalizeQuote({ ...data, message_type: undefined, group_id: undefined }, { endpoint: 'group:456', messageId: '4' }))
})
test('outbound is unsplit original text plus native reply; filters reasoning/tools', async () => {
  const value = ' A。！？\n\n[QQ]literal[/QQ] '
  const plan = await planOutbound([...text(value), { type: 'reasoning', text: 'hidden' }, { type: 'tool-call', name: 'bad' }], { endpoint: 'private:123', replyTo: '4' })
  assert.deepEqual(plan.message.params.message, [{ type: 'reply', data: { id: '4' } }, { type: 'text', data: { text: value } }]); assert.equal(plan.files.length, 0)
})
test('TTS sends standalone voice and keeps the quote on the original text', async () => {
  const p = (await planOutbound(text('全量原文'), { endpoint: 'private:123', replyTo: '4' })).message
  let synth = 0
  const voiced = await planVoice(p, { enabled: true, keepText: true }, async value => { assert.equal(value, '全量原文'); synth++; return 'file:///voice.mp3' })
  assert.equal(voiced.messages.length, 2)
  assert.deepEqual(voiced.messages[0].params.message, [{ type: 'record', data: { file: 'file:///voice.mp3' } }])
  assert.deepEqual(voiced.messages[1], p)
  const voiceOnly = await planVoice(p, { enabled: true, keepText: false }, async () => 'file:///voice.mp3')
  assert.deepEqual(voiceOnly.messages, [voiced.messages[0]])
  const mixed = { ...p, params: { ...p.params, message: [...p.params.message, { type: 'image', data: { file: 'base64://AA==' } }] } }
  assert.equal((await planVoice(mixed, { enabled: true }, async () => { synth++; return 'x' })).synthesized, false); assert.equal(synth, 1)
  assert.deepEqual((await planVoice(p, { enabled: true }, async () => { throw new Error('tts') })).messages, [p])
})
test('a selected DSH meme becomes a QQ image and only the caption is spoken', async t => {
  const pack = await mkdtemp(join(tmpdir(), 'qq-meme-test-'))
  const path = join(pack, 'sticker.gif')
  const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  await writeFile(path, image)
  t.after(async () => { await unlink(path); await rmdir(pack) })
  const caption = '双手比心卖萌，星星眼超开心'
  const memeService = {
    contractVersion: 1,
    packs: () => [{ id: 'test', path: pack }],
    search: ({ query }) => ({ ok: true, memes: query === caption ? [{ pack: 'test', path, caption }] : [] }),
  }
  const speech = []
  const f = await fixture({
    config: config({ voice: { enabled: true } }),
    media: createMediaAdapter({ memeService: () => memeService }),
    synthesize: async value => { speech.push(value); return 'file:///voice.mp3' },
  })
  t.after(() => f.bridge.dispose())
  const result = await f.bridge.deliver(f.delivery('meme', text('太好了！[表情: ' + caption + ']')))
  assert.equal(result.state, 'delivered')
  assert.deepEqual(speech, ['太好了！'])
  assert.deepEqual(f.calls.map(([, params]) => params.message), [
    [{ type: 'record', data: { file: 'file:///voice.mp3' } }],
    [{ type: 'image', data: { file: 'base64://' + image.toString('base64') } }],
  ])
})
test('file-only output uses OneBot file upload; media failure preserves text and explicit omission', async () => {
  const file = { type: 'file', attachment: { attachmentId: 'f', name: 'report.pdf', bytes: 3 } }
  const plan = await planOutbound([file], { endpoint: 'private:123', exportMedia: async () => ({ file: 'C:/durable/f', name: 'report.pdf' }) })
  assert.equal(plan.message, undefined); assert.equal(plan.files[0].action, 'upload_private_file')
  const failure = await planOutbound([...text('keep'), file], { endpoint: 'group:456', exportMedia: async () => { throw new Error('x') } })
  assert.equal(failure.message.params.message[0].data.text, 'keep'); assert.equal(failure.warnings.length, 1)
})
test('defaults deny all send/receive and migration is explicit, read-only, token-redacted', () => {
  const safe = normalizeConfig(); assert.equal(safe.enabled, false); assert.equal(safe.sendEnabled, false); assert.equal(safe.webhookEnabled, false)
  const legacy = { 总开关: true, 试运行: false, 令牌: 'secret', 通知口令: 'secret2', 绑定: [{ 类型: '私聊', 号码: '123', 会话: 's' }], 空间点赞开: true }
  const result = migrateLegacyConfig(legacy)
  assert.equal(result.config.enabled, false); assert.equal(result.config.bindings[0].enabled, false); assert.equal(result.retainedLegacy.令牌, undefined); assert.equal(result.retainedLegacy.通知口令, undefined); assert.equal(legacy.令牌, 'secret')
  assert.equal(result.retainedLegacy.空间点赞开, true)
})
test('permissions/auth fail closed including unavailable or broken Connection', () => {
  assert.equal(managementStatus(undefined, {}), 503)
  assert.equal(managementStatus({ requestRejection() { throw new Error('x') } }, {}), 503)
  assert.equal(managementStatus({ requestRejection: () => 403, admit: () => ({ rejection: 403 }) }, {}), 403)
  assert.equal(managementStatus({ requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, {}), undefined)
  assert.equal(managementStatus({ requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'guest' } } }) }, {}), 403)
})
test('webhook requires exact HMAC bytes and a nonempty secret', () => {
  const raw = Buffer.from('{"a":1}'), signature = 'sha1=' + createHmac('sha1', 's').update(raw).digest('hex')
  assert.equal(verifyWebhookSignature(raw, signature, 's'), true)
  assert.equal(verifyWebhookSignature(Buffer.from('{"a":2}'), signature, 's'), false)
  assert.equal(verifyWebhookSignature(raw, signature, ''), false)
})
test('HTTP transport has bounded body/timeout/redirect and no automatic retry on ambiguous failure', async () => {
  let calls = 0, request
  const client = createOneBotClient({ config: () => config(), token: async () => 'TOKEN', fetch: async (_, options) => { calls++; request = options; throw new Error('lost response') } })
  await assert.rejects(client.call('send_private_msg', {}), error => error.deliveryState === 'unknown')
  assert.equal(calls, 1); assert.equal(request.redirect, 'error'); assert.equal(request.headers.authorization, 'Bearer TOKEN')
  await assert.rejects(boundedBytes(new Response('0123456789'), 4), { code: 'BODY_TOO_LARGE' })
})
test('media downloads are explicit-origin only and never read arbitrary local paths', async () => {
  const c = config({ mediaOrigins: ['https://cdn.test'] })
  assert.equal(admittedMediaUrl('https://cdn.test/a.gif', c), 'https://cdn.test/a.gif')
  const qqImage = 'https://multimedia.nt.qq.com.cn/download?fileid=fixture'
  assert.equal(admittedMediaUrl(qqImage, config()), qqImage)
  for (const uri of ['file:///C:/secret', 'http://127.0.0.1/secret', 'https://other.test/a', 'https://u:p@cdn.test/a']) assert.throws(() => admittedMediaUrl(uri, c))
  let saved
  const media = createMediaAdapter({ attachments: { saveImage: async x => { saved = x; return { attachmentId: 'i' } } }, fetch: async () => new Response('GIF89a', { headers: { 'content-type': 'image/gif' } }) })
  const admitted = await media.admit({ type: 'image', url: 'https://cdn.test/a.gif' }, { config: c })
  assert.equal(admitted.type, 'image'); assert.equal(saved.mediaType, 'image/gif')
})
test('QQ file lookup preserves private hashes and group bus IDs for native file attachments', async () => {
  const bytes = Buffer.from('file bytes')
  const downloads = []
  const media = createMediaAdapter({
    attachments: { saveFile: async ({ name, data }) => ({ attachmentId: 'stored', name, bytes: data.length }) },
    fetch: async (url, options) => {
      assert.equal(options.redirect, 'error')
      downloads.push(url)
      return new Response(bytes)
    },
  })
  const privatePart = normalizeEvent(msg({ message: [{ type: 'file', data: { file_id: 'p', file_hash: 'hash', name: 'report.txt' } }] })).media[0]
  const groupPart = normalizeEvent({ post_type: 'notice', notice_type: 'group_upload', user_id: 123, group_id: 456, file: { file_id: 'g', busid: 103, name: 'group.txt' } })
  assert.equal(groupPart.externalMessageId, 'upload:g')
  const publicLink = 'http://203.104.1.2:8080/download?key=fixture&isthumb=0'
  const groupLink = 'https://file.qq.com/ftn_handler/ABCD/?fname='
  const onebot = { call: async (action, params) => {
    if (action === 'get_private_file_url') {
      assert.deepEqual(params, { user_id: '123', file_id: 'p', file_hash: 'hash' })
      return { url: publicLink }
    }
    assert.equal(action, 'get_group_file_url')
    assert.deepEqual(params, { group_id: '456', file_id: 'g', busid: 103 })
    return { url: groupLink }
  } }
  assert.deepEqual((await media.admit(privatePart, { config: config(), endpoint: 'private:123', onebot })).attachment, { attachmentId: 'stored', name: 'report.txt', bytes: bytes.length })
  assert.equal((await media.admit(groupPart.media[0], { config: config(), endpoint: 'group:456', onebot })).attachment.name, 'group.txt')
  await assert.rejects(media.admit(privatePart, { config: config(), endpoint: 'private:123', onebot: { call: async () => ({ url: 'http://127.0.0.1:8080/download?isthumb=0' }) } }), /MEDIA_ORIGIN_DENIED/)
  assert.deepEqual(downloads, [publicLink, groupLink])
})
test('file-only admission uses official attachment saveFile result, never external ref/path', async () => {
  let saved
  const adapter = createMediaAdapter({ attachments: { saveFile: async value => { saved = value; return { attachmentId: 'durable-server-generated', name: value.name, bytes: value.data.length } } }, fetch: async () => new Response('real bytes') })
  const c = config({ mediaOrigins: ['https://cdn.test'] })
  const result = await adapter.admit({ type: 'file', url: 'https://cdn.test/file', name: 'file.txt', attachmentId: 'forged' }, { config: c })
  assert.equal(saved.data.toString(), 'real bytes'); assert.equal(result.attachment.attachmentId, 'durable-server-generated'); assert.equal(result.attachment.bytes, 10)
  await assert.rejects(adapter.admit({ type: 'file', file: 'C:/secret', attachmentId: 'forged' }, { config: c }))
})
test('explicit legacy import moves token into credential callback and cannot echo it', async () => {
  const f = await fixture(); let credential
  const result = await f.bridge.importLegacy({ 令牌: 'legacy-secret', 通知口令: 'old-query-secret', 绑定: [{ 类型: '私聊', 号码: '123', 会话: 's' }] }, { importCredentials: async value => { credential = value } })
  assert.equal(credential.ONEBOT_TOKEN, 'legacy-secret'); assert.equal(JSON.stringify(result).includes('legacy-secret'), false); assert.equal(JSON.stringify(f.store.legacy).includes('legacy-secret'), false)
  assert.equal(f.bridge.config.enabled, false); assert.equal(f.bridge.config.bindings[0].sendEnabled, false)
})
test('cold preload is invoked at start, never creates or drives global Agent directly', async () => {
  const f = await fixture(); assert.equal(f.preloads.length, 1); assert.equal(f.bindings[0].transport, TRANSPORT_ID); assert.equal(f.received.length, 0)
  await f.bridge.dispose(); assert.equal(f.transport(), null)
})
test('inbound quote enriches via bounded get_msg, top-level file-only reaches IO, failure keeps text', async () => {
  const f = await fixture({ media: { admit: async () => ({ type: 'file', attachment: { attachmentId: 'f', name: 'only.txt', bytes: 2 } }) } })
  f.bridge.onebot.call = async (action, body, options) => { assert.equal(action, 'get_msg'); assert.equal(options.maxBytes, 65536); return { message_id: 4, message_type: 'private', user_id: 123, sender: { user_id: 123, nickname: 'A' }, message: [{ type: 'text', data: { text: 'quoted' } }] } }
  await f.bridge.receive(msg({ message: [{ type: 'reply', data: { id: 4 } }], file: { id: 'f', name: 'only.txt' } }))
  assert.equal(f.received.length, 1); assert.ok(f.received[0].content.some(b => b.type === 'file')); assert.ok(f.received[0].content.some(b => b.text?.includes('quoted'))); assert.equal(f.received[0].replyTo, '4')
})
test('outbound removes legacy wrappers, preserves text and dedupes uncertain delivery', async () => {
  const f = await fixture(), delivery = f.delivery()
  const first = await f.bridge.deliver(delivery, { idempotencyKey: 'd' }); assert.equal(first.state, 'delivered'); assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0][1].message[1].data.text, '未改动。！？')
  assert.equal(f.calls[1][1].message[0].data.text, '原样')
  await f.bridge.deliver(delivery, { idempotencyKey: 'd' }); assert.equal(f.calls.length, 2)
  f.bridge.onebot.call = async () => { throw new Error('lost') }
  assert.equal((await f.bridge.deliver(f.delivery('uncertain'), { idempotencyKey: 'u' })).state, 'unknown')
  let retry = 0; f.bridge.onebot.call = async () => { retry++; return {} }
  assert.equal((await f.bridge.deliver(f.delivery('uncertain'), { idempotencyKey: 'u' })).state, 'unknown'); assert.equal(retry, 0)
})
test('SA explicit QQ delivery uses the originating session and a cold connection probe', async t => {
  const f = await fixture({
    nativeFeatures: {
      reconcile: async () => {}, prepare: async () => {}, dispose: async () => {},
      allowDelivery: async () => false,
    },
    media: {
      resolveOutbound: async (resource, { sessionId }) => {
        assert.equal(sessionId, 'source-session')
        assert.equal(resource.path, './send.png')
        return { type: 'image', attachment: { name: 'send.png' } }
      },
      export: async () => ({ file: 'base64://AA==' }),
    },
  })
  t.after(() => f.bridge.dispose())
  const channel = f.transport()
  assert.equal(channel.explicitSend, true)
  const call = f.bridge.onebot.call
  f.bridge.onebot.call = async (action, ...args) => action === 'get_login_info' ? { user_id: 9 } : call(action, ...args)
  assert.deepEqual(await channel.probe(f.bindings[0]), { available: true })
  assert.equal(f.calls.length, 0)
  const delivery = f.delivery('explicit', text('主动通知\n![图](./send.png)'))
  delivery.reply.sessionId = 'source-session'
  assert.equal((await channel.deliver(delivery)).reason, 'DELIVERY_IDENTITY_MISMATCH')
  assert.equal((await channel.deliver({ ...delivery, intent: 'explicit' })).state, 'delivered')
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0][1].message.map(segment => segment.type), ['text'])
  assert.deepEqual(f.calls[1][1].message.map(segment => segment.type), ['image'])
})
test('concurrent delivery idempotency singleflights and closing gates cancels remaining mixed actions', async () => {
  const f = await fixture(); const d = f.delivery('same')
  const [a, b] = await Promise.all([f.bridge.deliver(d, { idempotencyKey: 'same' }), f.bridge.deliver(d, { idempotencyKey: 'same' })])
  assert.equal(a.state, 'delivered'); assert.deepEqual(a, b); assert.equal(f.calls.length, 2)
  let callCount = 0
  f.bridge.media.export = async () => ({ file: 'C:/durable/f', name: 'f' })
  f.bridge.onebot.call = async () => { callCount++; f.bridge.config = normalizeConfig({ ...f.bridge.config, sendEnabled: false }); return { message_id: 88 } }
  const result = await f.bridge.deliver(f.delivery('mixed', [...text('text'), { type: 'file', attachment: { attachmentId: 'f', name: 'f', bytes: 1 } }]))
  assert.equal(callCount, 1); assert.equal(result.state, 'unknown')
})
test('replayed webhook skips media/model/quota side effects before IO persisted dedupe', async () => {
  let policies = 0
  const f = await fixture({ quotaPolicy: { reconcile: async () => {}, arm: async () => {}, beforeInput: async () => { policies++ }, snapshot: () => [], dispose: async () => {} } })
  await f.bridge.receive(msg()); await f.bridge.receive(msg())
  assert.equal(policies, 1); assert.equal(f.received.length, 1)
})
test('per-binding sends are double gated and receiver identity cannot be replaced', async () => {
  const f = await fixture({ config: { sendEnabled: false } })
  assert.equal((await f.bridge.deliver(f.delivery())).state, 'failed'); assert.equal(f.calls.length, 0)
  const enabled = await fixture(); assert.equal((await enabled.bridge.deliver({ ...enabled.delivery(), endpoint: 'group:456' })).state, 'failed')
})
test('continuation is explicitly budgeted and passed only to IO, not a second QQ Agent driver', async () => {
  assert.throws(() => config({ bindings: [{ endpoint: 'private:123', sessionId: 's', continuation: { enabled: true } }] }))
  const continuation = { enabled: true, maxAdditionalReplies: 2, maxOutputTokens: 1024, maxDurationMs: 1000 }
  const f = await fixture({ config: { bindings: [{ endpoint: 'private:123', sessionId: 's', enabled: true, continuation }] } })
  assert.deepEqual(f.bindings[0].continuation, continuation)
  await f.bridge.dispose()
})
test('settings contract has eight focused sections and picker cancellation grants nothing', () => {
  assert.equal(SETTINGS_SECTIONS.length, 8); assert.deepEqual(PICKER_OPTIONS.allowedTypes, ['session'])
  const row = { id: 'old', endpoint: 'private:1', sessionId: 'old', enabled: true, sendEnabled: true }
  assert.equal(selectedBinding(row, { status: 'cancelled', reason: 'user' }), row)
  const next = selectedBinding(row, { status: 'selected', items: [{ type: 'session', workspaceId: 'w', sessionId: 's', title: 'New' }] })
  assert.equal(next.enabled, false); assert.equal(next.sendEnabled, false); assert.equal(next.id, undefined); assert.equal(next.sessionId, 's')
})
