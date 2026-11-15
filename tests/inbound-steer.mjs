// 回归：QQ → DSH 的消息进入一个正在跑的会话时，必须走 DSH 的「插话」通道
// （agent.steer），而不是永远排成下一轮（agent.followup）。
//
// 跑法：node tests/inbound-steer.mjs
//
// 用假 ctx / 假 fetch 把「QQ → DSH」这半跑一遍，只关心投递方式：
//   1) agent 空闲 → followup（照常开一轮）
//   2) agent 正在跑 → steer（下一步并入当前轮），且不再 followup
//   3) 对端没有 steer（旧宿主）→ 即使 status=running 也退回 followup
//   4) 插话之后状态回到空闲，下一条仍然正常开一轮
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const originalFetch = globalThis.fetch
const originalTimeout = globalThis.setTimeout
const originalClear = globalThis.clearTimeout
const originalHome = process.env.DSH_HOME
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
const message = (id = 1, time = 9999999999) => ({ user_id: 123, time, message_id: id,
  message: [{ type: 'text', data: { text: 'synthetic' } }] })
const history = (messages = [message()]) => ({ status: 'ok', data: { messages } })
const response = data => ({ json: async () => data })
let serial = 0

async function fixture({ status = 'idle', withSteer = true } = {}) {
  const fixtureRoot = resolve('tests/.tmp'); mkdirSync(fixtureRoot, { recursive: true })
  const home = mkdtempSync(join(fixtureRoot, 'qq-steer-'))
  process.env.DSH_HOME = home
  const hostPath = resolve(process.env.QQ_TEST_HOST || 'lib/legacy-host.js')
  const host = await import(pathToFileURL(hostPath).href + '?steer=' + ++serial)
  mkdirSync(join(home, 'qq-bridge-001-legacy'), { recursive: true })
  writeFileSync(join(home, 'qq-bridge-001-legacy', 'qq-bridge-001-legacy-config.json'), JSON.stringify({ 总开关: true, 试运行: true, 收图: false,
    合并窗口秒: 0, 回复冷却秒: 0, 每分钟最多条: 999,
    绑定: [{ 类型: '私聊', 号码: '123', 会话: 'session-X' }], NapCat: 'http://synthetic.invalid' }))
  const timers = new Map(), calls = { followup: [], steer: [] }
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms < 5000) return originalTimeout(fn, ms, ...args)
    const id = {}; timers.set(id, { fn, ms }); return id
  }
  globalThis.clearTimeout = id => timers.delete(id) || originalClear(id)
  let fetchImpl = async () => response(history())
  globalThis.fetch = (...args) => fetchImpl(...args)
  const agent = { session: { id: 'session-X' }, status,
    followup: m => { calls.followup.push(m); return Promise.resolve() } }
  if (withSteer) agent.steer = m => { calls.steer.push(m) }
  let tick, flush = async () => {}
  const offs = []
  host.apply({ qqBridgeMockFetch: (...args) => fetchImpl(...args), effect(fn) { offs.push(fn()) }, on: () => () => {}, webServer: { register() {} },
    interval(fn) { tick = fn; return () => {} }, agents: { get: () => agent },
    sessions: { flush: () => flush() }, logger: { info() {} }, get() {} })
  return {
    calls, agent,
    setStatus: next => { agent.status = next },
    start: () => tick(),
    setFetch: fn => { fetchImpl = fn },
    close() {
      offs.forEach(fn => fn?.())
      globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; globalThis.fetch = originalFetch
      if (dirname(home) !== fixtureRoot || !basename(home).startsWith('qq-steer-')) throw new Error('Unexpected fixture cleanup path: ' + home)
      rmSync(home, { recursive: true, force: true })
      if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
    },
  }
}

let failures = 0
async function check(label, run, options) {
  const f = await fixture(options)
  try { await run(f); console.log('PASS ' + label) }
  catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.stack) }
  finally { f.close() }
}

await check('idle agent receives a followup turn, not a steer', async f => {
  await f.start(); await settle()
  assert.equal(f.calls.followup.length, 1, 'one followup')
  assert.equal(f.calls.steer.length, 0, 'no steer while idle')
  assert.equal(f.calls.followup[0].source.kind, 'qq')
})

const running = { status: 'running' }
await check('running agent receives steering instead of a queued next turn', async f => {
  await f.start(); await settle()
  assert.equal(f.calls.steer.length, 1, 'one steer')
  assert.equal(f.calls.followup.length, 0, 'no queued followup while running')
  const msg = f.calls.steer[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'qq')
  assert.equal(msg.content[0].type, 'text')
}, running)

await check('a host without steer falls back to followup even while running', async f => {
  await f.start(); await settle()
  assert.equal(f.calls.steer.length, 0, 'no steer available')
  assert.equal(f.calls.followup.length, 1, 'fallback followup')
}, { ...running, withSteer: false })

await check('after steering, an idle agent still starts the next turn normally', async f => {
  await f.start(); await settle()
  assert.equal(f.calls.steer.length, 1)
  f.setStatus('idle')
  f.setFetch(async () => response(history([message(1, 9999999999), message(2, 10000000000)])))
  await f.start(); await settle()
  assert.equal(f.calls.steer.length, 1, 'second message did not steer')
  assert.equal(f.calls.followup.length, 1, 'second message started a turn')
}, running)

if (failures) {
  console.error(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nALL PASS')
