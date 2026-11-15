import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { HostPermissions } from '../lib/host-permissions.mjs'
import { registerRoutes } from '../lib/routes.mjs'

function fixture() {
  const session = { current: 'danger-full-access' }, agent = { id: 's', session }
  const bindings = [{ id: 'b', sessionId: 's', endpoint: 'group:1' }]
  const service = { catalog: () => ({ options: ['danger-full-access', 'workspace-write'].map(value => ({ value })) }), current: session => session.current, set: (session, value) => { session.current = value } }
  const control = new HostPermissions({ service: () => service, sandbox: () => ({ resolve: () => ({ mode: 'danger-full-access', workspaceRoot: 'E:/work' }) }), bindings: () => bindings, liveAgent: id => id === 's' ? agent : undefined, resolveAgent: async () => agent })
  return { agent, bindings, service, control }
}
test('host permissions preserve the session preset until the owner selects one', async () => {
  const f = fixture()
  assert.equal(f.control.catalog().bindings[0].current, 'danger-full-access')
  assert.equal(f.agent.session.current, 'danger-full-access')
  await assert.rejects(f.control.set('b', 'unknown'), /HOST_PERMISSION_INVALID_PRESET/)
  assert.equal(f.agent.session.current, 'danger-full-access')
  await f.control.set('b', 'workspace-write')
  assert.equal(f.control.catalog().bindings[0].current, 'workspace-write')
})
test('host permission selection is restricted to the active binding and catalog', async () => {
  const f = fixture()
  f.agent.id = 'another-session'
  await assert.rejects(f.control.set('b', 'workspace-write'), /HOST_PERMISSION_BINDING_CHANGED/)
  assert.equal(f.agent.session.current, 'danger-full-access')
})
test('host permission route rejects a guest and applies an owner selection', async () => {
  const f = fixture(), routes = new Map()
  let role = 'guest'
  const off = registerRoutes({ webServer: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } }, connection: { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: role } } }) }, bridge: {}, credentials: {}, hostPermissions: f.control })
  async function post(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = {}
    let status, value
    const res = { writeHead(code) { status = code }, end(raw) { value = JSON.parse(raw) } }
    await routes.get('/dsh-qq-bridge-001/host-permissions').handler(req, res)
    return { status, value }
  }
  try {
    assert.equal((await post({ bindingId: 'b', preset: 'workspace-write' })).status, 403)
    assert.equal(f.agent.session.current, 'danger-full-access')
    role = 'owner'
    const response = await post({ bindingId: 'b', preset: 'workspace-write' })
    assert.equal(response.status, 200)
    assert.equal(response.value.result.bindings[0].current, 'workspace-write')
  } finally { off() }
})
