import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHmac } from 'node:crypto'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
test('official Loader YAML composes QQ with native IO/Session, owner routes and offline send gate', async () => {
  const ctx = new Context(); let network = 0
  const previousFetch = globalThis.fetch; globalThis.fetch = () => { network++; throw new Error('Real external transport forbidden') }
  try {
    await ctx.plugin(Loader); ctx.loader.builtins.include = Include; ctx.loader.builtins.timer = Timer
    await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } }); await ctx.loader.await()
    const entries = [...ctx.loader.entries()]
    for (const id of ['timer', 'storage', 'sessions', 'agents', 'domains', 'super-agent-io', 'qq-bridge-001']) assert.equal(entries.find(e => e.options.id === id)?.fiber?.state, FiberState.ACTIVE, id)
    const f = ctx.get('qqFixture'), io = ctx.get('superAgentIo')
    async function request(path, body, headers = {}) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]); req.method = body === undefined ? 'GET' : 'POST'; req.headers = headers
      let status, result
      await f.routes.get('/dsh-qq-bridge-001' + path).handler(req, { writeHead(code) { status = code }, end(raw) { result = JSON.parse(raw) } })
      return { status, result }
    }
    assert.equal((await request('/state', undefined, { 'x-fixture-guest': '1' })).status, 403)
    const saved = await request('/save', { enabled: true, bindings: [{ endpoint: 'private:123', sessionId: f.session.id, enabled: true, sendEnabled: false, preload: true }] })
    assert.equal(saved.status, 200); assert.equal(saved.result.preloads[0].ready, true)
    assert.equal(f.input.length, 0)
    const key = io.listBindings()[0].id
    const receipt = await io.receive({ bindingId: key, externalMessageId: '41', content: [{ type: 'text', text: 'Loader input' }] })
    assert.equal(receipt.state, 'accepted'); assert.equal(f.input.length, 1)
    f.session.append('turn/start', { turn: 1 }); f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }); f.session.append('user/message', f.input[0], { surfaceOp: 'append' })
    for (const [index, value] of ['first real message', 'second real message'].entries()) {
      f.session.append('step/start', { turn: 1, step: index + 1 })
      f.session.append('assistant/message', { turn: 1, step: index + 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: value }], source: { provider: 'actual', model: 'model' } }) }, { surfaceOp: 'append' })
      f.session.append('step/end', { turn: 1, step: index + 1 })
    }
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await io.drain()
    assert.equal(f.session.deriveMessages().filter(m => m.role === 'assistant').length, 2)
    assert.equal(Object.values(f.snapshots.get('super_agent_io').tables.deliveries).length, 2)
    assert.equal(network, 0); assert.equal(io.receipt(receipt.traceId).messageCommitted, true)
    const entry = entries.find(e => e.options.id === 'qq-bridge-001'); assert.equal(entry.fiber.effectiveConfig.networkAccess.get(), false); await ctx.registry.delete(entry.fiber.runtime.callback)
    assert.equal(f.routes.size, 0); assert.equal(f.session.deriveMessages().filter(m => m.role === 'assistant').length, 2)
  } finally { globalThis.fetch = previousFetch; await ctx.fiber.dispose() }
})
