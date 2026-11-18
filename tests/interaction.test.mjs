import test from 'node:test'
import assert from 'node:assert/strict'
import { QqInteraction } from '../lib/interaction.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { OneBotError } from '../lib/onebot-http.mjs'

function setup(endpoint = 'private:123') {
  const calls = [], store = new MemoryQqStore(), controller = new AbortController()
  const target = { id: endpoint, endpoint, sessionId: 'session' }
  const bridge = {
    config: { baseUrl: 'http://127.0.0.1:3000' }, controller, store,
    outbox: { context: () => ({ target, anchor: { callId: 'call', reply: { sessionId: 'session', seq: 4 } }, guard() {} }) },
    onebot: { async call(action, params, options) { options.beforeSend(); calls.push({ action, params }); return {} } },
    async _deliveryFlight(_key, action) { return action() },
  }
  return { interaction: new QqInteraction(bridge), bridge, calls, exec: { signal: controller.signal } }
}

test('private shake and poke use their distinct OneBot actions', async () => {
  const shake = setup()
  assert.equal((await shake.interaction.execute({ action: 'shake' }, shake.exec)).ok, true)
  assert.deepEqual(shake.calls, [{ action: 'send_private_msg', params: { user_id: '123', message: [{ type: 'shake', data: {} }] } }])
  const poke = setup()
  assert.equal((await poke.interaction.execute({ action: 'poke' }, poke.exec)).ok, true)
  assert.deepEqual(poke.calls, [{ action: 'friend_poke', params: { user_id: '123' } }])
})

test('group poke addresses the specified member and is deduplicated', async () => {
  const f = setup('group:456')
  const args = { action: 'poke', userId: '789' }
  assert.equal((await f.interaction.execute(args, f.exec)).ok, true)
  assert.equal((await f.interaction.execute(args, f.exec)).ok, true)
  assert.deepEqual(f.calls, [{ action: 'group_poke', params: { group_id: '456', user_id: '789' } }])
  assert.equal((await f.interaction.execute({ ...args, userId: '234' }, f.exec)).code, 'QQ_INTERACTION_CONFLICT')
})

test('invalid group shake or missing member stays local', async () => {
  const f = setup('group:456')
  assert.equal((await f.interaction.execute({ action: 'shake' }, f.exec)).code, 'QQ_SHAKE_PRIVATE_ONLY')
  assert.equal((await f.interaction.execute({ action: 'poke' }, f.exec)).code, 'QQ_INTERACTION_USER_REQUIRED')
  assert.equal(f.calls.length, 0)
})

test('uncertain OneBot action is not resent on retry', async () => {
  const f = setup()
  f.bridge.onebot.call = async (...args) => { f.calls.push(args); throw new OneBotError('ONEBOT_RESPONSE_UNKNOWN') }
  assert.equal((await f.interaction.execute({ action: 'poke' }, f.exec)).state, 'unknown')
  assert.equal((await f.interaction.execute({ action: 'poke' }, f.exec)).state, 'unknown')
  assert.equal(f.calls.length, 1)
})
