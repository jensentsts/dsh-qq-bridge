/** Explicit user-facing schedule tools over the official Host schedule service. No task is created on load/save/import. */
const clip = (value, max) => String(value ?? '').slice(0, max)
const integer = (value, min, max) => { const n = Math.round(Number(value)); return Number.isFinite(n) && n >= min && n <= max ? n : undefined }
const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}
const result = (ok, text) => ({ ok, text: clip(text, 12000) })
const taskText = task => JSON.stringify({
  id: task.id, title: task.title, prompt: task.prompt, scheduledAt: task.scheduledAt, status: task.status,
  bindingId: task.bindingId, sessionId: task.target?.sessionId, updatedAt: task.updatedAt, lastDelivery: task.lastDelivery,
}, null, 2)
export class ScheduleTools {
  constructor({ schedule, binding, bindings, report = () => {} }) {
    this.schedule = schedule; this.binding = binding; this.bindings = bindings; this.report = report
  }
  snapshot() { return { available: !!this._service(), autoCreate: false, tools: ['qq_schedule_create', 'qq_schedule_list', 'qq_schedule_view', 'qq_schedule_edit'] } }
  _service() { const service = this.schedule(); return service && typeof service.create === 'function' && typeof service.list === 'function' ? service : undefined }
  _related(task) { return task?.target?.kind === 'session' && this.bindings().some(binding => binding.sessionId === task.target.sessionId) }
  _bindingOf(task) { return this.bindings().find(binding => binding.sessionId === task?.target?.sessionId) }
  _view(task) { return { ...task, bindingId: this._bindingOf(task)?.id } }
  _timing(args) {
    const zone = clip(args.time_zone, 64).trim()
    const time = value => { const text = clip(value, 16).trim(); if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) throw new Error('时间要用 HH:mm 或 HH:mm:ss'); const parts = text.split(':'); return String(Number(parts[0])).padStart(2, '0') + ':' + parts[1] + (parts[2] ? ':' + parts[2] : ':00') }
    if (args.kind === 'after') { const value = integer(args.after_seconds, 1, 31536000); if (!value) throw new Error('after_seconds 必须是正整数'); return { kind: 'after', after_seconds: value } }
    if (args.kind === 'at') {
      if (typeof args.at === 'string' && args.at.trim()) return { kind: 'at', at: args.at.trim() }
      if (!args.at || typeof args.at !== 'object') throw new Error('at 需要 RFC3339 字符串或 {date,time,time_zone}')
      if (!args.at.time_zone) throw new Error('at 需要明确 time_zone')
      return { kind: 'at', at: { date: clip(args.at.date, 10), time: time(args.at.time), time_zone: clip(args.at.time_zone, 64) } }
    }
    if (args.kind === 'every') { const value = integer(args.every_seconds, 60, 31536000); if (!value) throw new Error('every_seconds 至少 60'); return { kind: 'every', every_seconds: value } }
    if (args.kind === 'daily') { if (!zone) throw new Error('daily 需要明确 time_zone'); return { kind: 'daily', daily: { time: time(args.time), time_zone: zone } } }
    if (args.kind === 'weekly') { if (!zone) throw new Error('weekly 需要明确 time_zone'); const weekdays = Array.isArray(args.weekdays) ? args.weekdays.map(Number) : []; if (!weekdays.length || weekdays.some(value => !Number.isInteger(value) || value < 1 || value > 7) || new Set(weekdays).size !== weekdays.length) throw new Error('weekdays 是 1-7 的无重复数组'); return { kind: 'weekly', weekly: { time: time(args.time), time_zone: zone, weekdays: [...new Set(weekdays)].sort((a, b) => a - b) } } }
    if (args.kind === 'cron') { if (!zone) throw new Error('cron 需要明确 time_zone'); if (!String(args.expression ?? '').trim()) throw new Error('cron 需要 expression'); return { kind: 'cron', cron: { expression: clip(args.expression, 256).trim(), time_zone: zone } } }
    if (args.kind === 'rrule') { if (!String(args.rrule ?? '').trim()) throw new Error('rrule 需要 DTSTART/RRULE'); return { kind: 'rrule', rrule: clip(args.rrule, 4096).trim() } }
    throw new Error('kind 只能是 after/at/every/daily/weekly/cron/rrule')
  }
  _target(args, fallback) {
    const binding = args.bindingId ? this.bindings().find(value => value.id === args.bindingId) : fallback
    if (!binding || !binding.enabled) throw new Error('目标绑定不存在或未启用')
    return { binding, target: { kind: 'session', sessionId: binding.sessionId } }
  }
  _definitions(binding, agent) {
    const service = () => this._service(), sameAgent = exec => !exec?.agent || exec.agent === agent, aborted = exec => exec?.signal?.aborted === true
    const guard = exec => {
      const current = this.binding(binding.id)
      return !!service() && current?.enabled === true && current.sessionId === binding.sessionId && current.sessionId === agent.session.id && sameAgent(exec) && !aborted(exec)
    }
    const ownTask = task => task?.target?.kind === 'session' && task.target.sessionId === binding.sessionId
    const targetFor = args => {
      if (args.bindingId !== undefined && args.bindingId !== binding.id) throw new Error('定时任务请选择当前 QQ 绑定。')
      return this._target(args, binding)
    }
    return [
      {
        name: 'qq_schedule_create', description: '在用户明确要求时创建一个 Host 定时任务，到点由官方 schedule 服务把 prompt 投递到绑定会话。创建时必须是未来时间；本工具不会在加载/保存/导入时自动创建任务。', parameters: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, kind: { type: 'string', enum: ['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'] }, bindingId: { type: 'string' }, after_seconds: { type: 'integer' }, at: { type: 'object', properties: { date: { type: 'string' }, time: { type: 'string' }, time_zone: { type: 'string' } }, additionalProperties: false }, every_seconds: { type: 'integer' }, time: { type: 'string' }, time_zone: { type: 'string' }, weekdays: { type: 'array', items: { type: 'integer' } }, expression: { type: 'string' }, rrule: { type: 'string' } }, required: ['title', 'prompt', 'kind'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, 'schedule 服务不可用或调用者不匹配。')
          try {
            const title = clip(args.title, 120).trim(), prompt = clip(args.prompt, 8000).trim()
            if (!title || !prompt) return result(false, 'title 和 prompt 不能为空。')
            const { target } = targetFor(args)
            const task = await service().create({ title, prompt, timing: this._timing(args), target }, agent.session.id, exec?.signal)
            return result(true, '已创建定时任务。\n' + taskText(this._view(task)))
          } catch (error) { return result(false, '创建失败：' + clip(error?.message || error, 300)) }
        },
      },
      {
        name: 'qq_schedule_list', description: '查看与已绑定 QQ 会话相关的 Host 定时任务；不激活会话、不创建任务。', parameters: { type: 'object', properties: { active: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500 }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, 'schedule 服务不可用或调用者不匹配。')
          try {
            const page = await service().list({ ...(typeof args.active === 'boolean' ? { active: args.active } : {}), limit: integer(args.limit, 1, 500) ?? 100, offset: integer(args.offset, 0, 100000) ?? 0 })
            const items = (page.items ?? []).filter(ownTask).map(task => this._view(task))
            if (!items.length) return result(true, '没有与已绑定 QQ 会话相关的定时任务。')
            return result(true, '相关定时任务 ' + items.length + ' / 本页 ' + (page.shown ?? items.length) + '：\n' + items.map(taskText).join('\n\n'))
          } catch (error) { return result(false, '读取失败：' + clip(error?.message || error, 300)) }
        },
      },
      {
        name: 'qq_schedule_view', description: '按 id 查看一条与已绑定 QQ 会话相关的 Host 定时任务。只读。', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, 'schedule 服务不可用或调用者不匹配。')
          try {
            const task = await service().view({ id: clip(args.id, 128) })
            if (!task || task.code === 'schedule_not_found') return result(false, '没有这条定时任务。')
            if (!ownTask(task)) return result(false, '这条任务属于其他会话。')
            return result(true, taskText(this._view(task)))
          } catch (error) { return result(false, '读取失败：' + clip(error?.message || error, 300)) }
        },
      },
      {
        name: 'qq_schedule_edit', description: '在用户明确要求时调整或删除一条与已绑定 QQ 会话相关的 Host 定时任务。更新与删除都通过官方 schedule 服务。', parameters: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['update', 'delete'] }, title: { type: 'string' }, prompt: { type: 'string' }, kind: { type: 'string', enum: ['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule'] }, bindingId: { type: 'string' }, after_seconds: { type: 'integer' }, at: { type: 'object', properties: { date: { type: 'string' }, time: { type: 'string' }, time_zone: { type: 'string' } }, additionalProperties: false }, every_seconds: { type: 'integer' }, time: { type: 'string' }, time_zone: { type: 'string' }, weekdays: { type: 'array', items: { type: 'integer' } }, expression: { type: 'string' }, rrule: { type: 'string' }, active: { type: 'boolean' }, expectedUpdatedAt: { type: 'string' } }, required: ['id', 'action'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, 'schedule 服务不可用或调用者不匹配。')
          try {
            const id = clip(args.id, 128), existing = await service().view({ id })
            if (!existing || existing.code === 'schedule_not_found') return result(false, '没有这条定时任务。')
            if (!ownTask(existing)) return result(false, '这条任务属于其他会话。')
            const expected = typeof args.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: args.expectedUpdatedAt } : {}
            if (args.action === 'delete') {
              if (['title', 'prompt', 'kind', 'bindingId', 'active', 'rrule', 'expression', 'time', 'time_zone', 'weekdays', 'at', 'after_seconds', 'every_seconds'].some(key => args[key] !== undefined)) return result(false, '删除只接受 id、action 和 expectedUpdatedAt。')
              const value = await service().edit({ id, action: 'delete', ...expected }, agent.session.id, exec?.signal)
              return value?.deleted === true ? result(true, '已删除定时任务 ' + id + '。') : result(false, '删除没有完成：' + clip(JSON.stringify(value), 300))
            }
            const patch = {}
            if (args.title !== undefined) { const value = clip(args.title, 120).trim(); if (!value) return result(false, 'title 不能为空。'); patch.title = value }
            if (args.prompt !== undefined) { const value = clip(args.prompt, 8000).trim(); if (!value) return result(false, 'prompt 不能为空。'); patch.prompt = value }
            if (args.kind !== undefined) patch.timing = this._timing(args)
            if (args.bindingId !== undefined) patch.target = targetFor(args).target
            if (args.active !== undefined) patch.active = args.active === true
            if (!Object.keys(patch).length) return result(false, '更新至少需要 title/prompt/kind/bindingId/active 之一。')
            const value = await service().edit({ id, action: 'update', patch, ...expected }, agent.session.id, exec?.signal)
            if (!value || value.code) return result(false, '更新没有完成：' + clip(JSON.stringify(value), 300))
            return result(true, '已更新定时任务。\n' + taskText(this._view(value)))
          } catch (error) { return result(false, '调整失败：' + clip(error?.message || error, 300)) }
        },
      },
    ]
  }
  register(binding, agent, tools) {
    if (!this._service()) return { state: 'unavailable', dispose() {} }
    if (!tools || typeof tools.register !== 'function') return { state: 'unavailable', dispose() {} }
    const off = []
    try { for (const definition of this._definitions(binding, agent)) { const dispose = tools.register(definition); if (typeof dispose === 'function') off.push(dispose) } }
    catch (error) { this.report({ code: 'SCHEDULE_TOOL_REGISTER_FAILED', bindingId: binding.id }); for (const dispose of off.splice(0)) { try { dispose() } catch {} } return { state: 'unavailable', dispose() {} } }
    return { state: off.length ? 'applied' : 'unavailable', dispose() { for (const dispose of off.splice(0).reverse()) { try { dispose() } catch {} } } }
  }
}
