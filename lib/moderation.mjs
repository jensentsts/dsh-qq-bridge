import { createHash } from 'node:crypto'
import { normalizeSegments, parseEndpoint } from './onebot.mjs'
import { OneBotError } from './onebot-http.mjs'
import { recalledMessage } from './recall.mjs'

const labels = { kick: '踢出群成员', mute: '禁言', unmute: '解除禁言', announce: '发布群公告', list_announcements: '查看群公告', draft_announcement: '编辑公告草稿', edit_announcement: '替换群公告', delete_announcement: '删除群公告', recall: '撤回消息' }
const qqNumber = /^[1-9]\d{0,23}$/
const readOptions = { timeoutMs: 5000, maxBytes: 65536 }
const maxMuteSeconds = 2592000
const maxNoticeLength = 1000
const rejected = (code = 'QQ_ACTION_REJECTED', details = {}) => ({ ok: false, state: 'failed', code, ...details })
const unknown = (code = 'QQ_ACTION_RESPONSE_UNKNOWN') => ({ ok: false, state: 'unknown', code })
const succeeded = { ok: true, state: 'delivered' }
const readError = code => new OneBotError(code, 'failed')
const boundedText = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max)
const noticeIdOf = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : ''
const noticeOptions = args => {
  for (const key of ['pinned', 'newMembers', 'popup', 'confirmRequired', 'promptEditCard']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw readError('INVALID_ANNOUNCEMENT_OPTION')
  const content = typeof args.content === 'string' ? args.content.trim() : ''
  if (!content || content.length > maxNoticeLength) throw readError('INVALID_ANNOUNCEMENT')
  return { content, type: args.newMembers ? 20 : 1, pinned: args.pinned ? 1 : 0, tip_window_type: args.popup ? 0 : 1, confirm_required: args.confirmRequired ? 1 : 0, is_show_edit_card: args.promptEditCard ? 1 : 0 }
}
function summarizedNotices(value) {
  if (!Array.isArray(value)) throw readError('QQ_ANNOUNCEMENTS_INVALID')
  return value.slice(0, 50).flatMap(row => {
    const noticeId = noticeIdOf(row?.notice_id ?? row?.fid)
    if (!noticeId) return []
    const images = Array.isArray(row.message?.images) ? row.message.images : Array.isArray(row.message?.image) ? row.message.image : []
    let settings = row.settings
    if (typeof settings === 'string') try { settings = JSON.parse(settings) } catch { settings = undefined }
    const flag = (value, inverted = false) => {
      if (![0, 1, '0', '1', false, true].includes(value)) return undefined
      return (Number(value) === 1) !== inverted
    }
    const popup = flag(settings?.tip_window_type, true), confirmRequired = flag(settings?.confirm_required), promptEditCard = flag(settings?.is_show_edit_card)
    return [{ noticeId, content: boundedText(row.message?.text ?? row.content, maxNoticeLength), senderId: String(row.sender_id ?? ''), publishTime: Number(row.publish_time) || 0, readCount: Number(row.read_num) || 0, pinned: Number(row.pinned) === 1, newMembers: row.send_to_new_members === true || Number(row.type) === 20, ...(popup === undefined ? {} : { popup }), ...(confirmRequired === undefined ? {} : { confirmRequired }), ...(promptEditCard === undefined ? {} : { promptEditCard }), images: images.slice(0, 4).map(image => ({ id: boundedText(image?.id, 256), url: boundedText(image?.url, 2048) })) }]
  })
}
const noticeSignature = row => JSON.stringify([row.noticeId, row.content, row.pinned, row.newMembers, row.popup, row.confirmRequired, row.promptEditCard, row.images])
function preserveNotice(plan, previous, args) {
  if (args.pinned === undefined) plan.params.pinned = previous.pinned ? 1 : 0
  if (args.newMembers === undefined) plan.params.type = previous.newMembers ? 20 : 1
  for (const [key, param] of [['popup', 'tip_window_type'], ['confirmRequired', 'confirm_required'], ['promptEditCard', 'is_show_edit_card']]) {
    if (args[key] !== undefined) continue
    if (previous[key] === undefined) throw readError('QQ_ANNOUNCEMENT_SETTINGS_UNKNOWN')
    plan.params[param] = key === 'popup' ? previous[key] ? 0 : 1 : previous[key] ? 1 : 0
  }
  if (previous.images.length > 1) throw readError('QQ_ANNOUNCEMENT_IMAGES_UNSUPPORTED')
  if (previous.images.length === 1) {
    try {
      const url = new URL(previous.images[0].url)
      if (url.origin !== 'https://gdynamic.qpic.cn' || url.username || url.password || url.hash) throw new Error('invalid image')
      plan.params.image = url.href
    } catch { throw readError('QQ_ANNOUNCEMENT_IMAGE_UNAVAILABLE') }
  }
}

function planAction(args, peer) {
  const { action, userId, messageId, durationSeconds } = args
  if (!Object.hasOwn(labels, action)) throw readError('INVALID_ACTION')
  if (action === 'recall') {
    const id = Number(messageId)
    if (typeof messageId !== 'string' || !/^-?\d{1,10}$/.test(messageId) || id < -2147483648 || id > 2147483647) throw readError('INVALID_MESSAGE_ID')
    return { action: 'delete_msg', params: { message_id: id }, detail: `消息 ${id}` }
  }
  if (peer.kind !== 'group') throw readError('GROUP_REQUIRED')
  const group_id = peer.id
  if (action === 'list_announcements') return { action: '_get_group_notice', params: { group_id }, readOnly: true }
  if (['announce', 'draft_announcement', 'edit_announcement'].includes(action)) {
    const params = { group_id, ...noticeOptions(args) }
    const noticeId = action === 'edit_announcement' ? noticeIdOf(args.noticeId) : undefined
    if (action === 'edit_announcement' && !noticeId) throw readError('INVALID_ANNOUNCEMENT_ID')
    return { action: '_send_group_notice', params, ...(noticeId ? { noticeId } : {}), ...(action === 'draft_announcement' ? { preview: true } : {}), detail: (noticeId ? `原公告 ${noticeId}\n新公告发布成功后删除原公告\n` : '') + (args.pinned ? '置顶公告\n' : '') + params.content }
  }
  if (action === 'delete_announcement') {
    const noticeId = noticeIdOf(args.noticeId)
    if (!noticeId) throw readError('INVALID_ANNOUNCEMENT_ID')
    return { action: '_del_group_notice', params: { group_id, notice_id: noticeId }, noticeId, detail: `公告 ${noticeId}` }
  }
  if (typeof userId !== 'string' || !qqNumber.test(userId)) throw readError('INVALID_QQ_NUMBER')
  if (action === 'kick') return { action: 'set_group_kick', params: { group_id, user_id: userId, reject_add_request: false }, detail: `QQ ${userId}` }
  const duration = action === 'unmute' ? 0 : durationSeconds
  if (!Number.isSafeInteger(duration) || duration < (action === 'unmute' ? 0 : 1) || duration > maxMuteSeconds) throw readError('INVALID_MUTE_DURATION')
  return { action: 'set_group_ban', params: { group_id, user_id: userId, duration }, detail: `QQ ${userId}${duration ? `，${duration} 秒` : ''}` }
}

async function loginId(onebot, signal) {
  const account = await onebot.call('get_login_info', {}, { ...readOptions, signal })
  const id = String(account?.user_id ?? '')
  if (!qqNumber.test(id)) throw readError('QQ_ACCOUNT_UNAVAILABLE')
  return id
}

async function groupRole(onebot, groupId, userId, signal) {
  const info = await onebot.call('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: true }, { ...readOptions, signal })
  if (String(info?.group_id) !== groupId || String(info?.user_id) !== userId || !['owner', 'admin', 'member'].includes(info?.role)) throw readError('QQ_GROUP_ROLE_UNVERIFIED')
  return info.role
}

async function verifyAction(bridge, target, peer, plan, selfId, signal, ownOnly) {
  const { onebot } = bridge
  let recall
  if (plan.action === 'delete_msg') {
    const messageId = String(plan.params.message_id)
    const known = await bridge.store.messageRecord(messageId)
    if (ownOnly && (!known?.outbound || known.endpoint !== target.endpoint || known.origin !== bridge.config.baseUrl || known.originSessionId !== target.sessionId)) {
      throw readError('QQ_RECALL_NOT_OWN_MESSAGE')
    }
    const data = await onebot.call('get_msg', plan.params, { signal, timeoutMs: 5000, maxBytes: 1048576 })
    let original
    try {
      const knownEndpoint = peer.kind === 'private' && (!known?.origin || known.origin === bridge.config.baseUrl) ? known?.endpoint : undefined
      original = recalledMessage(data, { endpoint: target.endpoint, messageId, selfId, knownEndpoint })
    } catch { throw readError('QQ_MESSAGE_TARGET_UNVERIFIED') }
    recall = { endpoint: target.endpoint, messageId, authorId: original.senderId, authorName: original.senderName, excerpt: original.excerpt, ...(original.time ? { messageTime: original.time } : {}) }
    if (recall.authorId === selfId) return recall
    if (ownOnly) throw readError('QQ_RECALL_NOT_OWN_MESSAGE')
    if (peer.kind === 'private') throw readError('QQ_RECALL_OTHER_GROUP_ONLY')
    plan.detail += `，发送者 QQ ${recall.authorId}`
  }
  const role = await groupRole(onebot, peer.id, selfId, signal)
  if (role === 'member') throw readError('QQ_GROUP_ADMIN_REQUIRED')
  const member = plan.params.user_id
  if (member === selfId) throw readError('QQ_TARGET_IS_SELF')
  if (member && role === 'admin' && await groupRole(onebot, peer.id, member, signal) !== 'member') throw readError('QQ_GROUP_TARGET_ROLE')
  const permission = plan.action === 'delete_msg' ? 'recall_member_message' : plan.action === 'set_group_kick' ? 'kick_member' : undefined
  if (role === 'admin' && permission) {
    // This extension is optional. QQ still evaluates the actual action.
    const info = await onebot.call('get_group_admin_permissions', { group_id: peer.id, user_id: selfId }, { ...readOptions, signal }).catch(() => undefined)
    if (info?.[permission] === false) throw readError('QQ_GROUP_ADMIN_PERMISSION_DENIED')
  }
  return recall
}

export function moderationTool(bridge, { networkEnabled, approval = () => undefined, ownOnly = false, requesterGuard, requesterLabel = '' }) {
  return {
    name: 'qq_moderate',
    description: '按 DSH 用户指示管理 QQ 聊天。群公告用 list_announcements 查看，draft_announcement 编辑预览，announce 发布，edit_announcement 替换已发布公告（先发新公告再删除选中的旧公告），delete_announcement 删除。用 io_destinations 确认目标，用 qq_recent 核对成员 QQ 号或待撤回的 messageId。群管理写入会显示确认。',
    parameters: {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Exact QQ destination from io_destinations.' },
        action: { type: 'string', enum: Object.keys(labels) },
        userId: { type: 'string', description: 'Member QQ number for kick, mute or unmute.' },
        messageId: { type: 'string', description: 'Original OneBot messageId for recall. Keep its sign.' },
        durationSeconds: { type: 'integer', description: 'Required for mute, from 1 to 2592000 seconds.' },
        content: { type: 'string', description: 'Announcement text for announce, up to 1000 characters.' },
        noticeId: { type: 'string', description: '公告原始 ID；编辑或删除已发布公告时必填，从 list_announcements 获取。' },
        pinned: { type: 'boolean', description: '公告置顶。' },
        newMembers: { type: 'boolean', description: '发布为新成员公告。' },
        popup: { type: 'boolean', description: '在 QQ 中弹窗展示公告。' },
        confirmRequired: { type: 'boolean', description: '要求群成员确认收到公告。' },
        promptEditCard: { type: 'boolean', description: '提示群成员编辑群昵称。' },
      },
      required: ['destination', 'action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, state: { type: 'string', enum: ['delivered', 'failed', 'unknown'] }, code: { type: 'string' }, retcode: { type: 'integer' }, detail: { type: 'string' },
          notices: { type: 'array', items: { type: 'object', properties: { noticeId: { type: 'string' }, content: { type: 'string' }, senderId: { type: 'string' }, publishTime: { type: 'number' }, readCount: { type: 'number' }, pinned: { type: 'boolean' }, newMembers: { type: 'boolean' }, popup: { type: 'boolean' }, confirmRequired: { type: 'boolean' }, promptEditCard: { type: 'boolean' }, images: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' } }, required: ['id', 'url'], additionalProperties: false } } }, required: ['noticeId', 'content', 'senderId', 'publishTime', 'readCount', 'pinned', 'newMembers', 'images'], additionalProperties: false } },
          draft: { type: 'object', properties: { content: { type: 'string' }, pinned: { type: 'boolean' }, newMembers: { type: 'boolean' }, popup: { type: 'boolean' }, confirmRequired: { type: 'boolean' }, promptEditCard: { type: 'boolean' } }, required: ['content', 'pinned', 'newMembers', 'popup', 'confirmRequired', 'promptEditCard'], additionalProperties: false },
          replacement: { type: 'object', properties: { published: { oneOf: [{ type: 'boolean' }, { type: 'null' }] }, originalRemoved: { oneOf: [{ type: 'boolean' }, { type: 'null' }] } }, required: ['published', 'originalRemoved'], additionalProperties: false } },
        required: ['ok', 'state'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec, authorize) {
      if (ownOnly && args.action !== 'recall') return rejected('INVALID_ACTION')
      const target = bridge.sendTarget(args.destination, true)
      if (!target || !networkEnabled()) return rejected('DESTINATION_UNAVAILABLE')
      const baseUrl = bridge.config.baseUrl, peer = parseEndpoint(target.endpoint)
      const signal = AbortSignal.any([exec.signal, bridge.controller.signal])
      const anchor = authorize()
      const key = 'moderation:' + JSON.stringify([anchor.reply.sessionId, anchor.reply.seq, anchor.callId])
      let plan
      try { plan = planAction(args, peer) } catch (error) { return rejected(error.code) }
      const intent = createHash('sha256').update(JSON.stringify(plan.noticeId ? [target.endpoint, plan.action, plan.params, plan.noticeId] : [target.endpoint, plan.action, plan.params])).digest('hex')
      const current = () => {
        const live = bridge.sendTarget(args.destination, true)
        if (signal.aborted || !networkEnabled() || bridge.config.baseUrl !== baseUrl || live?.endpoint !== target.endpoint || live.sessionId !== target.sessionId) throw readError('QQ_DESTINATION_CHANGED')
        try { authorize() } catch { throw readError('OUTBOUND_FORBIDDEN') }
      }
      const listNotices = async () => {
        current()
        const value = await bridge.onebot.call('_get_group_notice', { group_id: peer.id }, { signal, timeoutMs: 10000, maxBytes: 1048576, beforeSend: current })
        current()
        return summarizedNotices(value)
      }
      if (plan.preview) {
        try { await requesterGuard?.({ phase: 'read', action: args.action, target, signal, current }) }
        catch (error) { return rejected(error?.code ?? 'QQ_REQUESTER_UNVERIFIED') }
        const p = plan.params
        return { ...succeeded, draft: { content: p.content, pinned: p.pinned === 1, newMembers: p.type === 20, popup: p.tip_window_type === 0, confirmRequired: p.confirm_required === 1, promptEditCard: p.is_show_edit_card === 1 } }
      }
      if (plan.readOnly) {
        try { await requesterGuard?.({ phase: 'read', action: args.action, target, signal, current }); return { ...succeeded, notices: await listNotices() } }
        catch (error) { return rejected(error?.code ?? 'QQ_ANNOUNCEMENTS_READ_FAILED') }
      }
      return bridge._deliveryFlight(key, async () => {
        const prior = await bridge.store.delivery(key)
        if (prior) {
          if (prior.parts?.[0] !== intent) return rejected('QQ_ACTION_CONFLICT')
          const remembered = prior.state === 'delivered' ? succeeded : prior.state === 'failed' ? rejected(prior.reason) : unknown('QQ_ACTION_ALREADY_ATTEMPTED')
          return prior.replacement ? { ...remembered, replacement: prior.replacement } : remembered
        }
        const onebot = bridge.onebot
        let selfId, recall, previousNotice
        try {
          current()
          await requesterGuard?.({ phase: 'before', action: args.action, target, signal, current })
          current()
          selfId = await loginId(onebot, signal)
          recall = await verifyAction(bridge, target, peer, plan, selfId, signal, ownOnly)
          current()
          if (plan.noticeId) {
            previousNotice = (await listNotices()).find(row => row.noticeId === plan.noticeId)
            if (!previousNotice) return rejected('QQ_ANNOUNCEMENT_NOT_FOUND')
            if (args.action === 'edit_announcement') {
              preserveNotice(plan, previousNotice, args)
              if (previousNotice.images.length) plan.detail += '\n保留原公告图片'
            }
          }
          if (recall?.authorId !== selfId) {
            const service = approval()
            if (!service?.request) return rejected('APPROVAL_UNAVAILABLE')
            const reason = `${requesterLabel ? requesterLabel + '\n' : ''}用 QQ ${selfId} ${labels[args.action]} · ${target.label}（${target.endpoint}）\n${plan.detail}`
            const outcome = await service.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal })
            if (outcome !== 'allowed-once') return rejected('APPROVAL_NOT_GRANTED')
          }
          current()
          if (await loginId(onebot, signal) !== selfId) return rejected('QQ_ACCOUNT_CHANGED')
          current()
          await requesterGuard?.({ phase: 'after', action: args.action, target, signal, current })
          current()
          if (plan.noticeId) {
            const currentNotice = (await listNotices()).find(row => row.noticeId === plan.noticeId)
            if (!currentNotice) return rejected('QQ_ANNOUNCEMENT_NOT_FOUND')
            if (noticeSignature(currentNotice) !== noticeSignature(previousNotice)) return rejected('QQ_ANNOUNCEMENT_CHANGED')
          }
          await bridge.store.recordDelivery(key, { state: 'sending', parts: [intent] })
        } catch (error) { return rejected(error?.code ?? 'QQ_ACTION_PRECHECK_FAILED') }

        let value
        try {
          const answer = await onebot.callRaw(plan.action, plan.params, { signal, beforeSend: current })
          const details = {
            ...(Number.isSafeInteger(answer.retcode) ? { retcode: answer.retcode } : {}),
            ...(answer.wording ? { detail: answer.wording } : {}),
          }
          if (answer.ok) value = succeeded
          else if (answer.code === 'ONEBOT_API_REJECTED') value = rejected(answer.code, details)
          else value = { ...unknown(answer.code), ...details }
        } catch (error) {
          value = error?.deliveryState === 'failed' ? rejected(error.code) : unknown('QQ_ACTION_RESPONSE_UNKNOWN')
        }
        if (args.action === 'edit_announcement') {
          if (value.ok) {
            let deleteStarted = false
            try {
              // Persist the successful first step before attempting the destructive second step.
              await bridge.store.recordDelivery(key, { state: 'sending', parts: [intent], replacement: { published: true, originalRemoved: false } })
              current()
              await requesterGuard?.({ phase: 'before_delete', action: args.action, target, signal, current })
              current()
              const removed = await onebot.callRaw('_del_group_notice', { group_id: peer.id, notice_id: plan.noticeId }, { signal, beforeSend: () => { current(); deleteStarted = true } })
              if (removed.ok) value = { ...succeeded, replacement: { published: true, originalRemoved: true } }
              else if (removed.code === 'ONEBOT_API_REJECTED') value = rejected('QQ_NOTICE_PUBLISHED_DELETE_FAILED', { detail: '新公告已发布，旧公告删除失败。', replacement: { published: true, originalRemoved: false } })
              else value = { ...unknown('QQ_NOTICE_PUBLISHED_DELETE_UNKNOWN'), detail: '新公告已发布，旧公告删除结果未确认，请查看公告列表。', replacement: { published: true, originalRemoved: null } }
            } catch (error) {
              value = { ...unknown('QQ_NOTICE_PUBLISHED_DELETE_UNKNOWN'), detail: deleteStarted ? '新公告已发布，旧公告删除结果未确认，请查看公告列表。' : '新公告已发布，旧公告尚未删除。', replacement: { published: true, originalRemoved: deleteStarted ? null : false } }
            }
          } else value = { ...value, replacement: { published: value.state === 'failed' ? false : null, originalRemoved: false } }
        }
        if (value.ok && recall) {
          try { await bridge.noteRecall({ ...recall, operatorId: selfId, at: Date.now() }, baseUrl) }
          catch { bridge.report({ code: 'QQ_RECALL_RECORD_UNCONFIRMED', bindingId: target.id }) }
        }
        try {
          await bridge.store.recordDelivery(key, { state: value.state, parts: [intent], ...(value.code ? { reason: value.code } : {}), ...(value.replacement ? { replacement: value.replacement } : {}) })
        } catch { return unknown('QQ_ACTION_RECEIPT_UNCONFIRMED') }
        return value
      })
    },
  }
}

/** Verify that this exact tool call belongs to the live native model step. */
function currentToolAnchor(agent, exec, turn) {
  if (!agent?.session || exec.agent !== agent || exec.signal?.aborted) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const events = agent.session.snapshotEvents?.()
  if (!Array.isArray(events)) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data?.turn === turn)
  if (start < 0 || events.slice(start + 1).some(event => event.type === 'turn/end' && event.data?.turn === turn)) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  let step
  for (const event of events.slice(start + 1)) {
    if (event.type === 'step/start' && event.data?.turn === turn) step = event.data.step
    if (event.type === 'step/end' && event.data?.turn === turn && event.data?.step === step) step = undefined
  }
  if (!Number.isSafeInteger(step)) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const root = exec.rootCallId ?? exec.callId
  const assistantIndex = events.findLastIndex(event => event.type === 'assistant/message' && event.surfaceOp === 'append' && event.data?.turn === turn && event.data?.step === step && !event.data?.interrupted && event.data?.message?.role === 'assistant' && event.data.message.source?.kind === 'model' && event.data.message.content?.some(block => block.type === 'tool-call' && block.id === root))
  if (assistantIndex < start) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const event = events[assistantIndex], message = event.data.message, block = message.content.find(part => part.type === 'tool-call' && part.id === root)
  if (!message.source.provider || !message.source.model || !Number.isSafeInteger(event.seq)) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const calls = new Map()
  for (const row of events.slice(assistantIndex + 1)) {
    const d = row.data ?? {}
    if (d.turn !== undefined && d.turn !== turn || d.step !== undefined && d.step !== step) continue
    if (row.type === 'tool/call' && d.callId === root && d.name === block.name) calls.set(root, { name: d.name, root })
    if (row.type === 'tool/ptc-dispatch-start' && calls.get(d.parentCallId)?.root === d.rootCallId && d.rootCallId === root) calls.set(d.subCallId, { name: d.name, root, nested: true })
  }
  const call = calls.get(exec.callId)
  if (!call || call.name !== exec.name || call.root !== root || Boolean(call.nested) !== Boolean(exec.parent)) throw readError('QQ_TOOL_ANCHOR_UNAVAILABLE')
  const { replayState, ...source } = message.source
  return { callId: exec.callId, reply: { version: 1, sessionId: agent.id, seq: event.seq, messageId: message.id, turn, step, time: event.time, source } }
}

function turnSources(agent, turn, binding, beforeSeq = Infinity) {
  const events = agent.session.snapshotEvents?.()
  if (!Array.isArray(events)) return []
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data?.turn === turn)
  if (start < 0) return []
  return events.slice(start + 1).filter(event => event.type === 'user/message' && event.data?.role === 'user' && Number(event.seq) < beforeSeq)
    .map(event => event.data.source).filter(source => source?.kind === 'super-agent-io' && source.transport === 'qq-bridge-001' && source.bindingId === binding.id && source.endpoint === binding.endpoint && source.traceId)
}

/** A QQ-origin call is scoped to its current group and a verified incoming message. */
export function boundGroupModerationTool(bridge, binding, agent, current, { projection, approval = () => undefined }) {
  const base = moderationTool(bridge, { networkEnabled: () => bridge.networkEnabled(), approval })
  const properties = { ...base.parameters.properties }
  delete properties.destination
  properties.requestMessageId = { type: 'string', description: '当前轮发起请求的 QQ 原始消息编号；可用 qq_history 查询。' }
  const readonly = new Set(['list_announcements', 'draft_announcement'])
  return {
    ...base,
    name: 'qq_group_moderate',
    description: '管理当前绑定 QQ 群。用 qq_history 确认本轮请求者的原始消息编号并传入 requestMessageId；查看公告、编辑草稿可由群成员使用，群管理写入需要请求者和桥接账号具有群管理权限，并保留 DSH 确认。公告编辑先发新公告，再删除选中的旧公告。',
    parameters: { ...base.parameters, properties, required: ['action', 'requestMessageId'] },
    async execute(args, exec) {
      let peer, anchor, source, requesterId, requesterExcerpt = ''
      const requestId = typeof args.requestMessageId === 'string' && /^-?\d{1,10}$/.test(args.requestMessageId) && Number(args.requestMessageId) >= -2147483648 && Number(args.requestMessageId) <= 2147483647 ? args.requestMessageId : ''
      if (!requestId) return rejected('QQ_REQUEST_MESSAGE_REQUIRED')
      const facts = () => {
        if (!current() || exec.agent !== agent || exec.signal?.aborted || !bridge.networkEnabled()) throw readError('QQ_GROUP_ACTION_UNAVAILABLE')
        const value = projection?.stateOf(agent.session)
        if (!value?.active || !value.exclusive || value.bindingId !== binding.id || !value.inputs?.length) throw readError('QQ_REQUESTER_UNVERIFIED')
        return value
      }
      try {
        peer = parseEndpoint(binding.endpoint)
        if (peer.kind !== 'group' || bridge.sendTarget(binding.id, true)?.endpoint !== binding.endpoint) throw readError('QQ_GROUP_ACTION_UNAVAILABLE')
        const active = facts()
        anchor = currentToolAnchor(agent, exec, active.turn)
        const sources = turnSources(agent, active.turn, binding, anchor.reply.seq)
        source = sources.find(row => row.externalMessageId === requestId && row.senderId)
        if (!source) {
          const receipt = await bridge.store.ingressReceipt(binding.id, requestId)
          source = receipt?.traceId && sources.find(row => row.traceId === receipt.traceId)
        }
        if (!source) throw readError('QQ_REQUESTER_UNVERIFIED')
        const message = await bridge.onebot.call('get_msg', { message_id: Number(requestId) }, { ...readOptions, signal: exec.signal })
        requesterId = String(message?.sender?.user_id ?? message?.user_id ?? '')
        if (message?.message_type !== 'group' || String(message.group_id ?? '') !== peer.id || String(message.message_id ?? '') !== requestId || !qqNumber.test(requesterId) || source.senderId && source.senderId !== requesterId) throw readError('QQ_REQUESTER_UNVERIFIED')
        requesterExcerpt = boundedText(normalizeSegments(message.message, { maxSegments: 24, maxTextChars: 240 }).text.replace(/[\r\n]+/g, ' '), 240)
      } catch (error) { return rejected(error?.code ?? 'QQ_REQUESTER_UNVERIFIED') }

      const authorize = () => {
        const active = facts(), now = currentToolAnchor(agent, exec, active.turn)
        if (now.reply.seq !== anchor.reply.seq || now.reply.turn !== anchor.reply.turn || now.reply.step !== anchor.reply.step || now.callId !== anchor.callId || !turnSources(agent, active.turn, binding, anchor.reply.seq).some(row => row.traceId === source.traceId)) throw readError('QQ_REQUESTER_UNVERIFIED')
        return now
      }
      const requesterGuard = async ({ action, target, signal, current: guard }) => {
        guard(); authorize()
        if (target.endpoint !== binding.endpoint) throw readError('QQ_GROUP_ACTION_UNAVAILABLE')
        const message = await bridge.onebot.call('get_msg', { message_id: Number(requestId) }, { ...readOptions, signal })
        if (message?.message_type !== 'group' || String(message.group_id ?? '') !== peer.id || String(message.message_id ?? '') !== requestId || String(message.sender?.user_id ?? message.user_id ?? '') !== requesterId) throw readError('QQ_REQUESTER_UNVERIFIED')
        const role = await groupRole(bridge.onebot, peer.id, requesterId, signal)
        if (!readonly.has(action)) {
          if (!['owner', 'admin'].includes(role)) throw readError('QQ_REQUESTER_ADMIN_REQUIRED')
          const selfId = await loginId(bridge.onebot, signal)
          if (!['owner', 'admin'].includes(await groupRole(bridge.onebot, peer.id, selfId, signal))) throw readError('QQ_GROUP_ADMIN_REQUIRED')
        }
        guard(); authorize()
      }
      const tool = moderationTool(bridge, { networkEnabled: () => bridge.networkEnabled(), approval, requesterGuard, requesterLabel: `请求者 QQ ${requesterId}（消息 ${requestId}）${requesterExcerpt ? '\n原始请求：' + requesterExcerpt : ''}` })
      const { requestMessageId, destination, ...forwarded } = args
      return tool.execute({ ...forwarded, destination: binding.id }, exec, authorize)
    },
  }
}

export function boundRecallTool(bridge, binding, authorize) {
  const action = moderationTool(bridge, { networkEnabled: bridge.networkEnabled, ownOnly: true })
  return {
    name: 'qq_recall_own',
    description: '撤回大肥鱼在当前绑定 QQ 聊天中发出的消息。用 qq_history 核对具体消息，传入原始 messageId。',
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'QQ 消息编号，保留正负号。' } },
      required: ['messageId'],
      additionalProperties: false,
    },
    output: action.output,
    execute(args, exec) {
      const scope = authorize(exec)
      if (!scope) return rejected('QQ_RECALL_SCOPE_UNAVAILABLE')
      return action.execute({ destination: binding.id, action: 'recall', messageId: args.messageId }, exec, () => {
        const current = authorize(exec)
        if (!current || current.seq !== scope.seq) throw readError('QQ_RECALL_SCOPE_UNAVAILABLE')
        return { callId: exec.callId, reply: scope }
      })
    },
  }
}
