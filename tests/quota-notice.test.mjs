import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { QuotaPolicy } from '../lib/quota-policy.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'

async function setup(endpoint) {
  const config = normalizeConfig({ enabled: true, sendEnabled: true, bindings: [{ endpoint, sessionId: 's', enabled: true, sendEnabled: true }] })
  const binding = config.bindings[0], store = new MemoryQqStore(config), calls = [], events = []
  const model = { provider: 'deepseek', model: 'deepseek-flash' }
  const agent = { id: 's', status: 'idle', model: { current: () => model }, session: { snapshotEvents: (from = 0, to = events.length) => events.slice(from, to) } }
  let bridge, observe
  const policy = new QuotaPolicy({
    resolveAgent: async () => ({ agent }), liveAgent: () => agent, store,
    catalog: async () => ({ groups: [] }), binding: id => bridge?.config.bindings.find(row => row.id === id),
    watch: (_agent, callback) => { observe = callback; return () => {} },
    notice: value => bridge.sendQuotaNotice(value),
  })
  const append = (type, data) => { const row = { seq: events.length, type, data }; events.push(row); return row }
  const io = {
    contractVersion: 1, registerTransport: () => () => {}, putBinding: async row => row, preload: async () => ({}),
    receive: async input => {
      append('turn/start', { turn: 1 })
      append('user/message', { source: { kind: 'super-agent-io', transport: 'qq-bridge-001', bindingId: input.bindingId, externalMessageId: input.externalMessageId } })
      append('request/header', { header: { config: model } })
      return { state: 'accepted', traceId: 'trace' }
    },
  }
  const onebot = { call: async (action, params) => { calls.push({ action, params }); return { message_id: 99 } } }
  bridge = new QqBridge({ io, onebot, store, quotaPolicy: policy, config })
  await bridge.start()
  return { bridge, calls, observe, append, binding }
}

test('a real native quota failure returns the configured private balance message once', async () => {
  const f = await setup('private:123')
  await f.bridge.receive({ post_type: 'message', message_type: 'private', user_id: 123, self_id: 999, message_id: 41, message: [{ type: 'text', data: { text: '你好' } }] })
  const end = f.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA' } } })
  await f.observe(end)
  await f.observe(end)
  const sent = f.calls.filter(row => row.action === 'send_private_msg')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].params.message, [{ type: 'text', data: { text: '(T_T)白饭吃干净了……' } }])
  await f.bridge.dispose()
})

test('group quota notice follows an @ of the bot', async () => {
  for (const addressed of [false, true]) {
    const f = await setup('group:456')
    await f.bridge.receive({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 123, self_id: 999, message_id: 42,
      message: [...(addressed ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: '你好' } }] })
    await f.observe(f.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA' } } }))
    assert.equal(f.calls.filter(row => row.action === 'send_group_msg').length, addressed ? 1 : 0)
    await f.bridge.dispose()
  }
})

test('an unavailable mention sidecar does not block receiving a group message', async () => {
  const f = await setup('group:456')
  f.bridge.store.recordGateResult = async () => { throw new Error('storage unavailable') }
  const receipt = await f.bridge.receive({ post_type: 'message', message_type: 'group', group_id: 456, user_id: 123, self_id: 999, message_id: 43,
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '你好' } }] })
  assert.equal(receipt.state, 'accepted')
  await f.bridge.dispose()
})
