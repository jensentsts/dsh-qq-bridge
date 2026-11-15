import test from 'node:test'
import assert from 'node:assert/strict'
import { cardData, boundedRichPacket, RichReader } from '../lib/rich.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { normalizeEvent } from '../lib/onebot.mjs'
import { InboundAsr } from '../lib/asr.mjs'
import { InboundPolicy, stableProbability } from '../lib/admission.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { featureTurnFold } from '../lib/native-features.mjs'
const event = (extra = {}) => normalizeEvent({ post_type: 'message', message_type: 'group', group_id: 456, message_id: 1, user_id: 123, self_id: 999, message: [{ type: 'text', data: { text: 'message' } }], ...extra })
const settings = extra => normalizeConfig({ enabled: true, rich: { cards: true, forwards: true }, bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true }], ...extra })
const wav = () => { const data = Buffer.alloc(76); data.write('RIFF'); data.writeUInt32LE(68, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(32, 40); return data }
test('cards parse bounded data only and reject executable XML/entities or unsafe links', () => {
  const payload = JSON.stringify({ meta: { title: '<img onerror=evil()>', desc: 'untrusted', jumpUrl: 'https://safe.test/video', url: 'javascript:evil()' } })
  const card = cardData({ type: 'json', payload }); assert.equal(card.titles[0], '<img onerror=evil()>'); assert.deepEqual(card.links, ['https://safe.test/video'])
  assert.equal(cardData({ type: 'xml', payload: '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><title>&x;</title>' }).unavailable, 'XML_DECLARATION_DENIED')
  for (const budget of [256, 500, 6000]) { const packet = boundedRichPacket(Array(20).fill(card), budget); assert.ok(packet.length <= budget); if (budget < 1000) assert.ok(JSON.parse(packet.split('\n')[1]).omitted) }
})
test('forward global node/depth/byte/character budgets, cycles and endpoint-isolated negative cache are bounded', async () => {
  let calls = 0
  const reader = new RichReader({ onebot: { call: async (_, args) => { calls++; return { messages: Array(40).fill({ sender: { nickname: 'sender' }, content: [{ type: 'text', data: { text: '多字'.repeat(300) } }, { type: 'forward', data: { id: args.message_id } }] }) } } } })
  const config = settings({ rich: { cards: true, forwards: true, maxChars: 500, maxNodes: 2, maxCalls: 2 } })
  const first = await reader.read([{ type: 'forward', id: 'a' }], { config, endpoint: 'group:456' }); assert.ok(first.text.length <= 500); assert.equal(calls, 1); assert.ok(first.text.includes('omitted'))
  let failed = 0; const negative = new RichReader({ onebot: { call: async () => { failed++; throw new Error('offline') } } })
  await negative.read([{ type: 'forward', id: 'a' }], { config, endpoint: 'group:456' }); await negative.read([{ type: 'forward', id: 'a' }], { config, endpoint: 'group:456' }); assert.equal(failed, 1)
  await negative.read([{ type: 'forward', id: 'a' }], { config, endpoint: 'group:789' }); assert.equal(failed, 2)
})
test('ASR uses pinned ready host-local native controller, official durable audio and terminal per-message receipts', async () => {
  const store = new MemoryQqStore(); let transcribes = 0, downloads = 0, saves = 0
  const controller = { catalog: () => ({ maxAudioBytes: 1024 * 1024, providers: [{ id: 'local', location: 'host-local', languages: ['auto'], preparation: { phase: 'ready' } }] }), transcribe: async request => { transcribes++; assert.equal(request.providerId, 'local'); return { text: '转录原文', audioSeconds: 1, inferenceSeconds: .01 } } }
  const asr = new InboundAsr({ controller, attachments: { saveFile: async input => { saves++; assert.equal(input.name, 'qq-voice.wav'); return { attachmentId: 'real-file', name: input.name, bytes: input.data.length } } }, onebot: { call: async () => { downloads++; return { base64: wav().toString('base64') } } }, store, allowed: () => true })
  const config = settings({ asr: { enabled: true, providerId: 'local' } }), context = { config, bindingId: 'b', externalMessageId: '1', index: 0 }
  const first = await asr.admit({ type: 'record', file: 'safe.silk' }, context); assert.equal(first[0].attachment.attachmentId, 'real-file'); assert.ok(first[1].text.includes('转录原文'))
  await asr.admit({ type: 'record', file: 'safe.silk' }, context); assert.equal(transcribes, 1); assert.equal(downloads, 1); assert.equal(saves, 1)
  controller.transcribe = async () => { transcribes++; throw new Error('failed') }
  const failed = await asr.admit({ type: 'record', file: 'safe.silk' }, { ...context, externalMessageId: '2' }); assert.equal(failed[0].type, 'file'); assert.ok(failed[1].text.includes('不可用'))
  await asr.admit({ type: 'record', file: 'safe.silk' }, { ...context, externalMessageId: '2' }); assert.equal(transcribes, 2)
})
test('ASR never runs cloud/unready provider, commands or backend local paths; uncertain intent never retranscribes', async () => {
  let calls = 0
  const store = new MemoryQqStore(), controller = { catalog: () => ({ maxAudioBytes: 1024, providers: [{ id: 'cloud', location: 'cloud', preparation: { phase: 'ready' } }] }), transcribe: () => { calls++; throw new Error('must not') } }
  const asr = new InboundAsr({ controller, attachments: {}, store, allowed: () => true, onebot: { call: async () => ({ file: 'C:/secret.wav' }) } })
  const config = settings({ asr: { enabled: true, providerId: 'cloud' } }), context = { config, bindingId: 'b', externalMessageId: 'x', index: 0 }
  assert.ok((await asr.admit({ type: 'record', file: 'a.silk' }, context))[0].text.includes('未就绪')); assert.equal(calls, 0)
  controller.catalog = () => ({ maxAudioBytes: 1024, providers: [{ id: 'cloud', location: 'host-local', preparation: { phase: 'ready' } }] })
  assert.ok((await asr.admit({ type: 'record', file: 'a.silk' }, context))[0].text.includes('失败')); assert.equal(calls, 0)
  const key = JSON.stringify(['b', 'pending', 0]); await store.recordAsrResult(key, { state: 'transcribing', content: [{ type: 'file', attachment: { attachmentId: 'saved', name: 'qq-voice.wav', bytes: 44 } }] })
  const uncertain = await asr.admit({ type: 'record', file: 'a.silk' }, { ...context, externalMessageId: 'pending' }); assert.ok(uncertain[1].text.includes('状态未确认')); assert.equal(calls, 0)
})
test('admission filters before media side effects, stable probability and per-chat mention tail decisions persist', async () => {
  let now = 10000
  const store = new MemoryQqStore(), policy = new InboundPolicy({ store, now: () => now }), config = settings({ bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, admission: { enabled: true, allowedSenders: ['123'], mentionOnly: true, tailMessages: 1, probability: 0, mentionAlways: true } }] }), b = config.bindings[0]
  assert.equal((await policy.decide(event(), b)).reason, 'NOT_MENTIONED')
  const mention = event({ message_id: 2, message: [{ type: 'at', data: { qq: '999' } }] }); assert.equal((await policy.decide(mention, b)).admitted, true)
  assert.equal((await policy.decide(event({ message_id: 3 }), b)).reason, 'PROBABILITY_FILTERED')
  assert.equal(stableProbability('b', 'a'), stableProbability('b', 'a'))
  const quote = { senderId: '999' }; assert.equal((await policy.decide(event({ message_id: 4 }), b, quote)).mentioned, true)
  assert.equal((await policy.decide(event({ user_id: 777, message_id: 5 }), b, quote)).reason, 'SENDER_FILTERED')
})
test('reply cooldown does not delay new incoming messages and applies to sending', async () => {
  let now = 10000
  const store = new MemoryQqStore(), policy = new InboundPolicy({ store, now: () => now }), config = settings({ bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, rate: { enabled: true, cooldownMs: 5000, perMinute: 1 } }] }), b = config.bindings[0]
  assert.equal((await policy.decide(event(), b)).admitted, true)
  await policy.delivered(b.id); now += 1000
  assert.equal((await policy.decide(event({ message_id: 2 }), b)).admitted, true)
  assert.equal(await policy.sendDelay(b), 59000)
  now += 60001; assert.equal(await policy.sendDelay(b), 0)
})
test('enabled rich card and ASR text reach the same IO user receipt; ignored input never calls ASR', async () => {
  const config = settings({ bindings: [{ endpoint: 'group:456', sessionId: 's', enabled: true, admission: { enabled: true, mentionOnly: true } }] }), store = new MemoryQqStore(config); let asrs = 0; const received = []
  const bridge = new QqBridge({ config, store, io: { contractVersion: 1, registerTransport: () => () => {}, putBinding: async b => b, receive: async value => { received.push(value); return { traceId: 't' } } }, onebot: {}, asr: { admit: async () => { asrs++; return [{ type: 'text', text: 'transcript' }] }, dispose: async () => {} } })
  await bridge.start()
  const first = { post_type: 'message', message_type: 'group', group_id: 456, message_id: 1, user_id: 123, self_id: 999, message: [{ type: 'record', data: { file: 'a.silk' } }] }
  assert.equal((await bridge.receive(first)).filtered, true); assert.equal(asrs, 0)
  bridge.config = normalizeConfig({ ...config, asr: { enabled: true, providerId: 'local' } })
  await bridge.receive({ ...first, message_id: 2, message: [{ type: 'at', data: { qq: '999' } }, { type: 'record', data: { file: 'a.silk' } }, { type: 'json', data: { data: '{"title":"title"}' } }] })
  assert.equal(asrs, 1); assert.ok(received[0].content.some(block => block.text?.includes('transcript'))); assert.ok(received[0].content.some(block => block.text?.includes('title'))); await bridge.dispose()
})
test('native feature fold treats local/mixed inputs as nonexclusive and bounds input identities', () => {
  const start = { type: 'turn/start', data: { turn: 1 } }; let state = featureTurnFold.apply(featureTurnFold.init(), start)
  state = featureTurnFold.apply(state, { type: 'user/message', data: { source: { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId: 'b', externalMessageId: '1' } } }); assert.equal(state.exclusive, true)
  state = featureTurnFold.apply(state, { type: 'user/message', data: { source: { kind: 'user' } } }); assert.equal(state.exclusive, false)
})
