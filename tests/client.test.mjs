import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SETTINGS_SECTIONS } from '../lib/ui-contract.mjs'
test('Client factory registers isolated settings and optional picker only; no auto update/network at load', () => {
  let factory, registration, dictionaries, calls = 0, optional
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { assert.equal(value.id, 'dsh-qq-bridge'); factory = value.factory } } }, AbortSignal, fetch: () => { calls++; throw new Error('network forbidden') } })
  const exports = factory(name => { assert.equal(name, 'react'); return { createElement: () => null } })
  const off = [], ctx = { locale: { bind: () => key => key, register: (_, dict) => { dictionaries = dict; return () => {} } }, effect(fn) { off.push(fn()) }, inject(keys, fn) { optional = { keys, fn } }, slots: { inject(name, fn) { assert.equal(name, 'settings.section'); return fn() }, register(options, Component) { registration = { options, Component }; return () => {} } } }
  exports.apply(ctx)
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']); assert.equal(registration.options.id, 'qq-bridge-001'); assert.equal(calls, 0)
  assert.deepEqual(Array.from(optional.keys), ['resourcePicker'])
  for (const name of SETTINGS_SECTIONS) { assert.ok(dictionaries.en[name]); assert.ok(dictionaries.zh[name]) }
  assert.doesNotMatch(source, /fetch\([^\n]*(?:\/update|\/install)/)
  off.reverse().forEach(fn => fn?.())
})
test('Host networkAccess uses native configForms entry and form.set revision queue', async () => {
  let factory, registration
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { factory = value.factory } } }, AbortSignal, console })
  const calls = [], ids = [], listeners = new Set()
  const form = { snapshot: { status: 'ready', value: { networkAccess: false }, revision: 3, writable: true }, getSnapshot() { return this.snapshot }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, async set(field, value) { calls.push([field, value]); this.snapshot = { ...this.snapshot, value: { ...this.snapshot.value, [field]: value }, revision: this.snapshot.revision + 1 }; for (const listener of listeners) listener(); return true } }
  const service = { get(id) { ids.push(id); return form }, describe() { return { ensure: async () => {} } } }
  const ctx = {
    locale: { bind: () => key => key, register: () => () => {} },
    effect(fn) { const off = fn(); return off }, inject() {},
    get(name) { return name === 'configForms' ? service : undefined },
    slots: { inject(_, fn) { return fn() }, register(options) { registration = options; return () => {} } },
  }
  factory(name => { assert.equal(name, 'react'); return { createElement: () => null } }).apply(ctx)
  const hook = registration.inject().hooks.networkAccess
  assert.deepEqual(ids, ['dsh-qq-bridge', 'qq-bridge-001'])
  assert.equal(hook.getSnapshot().status, 'ready')
  assert.equal(hook.getSnapshot().entryId, 'dsh-qq-bridge')
  assert.equal(hook.getSnapshot().value.networkAccess, false)
  assert.equal(await hook.set(true), true)
  assert.deepEqual(calls, [['networkAccess', true]])
  assert.equal(hook.getSnapshot().value.networkAccess, true)
  assert.equal(hook.getSnapshot().revision, 4)
})

