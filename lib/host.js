// dsh-qq-bridge 0.0.1, derived from Yuuyuko-uu/dsh-qq-link. See LICENSE/PROVENANCE.json.
// Agent scheduling, real assistant projection and history tools belong exclusively to superAgentIo.
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { QqBridge } from './bridge.mjs'
import { QqDomainStore } from './store.mjs'
import { normalizeConfig, DEFAULT_CONFIG } from './config.mjs'
import { DOMAIN_NAME } from './onebot.mjs'
import { createOneBotClient, oneBotAccessToken, ONEBOT_CREDENTIAL_KEY } from './onebot-http.mjs'
import { createMediaAdapter } from './media.mjs'
import { createVoiceSynthesizer } from './voice.mjs'
import { createDeepSeekVoiceSynthesizer } from './official-voice.mjs'
import { registerRoutes } from './routes.mjs'
import { BindingModelPolicy } from './model-policy.mjs'
import { QuotaPolicy } from './quota-policy.mjs'
import { InboundAsr } from './asr.mjs'
import { NativeFeatures, featureTurnFold } from './native-features.mjs'
import { HistoryPoller } from './polling.mjs'
import { QzoneTools } from './qzone.mjs'
import { ScheduleTools } from './schedule-tools.mjs'
import { QqHistoryTools } from './history-tool.mjs'
import { createQqSinger } from './singing.mjs'
import { boundRecallTool, boundGroupModerationTool, moderationTool } from './moderation.mjs'
import { QqButtonActions } from './button-tool.mjs'
import { QqRecallFeed } from './recall-feed.mjs'
import { QqStatus, qqStatusText, qqStatusTool } from './status.mjs'
import { QqGroupAlbums } from './group-album.mjs'
import { HostPermissions } from './host-permissions.mjs'
export const name = 'qq-bridge-001'
export const inject = ['superAgentIo', 'storageDomain', 'webServer', 'connection', 'credentials', 'sessionController', 'agents', 'timer']
// Only the network switch is live-editable through the owner's native configuration form.
export const Config = z.object({ networkAccess: z.boolean().default(false).volatile(), oneBotEventConfig: z.string().default(''), mmxEntry: z.string().default(''), coverRoot: z.string().default(''), soulxRoot: z.string().default(''), modelPolicyTimeoutMs: z.number().step(1).min(100).max(120000).default(10000), quotaMaxTurnEvents: z.number().step(1).min(16).max(4096).default(512) })
const json = schema.json()
export const domainSpec = defineDomain({ name: DOMAIN_NAME, version: 1, layout: 'per-record', global: { schema: json.transform((value, context) => { try { return normalizeConfig(value) } catch { context.addIssue({ code: 'custom', message: 'Invalid QQ configuration' }); return schema.NEVER } }), initial: structuredClone(DEFAULT_CONFIG) }, tables: { backpressure: { valueSchema: schema.object({ state: schema.literal('backpressure'), externalMessageId: schema.string(), retryAfterMs: schema.number().positive(), reason: schema.string(), at: schema.number(), queued: schema.literal(false) }).strict() }, asr: { valueSchema: schema.object({ state: schema.enum(['transcribing', 'complete']), content: schema.array(json).max(3) }).strict() }, admission: { valueSchema: schema.object({ admitted: schema.boolean(), mentioned: schema.boolean(), at: schema.number(), reason: schema.string().optional() }).strict() }, admission_state: { valueSchema: schema.object({ window: schema.array(schema.number()).max(60), tailLeft: schema.number().int().nonnegative(), tailUntil: schema.number(), lastDelivered: schema.number() }).strict() }, gates: { valueSchema: schema.object({ reply: schema.boolean(), mentioned: schema.boolean(), reason: schema.string().max(160) }).strict() }, ingress: { valueSchema: schema.object({ version: schema.literal(1), traceId: schema.string() }).strict() }, quota: { valueSchema: schema.object({ version: schema.literal(1), policyKey: schema.string(), state: schema.enum(['pending', 'selecting', 'applied', 'native-wins', 'cancelled', 'exhausted']), used: schema.number().int().nonnegative(), failureTurn: schema.number().int(), failedSelection: schema.object({ provider: schema.string(), model: schema.string(), reasoningEffort: schema.string().optional() }), externalMessageId: schema.string(), failureKind: schema.string(), selected: schema.object({ provider: schema.string(), model: schema.string(), reasoningEffort: schema.string().optional() }).optional() }).strict() }, models: { valueSchema: schema.object({ version: schema.literal(1), requestKey: schema.string(), state: schema.enum(['pending', 'selecting', 'applied', 'native-wins', 'cancelled']), lastApplied: schema.object({ provider: schema.string(), model: schema.string(), reasoningEffort: schema.string().optional() }).optional(), pendingBaseline: schema.object({ provider: schema.string(), model: schema.string(), reasoningEffort: schema.string().optional() }).optional() }).strict() }, messages: { valueSchema: schema.object({ endpoint: schema.string(), ambiguous: schema.boolean().optional() }).strict() }, deliveries: { valueSchema: schema.object({ version: schema.literal(1), state: schema.enum(['sending', 'delivered', 'failed', 'unknown']), externalMessageId: schema.string().optional(), reason: schema.string().optional(), parts: schema.array(schema.string()).optional() }).strict() }, migration: { valueSchema: schema.object({ version: schema.literal(1), value: json, importedAt: schema.number() }).strict() } } })
domainSpec.tables.polling = { valueSchema: schema.object({ version: schema.literal(1), watermark: schema.number().nonnegative(), enabledAt: schema.number() }).strict() }
domainSpec.tables.polling_run = { valueSchema: schema.object({ version: schema.literal(1), enabled: schema.boolean(), enabledAt: schema.number() }).strict() }
domainSpec.tables.admission_state.valueSchema = domainSpec.tables.admission_state.valueSchema.extend({ sentWindow: schema.array(schema.number()).max(60).optional() })
domainSpec.tables.deliveries.valueSchema = domainSpec.tables.deliveries.valueSchema.extend({ replacement: schema.object({ published: schema.boolean().nullable(), originalRemoved: schema.boolean().nullable() }).strict().optional() })
domainSpec.tables.outbox = { valueSchema: schema.object({ version: schema.literal(1), bindingId: schema.string(), endpoint: schema.string(), entries: schema.array(json).max(500) }).strict() }
domainSpec.tables.messages.valueSchema = domainSpec.tables.messages.valueSchema.extend({
  senderId: schema.string().optional(), senderName: schema.string().max(120).optional(), excerpt: schema.string().max(320).optional(),
  time: schema.number().optional(), outbound: schema.boolean().optional(), origin: schema.string().optional(), originSessionId: schema.string().optional(),
})
domainSpec.tables.recalls = { valueSchema: schema.object({
  origin: schema.string(), endpoint: schema.string(), messageId: schema.string(), authorId: schema.string(), operatorId: schema.string(), at: schema.number(),
  authorName: schema.string().max(120).optional(), excerpt: schema.string().max(320).optional(), messageTime: schema.number().optional(), shown: schema.boolean().optional(),
}).strict() }
export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(domainSpec), store = new QqDomainStore(domain)
  let bridge, poller, recallFeed
  const networkEnabled = () => config.networkAccess?.get?.() === true
  const secret = async origin => oneBotAccessToken((await ctx.credentials.readRecord(ONEBOT_CREDENTIAL_KEY))?.env, origin)
  const networkFetch = (...args) => {
    if (!networkEnabled()) throw new Error('NETWORK_ACCESS_DISABLED')
    return globalThis.fetch(...args)
  }
  const onebot = createOneBotClient({ config: () => bridge?.config ?? store.config(), token: secret, fetch: networkFetch })
  const qqStatus = new QqStatus({ onebot, origin: () => bridge?.config.baseUrl, networkEnabled,
    signal: () => bridge?.controller.signal, groupAllowed: endpoint => bridge?.statusGroupAllowed(endpoint) })
  const attachments = ctx.get('attachments')
  const singing = config.coverRoot && attachments ? createQqSinger({ root: config.coverRoot, soulxRoot: config.soulxRoot, attachments }) : undefined
  const media = createMediaAdapter({ attachments, singing, fetch: networkFetch, memeService: () => ctx.get('dshMeme'), async workspace(sessionId, signal) {
    const agent = ctx.agents.get(sessionId)
    if (!agent) return
    const cwd = await agent.ctx.get('workingDirectory')?.ensure(agent, signal) ?? agent.session.header.cwd
    return { cwd, root: agent.session.header.cwd ?? cwd, fs: agent.ctx.get('fs') }
  } })
  const voiceCache = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'qq-bridge-001-tts')
  const minimaxVoice = createVoiceSynthesizer({ cacheDir: voiceCache, mmxEntry: config.mmxEntry || join(process.env.APPDATA || '', 'npm', 'node_modules', 'mmx-cli', 'dist', 'mmx.mjs') })
  const deepseekVoice = createDeepSeekVoiceSynthesizer({ cacheDir: voiceCache, resolveApiKey: async () => (await ctx.credentials.resolve('DEEPSEEK_API_KEY'))?.value,
    webSocketFactory: (url, protocols) => { if (!networkEnabled()) throw new Error('NETWORK_ACCESS_DISABLED'); return new WebSocket(url, protocols) } })
  const synthesize = (text, options, context) => (options.provider === 'deepseek' ? deepseekVoice : minimaxVoice)(text, options, context)
  let offRoutes, projection, offAgentCreated
  const ownerTools = []
  const stop = async () => { for (const dispose of ownerTools.splice(0)) dispose(); offRoutes?.(); offAgentCreated?.(); await recallFeed?.dispose(); await bridge?.dispose(); await poller?.dispose(); await projection?.dispose(); await domain.close() }
  ctx.effect(() => stop, 'qq-bridge-001: lifecycle')
  try {
    ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
    const modelPolicy = new BindingModelPolicy({ timeoutMs: config.modelPolicyTimeoutMs, liveAgent: id => ctx.agents.get(id), resolveAgent: id => ctx.sessionController.resolveAgent(id), catalog: () => ctx.sessionController.modelCatalog(), store, binding: id => bridge?.config.enabled ? bridge.config.bindings.find(row => row.id === id) : undefined, watch(agent, handlers) {
      const scoped = agent.ctx
      if (!scoped || typeof scoped.on !== 'function') return () => {}
      const offStopping = scoped.on('agent/turn-stopping', payload => handlers.stopping(payload.signal))
      const offCancel = scoped.on('session/event', (session, event) => { if (session.id === agent.id && event.type === 'turn/end' && ['aborted', 'interrupted'].includes(event.data.reason.kind)) void handlers.cancelled().catch(() => {}) })
      // A cancelled turn may go idle without turn-stopping. Do not use an idle notification to override cancellation.
      return () => { offStopping(); offCancel() }
    } })
    const quotaPolicy = new QuotaPolicy({ timeoutMs: config.modelPolicyTimeoutMs, maxTurnEvents: config.quotaMaxTurnEvents, resolveAgent: id => ctx.sessionController.resolveAgent(id), liveAgent: id => ctx.agents.get(id), catalog: () => ctx.sessionController.modelCatalog(), store, binding: id => bridge?.config.enabled ? bridge.config.bindings.find(row => row.id === id) : undefined, watch(agent, observe) {
      return agent.ctx.on('session/event', (session, event) => { if (session.id === agent.id) void observe(event).catch(() => {}) })
    } })
    const projections = ctx.get('sessionProjections')
    if (projections) projection = await projections.register({ key: 'qq-bridge-001.features-turn', stateVersion: 1, stateSchema: schema.object({ turn: schema.number(), active: schema.boolean(), exclusive: schema.boolean(), bindingId: schema.string(), inputs: schema.array(schema.string()).max(1000) }).strict(), ...featureTurnFold })
    const activeBinding = id => bridge?.config.enabled ? bridge.config.bindings.find(row => row.id === id) : undefined
    const qzone = new QzoneTools({ onebot, binding: activeBinding, networkEnabled, sendEnabled: () => bridge?.config.enabled === true && bridge.config.sendEnabled === true })
    const scheduleTools = new ScheduleTools({ schedule: () => ctx.get('schedule'), binding: activeBinding, bindings: () => bridge?.config.bindings ?? [] })
    const history = new QqHistoryTools({ onebot, store, origin: () => bridge?.config.baseUrl, binding: activeBinding, networkEnabled, enabled: () => bridge?.config.enabled === true })
    const nativeFeatures = new NativeFeatures({ timeoutMs: config.modelPolicyTimeoutMs, resolveAgent: id => ctx.sessionController.resolveAgent(id), liveAgent: id => ctx.agents.get(id), binding: id => bridge?.featureBinding(activeBinding(id)), projection, store, qzone, schedule: scheduleTools, history })
    nativeFeatures.singing = singing
    nativeFeatures.singingAllowed = id => networkEnabled() && bridge?.config.sendEnabled === true && activeBinding(id)?.sendEnabled === true
    const asr = new InboundAsr({ controller: ctx.get('speechController'), attachments: ctx.get('attachments'), onebot, store, fetch: networkFetch, allowed: id => networkEnabled() && activeBinding(id)?.enabled === true && bridge.config.asr.enabled === true })
    offAgentCreated = ctx.on('agent/created', async ({ agent }) => { const row = bridge?.config.enabled && bridge.config.bindings.find(row => row.sessionId === agent.id && row.enabled); if (row) await nativeFeatures.prepare(bridge.featureBinding(row), agent) })
    bridge = new QqBridge({ io: ctx.superAgentIo, onebot, store, media, modelPolicy, quotaPolicy, asr, nativeFeatures, qqStatus, config: store.config(), networkEnabled, synthesize: (text, options, context) => networkEnabled() ? synthesize(text, options, context) : Promise.resolve(''), onConfig: async config => { await poller?.sync(config); void recallFeed?.sync() }, report: event => {
      if (event?.code === 'QQ_MEME_UNAVAILABLE') ctx.logger?.warn('QQ 表情图片未找到或无法读取')
      if (event?.code === 'QQ_RECALL_RECORD_UNCONFIRMED') ctx.logger?.warn('QQ 已确认撤回，DSH 记录写入失败')
    } })
    bridge.scheduleAvailable = !!ctx.get('schedule')
    const groupAlbums = new QqGroupAlbums(bridge, { projection })
    nativeFeatures.groupAlbums = groupAlbums
    nativeFeatures.outbox = bridge.outbox
    nativeFeatures.statusTool = (binding, allowed) => qqStatusTool(bridge, binding, allowed)
    nativeFeatures.statusText = binding => {
      const snapshot = qqStatus.snapshot(binding.endpoint)
      if (snapshot.reason) return qqStatusText(snapshot) + ' QQ 外发暂停，可用 qq_chat_status 核对。'
      if (snapshot.chat?.wholeMuted) return qqStatusText(snapshot) + (snapshot.canSend ? ' 当前账号可发言。' : ' 可用 qq_chat_status 核对。')
      return ''
    }
    nativeFeatures.ownRecall = (binding, authorize) => boundRecallTool(bridge, binding, authorize)
    nativeFeatures.recallAllowed = id => networkEnabled() && !!bridge.sendTarget(id)
    nativeFeatures.groupModeration = (binding, agent, current) => boundGroupModerationTool(bridge, binding, agent, current, { projection, approval: () => ctx.get('approval') })
    await bridge.start()
    const available = () => networkEnabled() && bridge.config.sendEnabled === true
    const registerChannel = typeof ctx.superAgentIo.registerChannelTool === 'function'
      ? (definition => ctx.superAgentIo.registerChannelTool(definition, available))
      : ctx.get('tools') ? (definition => ctx.get('tools').register(definition, { when: available })) : undefined
    if (registerChannel) {
      ownerTools.push(registerChannel(bridge.outbox.definition({ name: 'qq_buffer' })))
      ownerTools.push(registerChannel(bridge.outbox.definition({ name: 'qq_outbox' })))
      const prompt = ctx.get('systemPrompt')
      if (prompt) ownerTools.push(prompt.section({ name: 'qq-bridge-001.channel', order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: () => available() ? '你可在任何会话自主使用 qq_buffer 或 qq_outbox 管理 QQ 待发消息。send 返回 QQ_CONTEXT_REVIEW 时，结合最新聊天和草稿判断时机、核对当前工作状态；决定发送时用相同目标、条目和 finish 值携带 reviewId 再 send。qq_buffer 的 read 和发送预览有 peerInput：这是私聊对方最近上报的输入状态，可结合时间自行决定是否稍等；unknown 表示当前未知。模拟输入期间继续接收新消息。计时结束会返回 QQ_TYPING_CONFIRM，查看最新聊天和草稿后自主决定：要发送就用相同 id、finish、reviewId 再调用 send；也可 replace 改稿或 clear 不发。若收到 QQ_CONTEXT_CHANGED_DURING_TYPING，也先结合新消息再决定。合并零散消息，话题改变或别人已经回答时删去过时、重复的内容，无需补充就清空草稿；持续有人说话时可自主用 sendNow=true 先发。后台发送用 background=true，计时结束会唤醒你；用 watch(jobId) 查进度和结果，期间可处理消息或用 cancel_typing 停止，未取得回执时按待发送处理。普通文字的实际换行会拆成独立草稿，请结合聊天逐条决定是否发送。发送时可在 qq_buffer 使用 typing 控制速度（instant 即刻、slow 慢、normal 自然、fast 快），并在预览中查看预计时间；若先说要查记录，发送后就在本轮实际查完；准备结束时如实表述已完成的状态。当前会话绑定 QQ 时默认该聊天，其他目标可填 group:群号 或 private:QQ号。' : '', interpolate: false }))
    }
    if (typeof ctx.superAgentIo.registerOwnerTool === 'function') {
      const albumTools = groupAlbums.definitions()
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(albumTools.list, networkEnabled))
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(albumTools.upload, available))
      if (!registerChannel) ownerTools.push(ctx.superAgentIo.registerOwnerTool(bridge.outbox.definition(), available))
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(qqStatusTool(bridge)))
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(history.ownerTool(bridge), available))
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(moderationTool(bridge, { networkEnabled, approval: () => ctx.get('approval') }), available))
      bridge.buttonActions = new QqButtonActions(bridge, { networkEnabled })
      ownerTools.push(ctx.superAgentIo.registerOwnerTool(bridge.buttonActions.definition(), available))
    }
    poller = new HistoryPoller({ onebot, store, receive: event => bridge.receive(event, { via: 'polling' }), config: () => bridge.config, interval: typeof ctx.interval === 'function' ? (fn, ms) => ctx.interval(fn, ms) : undefined })
    bridge.poller = poller
    await poller.start(bridge.config)
    recallFeed = new QqRecallFeed({ bridge, file: config.oneBotEventConfig })
    bridge.recallFeed = recallFeed
    recallFeed.start()
    const hostPermissions = new HostPermissions({ service: () => ctx.get('permissionPresets'), sandbox: () => ctx.get('sandboxPolicy'),
      bindings: () => bridge.config.bindings, liveAgent: id => ctx.agents.get(id), resolveAgent: id => ctx.sessionController.resolveAgent(id) })
    offRoutes = registerRoutes({ webServer: ctx.webServer, connection: ctx.connection, bridge, credentials: ctx.credentials, onebot, hostPermissions,
      modelCatalog: () => ctx.sessionController.modelCatalog(), networkEnabled, schedule: ctx.get('schedule'), bindings: () => bridge.config.bindings })
    // Only exact Agent-scoped model/quota observers; no global output driver, approval/sandbox replacement or self-update.
  } catch (error) { await stop(); throw error }
}
