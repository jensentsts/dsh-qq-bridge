import test from 'node:test'
import assert from 'node:assert/strict'
import { IoCore } from '../../dsh-super-agent-io/core.mjs'
import { MemoryStore } from '../../dsh-super-agent-io/store.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { createMediaAdapter } from '../lib/media.mjs'
import { win32 } from 'node:path'
const text = value => [{ type: 'text', text: value }]
test('QQ turn with first-request context delivers each public reply and its resources through SA', async () => {
  const logs = [], sends = [], outbound = [], resolutions = []; let core
  const append = (type, data, surfaceOp) => {
    const event = { seq: logs.length, time: logs.length + 1, type, data, ...(surfaceOp ? { surfaceOp } : {}) }; logs.push(event); agent.session.seq = logs.length
    void core.observe('s', event)
    return event
  }
  const agent = { id: 's', session: { id: 's', seq: 0, snapshotEvents: () => logs }, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, followup: message => admit('queue', message), steer: message => admit('steer', message), cancel() { this.cancelled = true } }
  function admit(mode, message) { sends.push({ mode, message }); const target = mode === 'steer' ? 'next-step' : 'next-turn', queue = mode === 'steer' ? agent.inbox.nextStep : agent.inbox.nextTurn; append('agent/inbox/spliced', { target, start: queue.length, inserted: [message] }); queue.push(message) }
  const host = { resolveAgent: async id => { resolutions.push(id); return agent }, liveAgent: () => agent, flush: async () => {}, eventsThrough: async (_, first, last) => logs.slice(first, last + 1), preview: async () => ({ events: [] }) }
  core = new IoCore({ store: new MemoryStore(), host, config: { enabled: true, sendEnabled: true, maxConsecutiveSteers: 1 } }); await core.start()
  const settings = normalizeConfig({ enabled: true, sendEnabled: true, bindings: [{ endpoint: 'private:123', sessionId: 's', enabled: true, sendEnabled: true }] })
  const diskReads = []
  const media = createMediaAdapter({
    workspace: async sessionId => {
      assert.equal(sessionId, 's')
      return {
        cwd: 'C:/QQ',
        fs: {
          resolve: async (name, { cwd } = {}) => win32.resolve(cwd ?? 'C:/QQ', name),
          contains: (root, target) => target.startsWith(root + '\\'),
          stat: async () => ({ type: 'file' }),
          readBytes: async path => { diskReads.push(win32.basename(path)); return Uint8Array.of(1, 2) },
        },
      }
    },
    attachments: {
      saveImage: async ({ data, name, mediaType }) => ({ attachmentId: name, name, bytes: data.length, mediaType }),
      readImage: async () => ({ data: Uint8Array.of(1, 2) }),
      saveFile: async ({ data, name }) => ({ attachmentId: name, name, bytes: data.length }),
      fileHostPath: ref => 'C:/durable/' + ref.name,
      async *readFileStream() { yield Uint8Array.of(1, 2) },
    },
  })
  const bridge = new QqBridge({ io: core, store: new MemoryQqStore(settings), config: settings, typingWait: async () => {}, confirmTypingClock: false, onebot: { call: async (action, params) => { if (action === 'set_input_status') return {}; outbound.push({ action, params }); return { message_id: 100 + outbound.length } } }, media })
  await bridge.start(); assert.equal(resolutions.length, 1); assert.equal(sends.length, 0)
  const incoming = (message_id, value) => ({ post_type: 'message', message_type: 'private', user_id: 123, sender: { nickname: '测试发送者' }, message_id, message: [{ type: 'text', data: { text: value } }] })
  const first = await bridge.receive(incoming(41, 'one')); assert.equal(first.state, 'accepted'); assert.equal(sends[0].mode, 'queue'); assert.equal(sends[0].message.source.kind, 'super-agent-io')
  await bridge.receive(incoming(41, 'one')); assert.equal(sends.length, 1)
  agent.status = 'running'; append('turn/start', { turn: 1 })
  const claimed = agent.inbox.nextTurn.splice(0); append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: claimed.length, inserted: [] }); for (const message of claimed) append('user/message', message, 'append')
  for (const source of [
    { kind: 'agent-instructions', form: 'instructions', changes: [] },
    { kind: 'runtime-context', form: 'snapshot', sections: [] },
    { kind: 'skill-catalog', form: 'catalog' },
    { kind: 'time-context', form: 'snapshot', sections: [] },
  ]) {
    append('user/message', { id: source.kind, role: 'user', source, content: text('request context') }, 'append')
  }
  const reply = (id, step, content) => append('assistant/message', { turn: 1, step, stream: [], message: { id, role: 'assistant', source: { kind: 'model', provider: 'actual', model: 'actual-model' }, content } }, 'append')
  reply('a1', 1, [...text('原样一。！？\n\n第二段'), { type: 'tool-call', name: 'read', id: 'call' }])
  append('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: text('private tool result') } }, 'append')
  reply('a2', 2, [...text('[QQ]原样二[/QQ]'), { type: 'reasoning', text: 'private thought' }])
  reply('a3', 3, [
    ...text('好了\n![图](<C:/QQ/图 (1).png>)\n[语音](./voice.mp3)\n[文件](./report.pdf)'),
    { type: 'file', attachment: { attachmentId: 'f', name: 'report.txt', bytes: 2 } },
  ])
  await core.drain()
  assert.equal(outbound.length, 0)
  append('assistant/message', { turn: 1, step: 4, message: { id: 'commit', role: 'assistant', source: { kind: 'model', provider: 'actual', model: 'actual-model' }, content: [{ type: 'tool-call', id: 'commit-call', name: 'qq_buffer', arguments: '{}' }] } }, 'append')
  const buffer = bridge.outbox.definition({ binding: settings.bindings[0], agent, current: () => true })
  const committed = await buffer.execute({ action: 'send', all: true }, { agent, callId: 'commit-call', signal: new AbortController().signal })
  assert.equal(committed.ok, true)
  assert.deepEqual(outbound.map(o => o.action), ['send_private_msg', 'send_private_msg', 'send_private_msg', 'send_private_msg', 'send_private_msg', 'send_private_msg', 'upload_private_file', 'upload_private_file'])
  assert.equal(outbound[0].params.message[0].type, 'text')
  assert.equal(outbound[0].params.message[0].data.text, '原样一。！？'); assert.equal(outbound[1].params.message[0].data.text, '第二段')
  assert.equal(outbound[2].params.message[0].data.text, '原样二')
  assert.equal(outbound[3].params.message[0].data.text, '好了')
  assert.deepEqual(outbound[4].params.message.find(part => part.type === 'image'), { type: 'image', data: { file: 'base64://AQI=' } })
  assert.equal(outbound[5].params.message[0].type, 'record')
  assert.match(outbound[5].params.message[0].data.file, /^file:.*voice\.mp3$/)
  assert.deepEqual(outbound.slice(6).map(item => item.params.name), ['report.pdf', 'report.txt'])
  assert.deepEqual(diskReads, ['图 (1).png', 'voice.mp3', 'report.pdf'])
  assert.equal(core.store.entries('deliveries').filter(([, delivery]) => delivery.state === 'delivered').length, 3)
  const second = await bridge.receive(incoming(42, 'busy')); assert.equal(second.mode, 'steer')
  const third = await bridge.receive(incoming(43, 'flood')); assert.equal(third.mode, 'queue')
  assert.equal(sends[1].message.source.endpoint, 'private:123')
  const history = await core.history({ bindingId: settings.bindings[0].id }, { sessionId: 's' }); assert.ok(history.items.length)
  await assert.rejects(core.history({ bindingId: settings.bindings[0].id }, { sessionId: 'wrong' }), { code: 'HISTORY_FORBIDDEN' })
  await core.cancel(settings.bindings[0].id); assert.equal(agent.cancelled, true)
  await bridge.dispose(); await core.close()
})
