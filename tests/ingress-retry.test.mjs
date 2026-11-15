import test from 'node:test'
import assert from 'node:assert/strict'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'

test('QQ input is retained and retried when the message channel reports a pre-admission failure', async () => {
  const config = normalizeConfig({ enabled: true, bindings: [{ endpoint: 'group:123', sessionId: 's', enabled: true }] })
  const store = new MemoryQqStore(config), requests = []
  let first = true
  const bridge = new QqBridge({ config, store, onebot: {}, io: { contractVersion: 1, registerTransport: () => () => {}, putBinding: async value => value,
    async receive(value) { requests.push(value); if (first) { first = false; return { traceId: 't', state: 'failed', reason: 'ADMISSION_TIMEOUT' } } return { traceId: 't', state: 'accepted' } } } })
  await bridge.start()
  try {
    const pending = bridge.receive({ post_type: 'message', message_type: 'group', group_id: 123, message_id: 4, user_id: 9, message: [{ type: 'text', data: { text: '继续上一句话' } }] })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await store.ingressReceipt(config.bindings[0].id, '4'), undefined)
    assert.equal((await pending).state, 'accepted')
    assert.equal(requests.length, 2); assert.equal(requests[1].retryFailed, true)
    assert.equal((await store.ingressReceipt(config.bindings[0].id, '4')).traceId, 't')
  } finally { await bridge.dispose() }
})
