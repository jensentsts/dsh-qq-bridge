import { parseEndpoint } from './onebot.mjs'

const cacheMs = 15000
const noticeGraceMs = 60000
const options = { timeoutMs: 2500, maxBytes: 1048576 }
const roles = new Set(['member', 'admin', 'owner'])
const noticeTypes = new Set(['group_ban', 'group_increase', 'group_decrease', 'group_admin'])
const localTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})
const number = value => typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN
const qqId = value => typeof value === 'number' && !Number.isSafeInteger(value) ? '' : /^[1-9]\d{0,23}$/.test(String(value ?? '')) ? String(value) : ''
const bool = value => typeof value === 'boolean' ? value : undefined
const denied = result => result?.status === 401 || result?.status === 403 || result?.retcode === 1401 || result?.retcode === 1403
const responseArrived = result => result.ok || result.code === 'ONEBOT_API_REJECTED' || Number.isInteger(result.status)
const muteTimestamp = value => {
  const seconds = number(value)
  if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8640000000000) return seconds * 1000
}
const allMuted = value => {
  if (typeof value === 'boolean') return value
  const flag = number(value)
  if (flag === -1 || flag === 1) return true
  if (flag === 0) return false
}
export const isQqStatusEvent = event => event?.post_type === 'meta_event' && event.meta_event_type === 'heartbeat' ||
  event?.post_type === 'notice' && noticeTypes.has(event.notice_type)

/** Ephemeral, account-scoped observations. An unverified read never denies a send. */
export class QqStatus {
  constructor({ onebot, origin, networkEnabled, signal, groupAllowed, now = Date.now }) {
    Object.assign(this, { onebot, origin, networkEnabled, signal, groupAllowed, now })
  }
  _scope() {
    const origin = this.networkEnabled() ? this.origin() : undefined
    if (!origin) { this.scope = undefined; return }
    if (this.scope?.origin !== origin) this.scope = { origin, account: {}, groups: new Map() }
    return this.scope
  }
  _group(scope, endpoint) {
    if (!scope.groups.has(endpoint)) scope.groups.set(endpoint, { notices: {} })
    return scope.groups.get(endpoint)
  }
  async _request(action, params) {
    try { return await this.onebot.callRaw(action, params, { ...options, signal: this.signal() }) }
    catch { return { ok: false } }
  }
  async _cached(entry, refresh, load) {
    if (entry.flight) return entry.flight
    const startedAt = this.now()
    if (!refresh && startedAt < (entry.expires ?? 0)) return entry.value
    entry.flight = load().then(value => {
      entry.value = value
      entry.startedAt = startedAt
      entry.expires = this.now() + (value.reachable === false ? 3000 : cacheMs)
      return value
    }).finally(() => { entry.flight = undefined })
    return entry.flight
  }
  async _readAccount(scope) {
    const [status, login] = await Promise.all([this._request('get_status', {}), this._request('get_login_info', {})])
    const id = login.ok ? qqId(login.data?.user_id) : ''
    if (id && scope.selfId && id !== scope.selfId) {
      scope.groups.clear()
      scope.heartbeat = undefined
    }
    if (id) scope.selfId = id
    return {
      ...(id ? { id, nickname: typeof login.data?.nickname === 'string' ? login.data.nickname.trim().slice(0, 80) : '' } : {}),
      online: status.ok ? bool(status.data?.online) : undefined,
      healthy: status.ok ? bool(status.data?.good) : undefined,
      reachable: responseArrived(status) || responseArrived(login),
      unauthorized: !status.ok && !login.ok && (denied(status) || denied(login)),
    }
  }
  async _readGroup(groupId, selfId, online) {
    const [info, member] = await Promise.all([
      this._request('get_group_info', { group_id: groupId, no_cache: true }),
      this._request('get_group_member_info', { group_id: groupId, user_id: selfId, no_cache: true }),
    ])
    const row = member.data
    // SnowLuma can return a placeholder with correct IDs for an absent member.
    const own = member.ok && qqId(row?.group_id) === groupId && qqId(row?.user_id) === selfId &&
      (number(row?.join_time) > 0 || typeof row?.nickname === 'string' && row.nickname.trim()) ? row : undefined
    let group = info.ok && qqId(info.data?.group_id) === groupId && number(info.data?.member_count) > 0 ? info.data : undefined
    let joined = own ? true : undefined
    if (!own && online === true) {
      const roster = await this._request('get_group_list', { no_cache: true })
      if (roster.ok && Array.isArray(roster.data) && roster.data.every(item => qqId(item?.group_id))) {
        const joinedGroup = roster.data.find(item => qqId(item.group_id) === groupId)
        joined = !!joinedGroup
        group ??= joinedGroup
      }
    }
    return { joined, role: roles.has(own?.role) ? own.role : undefined, mutedUntil: muteTimestamp(own?.shut_up_timestamp),
      wholeMuted: allMuted(group?.group_all_shut) }
  }
  _accountView(scope) {
    const cached = scope.account.value ?? {}
    const live = scope.heartbeat
    if (live && live.observedAt >= (scope.account.startedAt ?? 0) && this.now() - live.observedAt <= noticeGraceMs) {
      return { ...cached, ...(live.online === undefined ? {} : { online: live.online }), ...(live.healthy === undefined ? {} : { healthy: live.healthy }) }
    }
    return cached
  }
  snapshot(endpoint) {
    const scope = this._scope()
    if (!scope) return { endpoint, account: {}, canSend: false, reason: 'NETWORK_ACCESS_DISABLED' }
    const account = this._accountView(scope)
    const entry = endpoint?.startsWith('group:') && this.groupAllowed(endpoint) ? scope.groups.get(endpoint) : undefined
    const now = this.now()
    const facts = { ...entry?.value }
    if (entry) for (const [key, notice] of Object.entries(entry.notices)) {
      if (facts[key] === undefined || notice.observedAt >= (entry.startedAt ?? 0) || now - notice.observedAt <= noticeGraceMs) facts[key] = notice.value
    }
    const mutedUntil = facts.mutedUntil > now ? facts.mutedUntil : undefined
    const chat = endpoint?.startsWith('group:') ? { joined: facts.joined, role: facts.role, wholeMuted: facts.wholeMuted, mutedUntil } : undefined
    const reason = account.unauthorized ? 'QQ_ONEBOT_AUTH_FAILED'
      : account.online === false ? 'QQ_ACCOUNT_OFFLINE'
      : chat?.joined === false ? 'QQ_NOT_IN_GROUP'
      : mutedUntil ? 'QQ_GROUP_MEMBER_MUTED'
      : chat?.wholeMuted && chat.role === 'member' ? 'QQ_GROUP_ALL_MUTED'
      : undefined
    const groupVerified = !chat || chat.joined === true && facts.mutedUntil !== undefined &&
      (chat.wholeMuted === false || chat.role === 'admin' || chat.role === 'owner')
    return { endpoint, account, chat, reason, canSend: reason ? false : account.id && account.online === true && groupVerified ? true : null }
  }
  async read(endpoint, { signal, refresh = false } = {}) {
    signal?.throwIfAborted()
    const scope = this._scope()
    if (!scope) return this.snapshot(endpoint)
    const account = await this._cached(scope.account, refresh, () => this._readAccount(scope))
    signal?.throwIfAborted()
    if (scope !== this._scope()) return this.snapshot(endpoint)
    if (account.id && this._accountView(scope).online !== false && endpoint?.startsWith('group:') && this.groupAllowed(endpoint)) {
      const { id } = parseEndpoint(endpoint), group = this._group(scope, endpoint)
      await this._cached(group, refresh, () => this._readGroup(id, account.id, account.online))
    }
    signal?.throwIfAborted()
    return this.snapshot(endpoint)
  }
  observe(event, verifiedId) {
    if (!isQqStatusEvent(event)) return false
    const scope = this._scope(), selfId = qqId(verifiedId)
    if (!scope || !selfId || qqId(event.self_id) !== selfId || scope.selfId && scope.selfId !== selfId) return false
    const now = this.now()
    if (event.post_type === 'meta_event') {
      const online = bool(event.status?.online), healthy = bool(event.status?.good)
      if (online !== undefined || healthy !== undefined) scope.heartbeat = { online, healthy, observedAt: now }
      return true
    }
    const groupId = qqId(event.group_id), endpoint = 'group:' + groupId
    const affected = qqId(event.user_id), whole = event.user_id === 0 || event.user_id === '0'
    if (!groupId || !this.groupAllowed(endpoint) || affected !== selfId && !(whole && event.notice_type === 'group_ban')) return false
    const eventAt = muteTimestamp(event.time) || now
    if (eventAt > now + 60000) return false
    const group = this._group(scope, endpoint)
    const put = (key, value) => {
      if (eventAt >= (group.notices[key]?.eventAt ?? 0)) group.notices[key] = { value, eventAt, observedAt: now }
    }
    switch (event.notice_type) {
      case 'group_ban': {
        const duration = number(event.duration), lift = event.sub_type === 'lift_ban'
        if (!lift && (event.sub_type !== 'ban' || !Number.isSafeInteger(duration) || duration <= 0 || duration > 2147483647)) return false
        // SnowLuma also emits user_id=0 when an individual target UID has no mapping.
        if (whole) {
          const pending = group.flight
          group.expires = 0
          void Promise.resolve(pending).then(() => {
            if (scope !== this._scope() || !this.groupAllowed(endpoint)) return
            group.expires = 0
            return this.read(endpoint)
          }).catch(() => {})
        } else put('mutedUntil', lift ? 0 : eventAt + duration * 1000)
        break
      }
      case 'group_decrease': put('joined', false); break
      case 'group_increase': put('joined', true); put('mutedUntil', 0); break
      case 'group_admin': {
        if (!['set', 'unset'].includes(event.sub_type)) return false
        put('role', event.sub_type === 'set' ? 'admin' : 'member')
        break
      }
    }
    group.expires = 0
    return true
  }
  streamClosed() {
    const scope = this._scope()
    if (!scope) return
    scope.heartbeat = undefined
    scope.account.expires = 0
    scope.groups.clear()
  }
}

export function qqStatusText(status) {
  switch (status.reason) {
    case 'QQ_GROUP_MEMBER_MUTED': return `当前 QQ 账号在本群被禁言，预计 ${localTime.format(status.chat.mutedUntil)}（北京时间）解除。`
    case 'QQ_GROUP_ALL_MUTED': return '本群已开启全员禁言，当前 QQ 账号的群内发言已暂停。'
    case 'QQ_NOT_IN_GROUP': return '当前 QQ 账号未加入该群。'
    case 'QQ_ACCOUNT_OFFLINE': return '当前 QQ 账号已离线。'
    case 'QQ_ONEBOT_AUTH_FAILED': return 'OneBot 连接认证失败。'
    case 'NETWORK_ACCESS_DISABLED': return 'QQ 桥接的网络访问已关闭。'
  }
  if (status.chat?.wholeMuted) return '本群已开启全员禁言。' + (status.chat.role ? `当前账号角色为 ${{ owner: '群主', admin: '管理员', member: '成员' }[status.chat.role]}。` : '当前账号的群角色待确认。')
  if (status.account.reachable === false) return '当前查询未能连通 OneBot。'
  if (status.account.healthy === false) return 'OneBot 报告运行异常。'
  if (status.canSend === true) return status.chat ? '当前 QQ 账号在线，群内发言状态正常。' : '当前 QQ 账号在线。'
  return '当前 QQ 状态待确认。'
}

export function qqStatusTool(bridge, binding, allowed) {
  return {
    name: binding ? 'qq_chat_status' : 'qq_status',
    description: binding ? '查询当前 QQ 会话中本账号的在线、群成员和禁言状态。' : '查询本 QQ 账号的在线状态。传入 io_destinations 返回的 destination，可查询该 QQ 群的成员和禁言状态。',
    parameters: { type: 'object', properties: binding ? {} : { destination: { type: 'string' } }, additionalProperties: false },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec, authorize) {
      const current = () => binding ? allowed(exec) : authorize()
      if (!current()) return { text: 'QQ 会话绑定已变化。' }
      const target = binding ?? (args?.destination ? bridge.statusTarget(args.destination) : undefined)
      if (args?.destination && !target) return { text: '请从 io_destinations 选择已配置的 QQ 聊天。' }
      const origin = bridge.config.baseUrl
      const status = await bridge.qqStatus.read(target?.endpoint, { signal: exec.signal, refresh: true })
      if (!current() || bridge.config.baseUrl !== origin || target && bridge.statusTarget(target.id)?.endpoint !== target.endpoint) return { text: 'QQ 会话绑定已变化。' }
      const dshSendEnabled = target ? !!bridge.sendTarget(target.id, true) : bridge.config.sendEnabled
      const text = qqStatusText(status) + (dshSendEnabled ? '' : ' DSH 的 QQ 外发开关当前关闭。')
      return { text: JSON.stringify({ text, ...status, dshSendEnabled }) }
    },
  }
}
