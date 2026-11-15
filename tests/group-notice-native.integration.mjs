import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as ioPlugin from '../../dsh-super-agent-io/index.mjs'
import { QqBridge } from '../lib/bridge.mjs'
import { MemoryQqStore } from '../lib/store.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { featureTurnFold } from '../lib/native-features.mjs'
import { boundGroupModerationTool } from '../lib/moderation.mjs'

const toolCall = (name, id, args) => {
  const json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
const response = text => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
class MockAdapter extends LlmAdapter {
  constructor(write) { super(); this.script = [toolCall('qq_group_moderate', 'native-1', write ? { action: 'announce', requestMessageId: '-9', content: '测试公告' } : { action: 'list_announcements', requestMessageId: '-9' }), response('已处理公告')] }
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() { const chunks = this.script.shift(); if (!chunks) throw new Error('Unexpected model request'); for (const chunk of chunks) yield chunk }
}
const idle = (ctx, agent) => new Promise(resolve => { const off = ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent && status === 'idle') { off(); resolve() } }) })

for (const write of [false, true]) test(`QQ group notice ${write ? 'write' : 'read'} accepts a real native AgentLoop tool call with verified QQ input`, async () => {
  const ctx = new Context(), rows = new Map()
  await ctx.plugin(Storage)
  const backend = { kv: { async open() { return { loadAll: async () => ({ tables: Object.fromEntries(rows), global: null }), async putRecord(table, key, value) { if (!rows.has(table)) rows.set(table, {}); rows.get(table)[key] = structuredClone(value) }, async deleteRecord() {}, async deleteRecords() {}, async close() {} } } } }
  ctx.storage.backend.register('notice-loop', backend); ctx.provide('storage.backend.notice-loop', backend); await ctx.plugin(Domain, { backend: 'notice-loop' })
  for (const plugin of [LlmRuntime, SessionStore, ProjectionRegistry, SystemPrompt, ToolRuntime, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(write))
  ctx.provide('sessionController', { async list() { return { items: [{ sessionId: 'notice-session' }] } }, async resolveAgent(id) { return { agent: ctx.agents.get(id) } } })
  ctx.provide('sessionQuery', { async observeSession(id) { return { events: ctx.sessions.get(id).snapshotEvents(), [Symbol.dispose]() {} } } })
  await ctx.plugin(ioPlugin, { enabled: true, sendEnabled: true, continuationEnabled: false })
  const agent = await ctx.agentLoop.create('notice-session', { provider: 'mock', model: 'test' })
  ctx.provide('sessionPersistence', { flush: async () => {} })
  const io = ctx.get('superAgentIo')
  const config = normalizeConfig({ enabled: true, sendEnabled: true, bindings: [{ endpoint: 'group:123', sessionId: agent.id, enabled: true, sendEnabled: true }] })
  const binding = config.bindings[0], projection = { stateOf: session => session.snapshotEvents().reduce(featureTurnFold.apply, featureTurnFold.init()) }
  const writes = [], approvals = []
  const onebot = { async call(action, params) {
    if (action === 'get_msg') return { message_id: -9, message_type: 'group', group_id: 123, sender: { user_id: 456 }, message: [{ type: 'text', data: { text: '看一下公告' } }] }
    if (action === 'get_login_info') return { user_id: 789 }
    if (action === 'get_group_member_info') return { group_id: '123', user_id: String(params.user_id), role: write ? 'admin' : 'member' }
    if (action === '_get_group_notice') return [{ notice_id: 'one', message: { text: '公告', images: [] }, settings: null }]
    throw new Error('Unexpected action: ' + action)
  }, async callRaw(action, params, options) { options.beforeSend(); writes.push({ action, params }); return { ok: true } } }
  const bridge = new QqBridge({ io, config, store: new MemoryQqStore(config), onebot })
  await bridge.start()
  const off = agent.ctx.get('tools').register(boundGroupModerationTool(bridge, binding, agent, () => true, { projection, approval: () => ({ async request(input) { approvals.push(input); return 'allowed-once' } }) }))
  try {
    const done = idle(ctx, agent)
    await io.receive({ bindingId: binding.id, externalMessageId: '-9', senderId: '456', content: [{ type: 'text', text: '看一下公告' }] })
    await done
    const tool = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    const result = JSON.parse(tool.data.message.content[0].text)
    assert.equal(result.ok, true)
    if (write) { assert.equal(writes.length, 1); assert.equal(writes[0].action, '_send_group_notice'); assert.equal(approvals.length, 1) }
    else { assert.equal(result.notices[0].noticeId, 'one'); assert.equal(writes.length, 0) }
  } finally { off(); await bridge.dispose(); await ctx.fiber.dispose() }
})
