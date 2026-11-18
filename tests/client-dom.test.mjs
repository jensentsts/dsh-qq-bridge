import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { normalizeConfig } from '../lib/config.mjs'
const upstream = process.env.DSH_SOURCE_ROOT
const catalog = { groups: [{ id: 'p', name: 'Provider', models: [
  { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
  { id: 'm2', name: 'Model Two' },
] }] }
const testCode = 'DSH-RECV-0123456789abcdef0123456789abcdef'
let React, ReactDom, JSDOM
if (upstream) {
  React = (await import(pathToFileURL(resolve(upstream, 'node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')))).default
  ;({ JSDOM } = await import(pathToFileURL(resolve(upstream, 'node_modules/.pnpm/jsdom@29.1.1_@noble+hashes@2.4.0/node_modules/jsdom/lib/api.js'))))
}
async function setup({ withPicker = false, fail = false, networkEnabled = false, initialConfig } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  ReactDom ??= await import(pathToFileURL(resolve(upstream, 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')))
  let entry, dictionaries, optional
  let settings = normalizeConfig(initialConfig ?? { bindings: [{ endpoint: 'private:123', sessionId: 's', enabled: false }] })
  let hostPreset = 'danger-full-access'
  const calls = [], pickCalls = [], disposers = [], pending = new Map()
  const ctx = { locale: { bind: () => key => dictionaries.en[key] || key, register: (_, value) => { dictionaries = value; return () => {} } }, effect(fn) { const off = fn(); disposers.push(off); return off }, inject(deps, callback) { optional = callback }, slots: { inject: (_, fn) => fn(), register: (options, Component) => { entry = { options, Component }; return () => { entry = undefined } } } }
  let pickResult = { status: 'cancelled', reason: 'user' }
  const picker = { version: 1, capabilities: () => ({ overlay: true }), open: async (options, context) => { pickCalls.push({ options, context }); return pickResult } }
  const fetchFn = async (url, options) => {
    calls.push({ url, options })
    if (fail) return { ok: false, json: async () => ({ ok: false }) }
    if (url.endsWith('/save')) settings = normalizeConfig(JSON.parse(options.body))
    if (url.endsWith('/onebot/account')) return { ok: true, json: async () => ({ ok: true, status: 'connected', qq: '123456', nickname: 'Example' }) }
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ ok: true, catalog }) }
    if (url.endsWith('/host-permissions')) {
      if (options.method === 'POST') hostPreset = JSON.parse(options.body).preset
      return { ok: true, json: async () => ({ ok: true, result: { available: true, options: ['danger-full-access', 'workspace-write'].map(value => ({ value })), bindings: [{ bindingId: settings.bindings[0].id, sessionId: 's', available: true, current: hostPreset }] } }) }
    }
    if (url.endsWith('/tests/send')) return { ok: true, json: async () => ({ ok: true, result: { state: 'delivered', externalMessageId: '81' } }) }
    if (url.endsWith('/tests/receive/start')) return { ok: true, json: async () => ({ ok: true, result: { state: 'waiting', code: testCode } }) }
    if (url.endsWith('/tests/receive/status')) return { ok: true, json: async () => ({ ok: true, result: { state: 'received', via: 'webhook' } }) }
    return { ok: true, json: async () => ({ ok: true, version: '0.0.1', config: settings, credentials: { onebot: false, webhook: false }, preloads: [], capabilities: {}, networkEnabled }) }
  }
  vm.runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: value => value.factory(name => { assert.equal(name, 'react'); return React }).apply(ctx) } }, fetch: fetchFn, AbortSignal, AbortController, crypto, setTimeout, clearTimeout, console })
  if (withPicker) optional({ resourcePicker: picker, effect: fn => { const off = fn(); disposers.push(off); return off } })
  const root = ReactDom.createRoot(dom.window.document.getElementById('root'))
  function Bound() {
    const source = entry.options.inject().hooks.pickerAvailable
    const available = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    return React.createElement(entry.Component, { usePickerAvailable: selector => selector(available) })
  }
  await React.act(async () => { root.render(React.createElement(Bound)); await new Promise(setImmediate) })
  const button = label => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === label)
  const click = async label => { const el = button(label); assert.ok(el, `button ${label}`); await React.act(async () => { el.click(); await new Promise(setImmediate) }) }
  const findField = label => {
    const field = [...dom.window.document.querySelectorAll('label.qqb001-field')].find(node => node.firstElementChild.textContent === label)
    assert.ok(field, `field ${label}`)
    return field
  }
  const select = async (label, value) => {
    const control = findField(label).querySelector('select')
    assert.ok(control, `select ${label}`)
    await React.act(async () => { control.value = value; control.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await new Promise(setImmediate) })
  }
  const type = async (label, value) => {
    const control = findField(label).querySelector('input, textarea')
    assert.ok(control, `text ${label}`)
    const proto = control.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    const setValue = Object.getOwnPropertyDescriptor(proto, 'value').set
    await React.act(async () => { setValue.call(control, value); control.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await new Promise(setImmediate) })
  }
  const toggle = async label => {
    const row = [...dom.window.document.querySelectorAll('label.qqb001-row')].find(node => node.textContent.trim() === label)
    assert.ok(row, `toggle ${label}`)
    const control = row.querySelector('input[type=checkbox]')
    assert.ok(control, `checkbox ${label}`)
    await React.act(async () => { control.click(); await new Promise(setImmediate) })
  }
  const openDetails = summary => {
    const details = [...dom.window.document.querySelectorAll('details')].find(node => node.querySelector('summary')?.textContent === summary)
    assert.ok(details, `details ${summary}`)
    details.open = true
    return details
  }
  return { dom, calls, pickCalls, click, button, select, type, toggle, openDetails, field: findField, pick: value => { pickResult = value }, state: () => settings, async close() { await React.act(async () => root.unmount()); disposers.reverse().forEach(fn => fn?.()); dom.window.close(); globalThis.window = previous.window; globalThis.document = previous.document; Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true }); globalThis.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT } }
}
test('QQ settings exposes host permissions per conversation without changing them on load', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    await ui.click('Security')
    const panel = ui.dom.window.document.querySelector('[role=tabpanel]')
    assert.match(panel.textContent, /Current preset: Full access/)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/host-permissions') && call.options.method === 'POST').length, 0)
    await ui.select('Permission preset', 'workspace-write')
    await ui.click('Apply to conversation')
    assert.match(panel.textContent, /Current preset: Workspace write/)
    const post = ui.calls.find(call => call.url.endsWith('/host-permissions') && call.options.method === 'POST')
    assert.deepEqual(JSON.parse(post.options.body), { bindingId: ui.state().bindings[0].id, preset: 'workspace-write' })
  } finally { await ui.close() }
})
test('QQ typing controls save and reload the selected speed and maximum wait', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    await ui.click('Message behavior')
    await ui.select('Default typing speed', '1.5')
    await ui.type('Maximum wait per message (seconds)', '6.5')
    await ui.click('Save settings')
    assert.equal(ui.state().typing.rate, 1.5)
    assert.equal(ui.state().typing.maxWaitMs, 6500)
    await ui.toggle('Simulate typing before sending text')
    await ui.click('Save settings')
    assert.equal(ui.state().typing.enabled, false)
    await ui.click('Reload')
    assert.equal(ui.state().typing.enabled, false)
    assert.equal(ui.state().typing.rate, 1.5)
  } finally { await ui.close() }
})
test('QQ message behavior combines input and output and saves ordered fallback choices without JSON entry', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    const { document } = ui.dom.window
    await ui.click('Message behavior')
    const panel = document.querySelector('[role=tabpanel]')
    assert.match(panel.textContent, /Receiving messages/)
    assert.match(panel.textContent, /Sending replies/)
    assert.equal(panel.querySelector('details[open]'), null)
    assert.equal(ui.button('Input'), undefined)
    await ui.select('Admission mode', 'queue')
    await ui.click('Model & quota')
    await ui.select('Quota exhaustion strategy', 'next-input')
    assert.equal(document.querySelectorAll('[role=tabpanel] textarea').length, 1)
    await ui.select('Choose model', '["p","m1"]')
    await ui.select('Reasoning effort', 'high')
    await ui.click('Add candidate')
    await ui.select('Choose model', '["p","m2"]')
    await ui.click('Add candidate')
    await ui.click('Move down')
    await ui.click('Save settings')
    assert.equal(ui.state().inputMode, 'queue')
    assert.deepEqual(ui.state().bindings[0].quotaPolicy.candidates, [
      { provider: 'p', model: 'm2' }, { provider: 'p', model: 'm1', reasoningEffort: 'high' },
    ])
  } finally { await ui.close() }
})
test('balance reply and DeepSeek peak response settings can be edited and saved', { skip: !upstream }, async () => {
  const ui = await setup({ initialConfig: { bindings: [{ endpoint: 'group:123', sessionId: 's', enabled: false }] } })
  try {
    await ui.click('Model & quota')
    assert.equal(ui.field('Message when model balance is exhausted').querySelector('textarea').value, '(T_T)白饭吃干净了……')
    await ui.type('Message when model balance is exhausted', '等我充好饭卡再来。')
    await ui.click('Save settings')
    assert.equal(ui.state().quotaReply, '等我充好饭卡再来。')
    await ui.click('Message behavior')
    ui.openDetails('Rules for a QQ chat')
    await ui.toggle('Follow DeepSeek peak hours')
    await ui.type('Peak-hour response chance (%)', '35')
    await ui.type('Minimum peak response interval (seconds)', '25')
    await ui.type('Minimum off-peak response interval (seconds)', '3')
    await ui.click('Save settings')
    assert.equal(ui.state().bindings[0].priceSchedule.peakProbability, 35)
    assert.equal(ui.state().bindings[0].priceSchedule.peakCooldownMs, 25000)
    assert.equal(ui.state().bindings[0].priceSchedule.offPeakCooldownMs, 3000)
  } finally { await ui.close() }
})
test('QQ test panel selects a saved chat and starts send and receive only from their buttons', { skip: !upstream }, async () => {
  const ui = await setup({ networkEnabled: true })
  try {
    await ui.click('Send / receive test')
    assert.equal(ui.button('Send test message').disabled, true)
    assert.equal(ui.calls.some(call => call.url.includes('/tests/')), false)
    const id = ui.state().bindings[0].id
    await ui.select('QQ chat', id)
    await ui.click('Start receive test')
    assert.ok([...ui.dom.window.document.querySelectorAll('input')].some(input => input.readOnly && input.value === testCode))
    await ui.click('Send test message')
    const send = ui.calls.find(call => call.url.endsWith('/tests/send'))
    const { bindingId, endpoint, text, requestId } = JSON.parse(send.options.body)
    assert.equal(bindingId, id)
    assert.equal(endpoint, 'private:123')
    assert.equal(text, 'DSH connection test')
    assert.match(requestId, /^[0-9a-f-]{36}$/i)
    assert.match(ui.dom.window.document.querySelector('[role=tabpanel]').textContent, /OneBot confirmed the send/)
  } finally { await ui.close() }
})
test('QQ save-and-check saves an edited address in one step, shows the actual account and clears stale status', { skip: !upstream }, async () => {
  const ui = await setup({ networkEnabled: true })
  try {
    const { document, Event, HTMLInputElement } = ui.dom.window
    assert.equal(ui.calls.filter(call => call.url.endsWith('/onebot/account')).length, 0)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/save')).length, 0)
    assert.equal(ui.button('Check connection'), undefined)
    assert.equal(ui.button('Save and check connection').disabled, false)
    await ui.click('Save and check connection')
    assert.match(document.body.textContent, /Connected to QQ 123456/)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/save')).length, 0)
    const address = [...document.querySelectorAll('input')].find(input => input.value === 'http://127.0.0.1:3000')
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    await React.act(async () => {
      setValue.call(address, 'http://127.0.0.1:3001')
      address.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(setImmediate)
    })
    assert.equal(document.body.textContent.includes('Connected to QQ 123456'), false)
    assert.equal(ui.button('Save and check connection').disabled, false)
    const before = ui.calls.length
    await ui.click('Save and check connection')
    const save = ui.calls.slice(before).find(call => call.url.endsWith('/save'))
    assert.ok(save, 'the edited connection must be saved before checking')
    assert.equal(JSON.parse(save.options.body).baseUrl, 'http://127.0.0.1:3001')
    assert.equal(ui.state().baseUrl, 'http://127.0.0.1:3001')
    assert.equal(ui.calls.slice(ui.calls.indexOf(save) + 1).some(call => call.url.endsWith('/onebot/account')), true)
    assert.equal(ui.calls.filter(call => call.url.endsWith('/onebot/account')).length, 2)
    assert.match(document.body.textContent, /Connected to QQ 123456/)
  } finally { await ui.close() }
})
async function chooseSnowLumaFile(ui, text) {
  const { document, Event, File } = ui.dom.window
  const input = document.querySelector('input[type=file]')
  const file = new File([text], 'onebot_123456.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { configurable: true, value: [file] })
  await React.act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(setImmediate) })
}
test('SnowLuma saves the previewed address and write-only credential together with the connection check', { skip: !upstream }, async () => {
  const ui = await setup({ networkEnabled: true })
  try {
    const { document } = ui.dom.window
    const prior = structuredClone(ui.state())
    const token = 'fixture-snowluma-token'
    const origin = 'http://[::1]:3202'
    document.querySelector('input[type=file]').closest('details').open = true
    await chooseSnowLumaFile(ui, '\ufeff' + JSON.stringify({ networks: { httpServers: [
      { host: '0.0.0.0', port: 3201, accessToken: 'fixture-other-token' },
      { host: '::1', port: 3202, path: '/', accessToken: token },
      { host: '192.0.2.2', port: 3203 },
      { host: 'localhost', port: 3204, path: '/other' },
      { host: 'localhost', port: 3205, enabled: false },
    ] } }))
    const options = document.querySelector('input[type=file]').closest('details').querySelectorAll('option')
    assert.deepEqual([...options].map(option => option.value), ['http://127.0.0.1:3201', origin])
    assert.match(document.body.textContent, /QQ number from the filename · 123456/)
    assert.match(document.body.textContent, /Access token included/)
    assert.equal(document.body.innerHTML.includes(token), false)
    assert.equal(ui.calls.length, 1)
    await ui.select('Local HTTP server', origin)
    await ui.click('Use this connection')
    assert.equal(ui.button('Save imported token'), undefined)
    assert.equal(ui.button('Save and check connection').disabled, false)
    assert.equal(document.querySelector('input[type=password]').value, '')
    assert.equal(ui.calls.length, 1)
    const before = ui.calls.length
    await ui.click('Save and check connection')
    const save = ui.calls.slice(before).find(call => call.url.endsWith('/save'))
    const credentials = ui.calls.slice(before).find(call => call.url.endsWith('/credentials'))
    const account = ui.calls.slice(before).find(call => call.url.endsWith('/onebot/account'))
    assert.ok(save, 'the staged SnowLuma address must be saved')
    assert.ok(credentials, 'the staged write-only token must be stored')
    assert.ok(account, 'the same action must check the actual account')
    assert.equal(ui.calls.indexOf(save) < ui.calls.indexOf(credentials), true)
    assert.equal(ui.calls.indexOf(credentials) < ui.calls.indexOf(account), true)
    assert.deepEqual(ui.state(), { ...prior, baseUrl: origin })
    assert.equal(JSON.parse(save.options.body).snowLumaOrigin, origin)
    assert.equal(save.options.body.includes(token), false)
    assert.deepEqual(JSON.parse(credentials.options.body), { onebotToken: token, onebotOrigin: origin })
    assert.equal(document.body.innerHTML.includes(token), false)
    assert.match(document.body.textContent, /Connected to QQ 123456/)
  } finally { await ui.close() }
})
test('SnowLuma gives feedback for malformed JSON and configurations without a local HTTP server', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    const { document } = ui.dom.window
    document.querySelector('input[type=file]').closest('details').open = true
    await chooseSnowLumaFile(ui, '{ invalid')
    assert.match(document.querySelector('[role=alert]').textContent, /valid SnowLuma OneBot JSON file/)
    await chooseSnowLumaFile(ui, JSON.stringify({ networks: { httpServers: [{ host: '192.0.2.10', port: 3000 }] } }))
    assert.match(document.querySelector('[role=alert]').textContent, /No usable local HTTP server/)
    assert.equal(ui.button('Use this connection'), undefined)
    assert.equal(ui.calls.length, 1)
  } finally { await ui.close() }
})
test('compiled QQ settings explains bot login and offers a manual binding when the picker is unavailable', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    assert.equal(ui.dom.window.document.querySelectorAll('[role=tab]').length, 8)
    assert.match(ui.dom.window.document.body.textContent, /Sign in to the bot in your OneBot client/)
    await ui.click('Open QQ bindings')
    const { document } = ui.dom.window
    assert.match(document.body.textContent, /Resource picker v1 is unavailable/)
    assert.equal(ui.button('Choose DSH conversation'), undefined)
    assert.equal([...document.querySelectorAll('label.qqb001-field')].filter(node => node.firstElementChild.textContent === 'Choose a QQ chat').length, 1)
    assert.equal(document.querySelector('input[inputmode=numeric]').value, '123')
    assert.ok([...document.querySelectorAll('input')].some(input => input.value === 's'))
    await ui.click('Add binding')
    assert.match(document.body.textContent, /Enter a valid QQ number or group number/)
    assert.equal(ui.button('Save settings').disabled, true)
    assert.equal(ui.calls.filter(c => c.url.endsWith('/save')).length, 0)
  } finally { await ui.close() }
})
test('compiled QQ settings binds a numbered QQ group through the single chat selector and keeps model choice optional', { skip: !upstream }, async () => {
  const ui = await setup({ withPicker: true })
  try {
    await ui.click('Bindings'); await ui.click('Choose DSH conversation')
    assert.match(ui.dom.window.document.body.textContent, /Picker cancelled/); assert.equal(ui.pickCalls.length, 1)
    assert.equal(ui.pickCalls[0].options.allowCreateSession, true); assert.deepEqual(Array.from(ui.pickCalls[0].options.allowedTypes), ['session'])
    assert.equal(ui.pickCalls[0].options.selectModel, false)
    const { document } = ui.dom.window
    assert.equal([...document.querySelectorAll('label.qqb001-field')].filter(node => node.firstElementChild.textContent === 'Choose a QQ chat').length, 1)
    await ui.select('QQ chat type', 'group')
    const number = document.querySelector('input[inputmode=numeric]')
    assert.match(number.closest('label').textContent, /QQ group number/)
    await ui.type('QQ group number', '4 56')
    const item = { type: 'session', workspaceId: 'w', sessionId: 'new', title: 'Chosen' }
    ui.pick({ status: 'selected', items: [item] })
    await ui.click('Choose DSH conversation')
    assert.equal(document.querySelector('.qqb001-destination strong').textContent, 'Chosen')
    await ui.click('Save settings')
    assert.equal(ui.state().bindings[0].endpoint, 'group:456')
    assert.equal(ui.state().bindings[0].sessionId, 'new')
    assert.equal(ui.state().bindings[0].enabled, false)
    assert.equal(ui.state().bindings[0].sendEnabled, false)
    assert.equal(ui.state().bindings[0].modelSelection, undefined)
    assert.equal(ui.state().bindings[0].modelPolicy, 'native-wins')
    ui.pick({ status: 'selected', items: [item], modelSelection: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
    ui.openDetails('More binding options')
    await ui.click('Choose conversation and model')
    assert.equal(ui.pickCalls.at(-1).options.selectModel, true)
    await ui.click('Save settings')
    assert.deepEqual(ui.state().bindings[0].modelSelection, { provider: 'p', model: 'm', reasoningEffort: 'high' })
    assert.equal(ui.state().bindings[0].modelPolicy, 'binding-once')
  } finally { await ui.close() }
})
test('QQ settings saves a send-only group without requiring a DSH conversation', { skip: !upstream }, async () => {
  const ui = await setup({ withPicker: true })
  try {
    await ui.click('Bindings')
    const { document, Event, HTMLInputElement } = ui.dom.window
    const section = [...document.querySelectorAll('details')].find(item => item.querySelector('summary').textContent === 'Send-only QQ chats')
    section.open = true
    await ui.click('Add send-only chat')
    assert.equal(ui.button('Save settings').disabled, true)
    const kind = section.querySelector('select')
    await React.act(async () => { kind.value = 'group'; kind.dispatchEvent(new Event('change', { bubbles: true })) })
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const enter = async (input, value) => React.act(async () => { setValue.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await enter(section.querySelector('input[inputmode=numeric]'), '300')
    await enter(section.querySelector('input[maxlength]'), 'Example group')
    await ui.click('Save settings')
    assert.deepEqual(ui.state().outboundTargets, [{ endpoint: 'group:300', label: 'Example group', enabled: true }])
    assert.equal(ui.state().bindings[0].sessionId, 's')
    assert.equal(ui.pickCalls.length, 0)
  } finally { await ui.close() }
})
test('QQ bindings uses one chat selector to add, switch, and save separate chats', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    await ui.click('Bindings')
    const { document } = ui.dom.window
    const chatSelect = () => ui.field('Choose a QQ chat').querySelector('select')
    assert.equal(chatSelect().options.length, 1)
    assert.equal(chatSelect().value, '0')
    await ui.click('Add binding')
    assert.equal(chatSelect().options.length, 2)
    assert.equal(chatSelect().value, '1')
    await ui.select('QQ chat type', 'group')
    await ui.type('QQ group number', '456')
    await ui.type('Session ID', 'session-two')
    await ui.click('Save settings')
    assert.deepEqual(ui.state().bindings.map(row => [row.endpoint, row.sessionId]), [
      ['private:123', 's'], ['group:456', 'session-two'],
    ])
    assert.equal(document.querySelectorAll('article.qqb001-card').length, 1)
    await ui.select('Choose a QQ chat', '0')
    assert.match(document.querySelector('.qqb001-chat-head strong').textContent, /Private chat 123/)
    assert.equal(document.querySelector('input[inputmode=numeric]').value, '123')
    assert.equal(ui.field('Session ID').querySelector('input').value, 's')
    await ui.select('Choose a QQ chat', '1')
    assert.match(document.querySelector('.qqb001-chat-head strong').textContent, /Group chat 456/)
    assert.equal(document.querySelector('input[inputmode=numeric]').value, '456')
    assert.equal(ui.field('Session ID').querySelector('input').value, 'session-two')
    assert.equal(chatSelect().value, '1')
  } finally { await ui.close() }
})
test('QQ binding links save a custom persona, model, and message rules for the selected chat', { skip: !upstream }, async () => {
  const ui = await setup()
  try {
    const { document } = ui.dom.window
    await ui.click('Bindings')
    assert.ok(ui.button('Message rules'))
    assert.ok(ui.button('Model settings'))
    assert.equal(ui.button('Test this chat').disabled, false)
    assert.ok(ui.openDetails('Persona for this chat'))
    await ui.toggle('Use a custom persona')
    await ui.type('Persona text (literal; no variable interpolation)', 'Answer briefly.')
    await ui.click('Model settings')
    assert.equal(document.querySelector('[role=tabpanel] h3').textContent, 'Model & quota')
    assert.equal(ui.field('Choose a QQ chat').querySelector('select').value, '0')
    await ui.select('Conversation model', '["p","m1"]')
    await ui.select('Reasoning effort', 'high')
    await ui.click('Bindings')
    await ui.click('Message rules')
    assert.equal(document.querySelector('[role=tabpanel] h3').textContent, 'Message behavior')
    assert.equal(ui.openDetails('Rules for a QQ chat').open, true)
    await ui.toggle('Enable sender / mention / probability filters')
    await ui.type('Reply probability (%)', '42')
    await ui.click('Save settings')
    const binding = ui.state().bindings[0]
    assert.deepEqual(binding.persona, { enabled: true, text: 'Answer briefly.' })
    assert.deepEqual(binding.modelSelection, { provider: 'p', model: 'm1', reasoningEffort: 'high' })
    assert.equal(binding.modelPolicy, 'binding-once')
    assert.equal(binding.admission.enabled, true)
    assert.equal(binding.admission.probability, 42)
  } finally { await ui.close() }
})
test('compiled QQ settings displays authentication/error state and retry without pretending success', { skip: !upstream }, async () => {
  const ui = await setup({ fail: true })
  try { assert.ok(ui.dom.window.document.querySelector('[role=alert]')); assert.ok(ui.button('Retry')); assert.equal(ui.dom.window.document.querySelectorAll('[role=tab]').length, 0) }
  finally { await ui.close() }
})
