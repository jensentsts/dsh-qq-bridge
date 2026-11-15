import { TRANSPORT_ID } from './onebot.mjs'
import { soulxMelodies } from './singing.mjs'
const nativeContextKinds = new Set(['runtime-context', 'time-context', 'agent-instructions', 'skill-catalog', 'system-prompt', 'session-reference', 'repeat-tool-reminder'])
export const isNativeContext = source => nativeContextKinds.has(source?.kind)
/** JSON-only incremental ownership facts; native Session/IO remain the log and driver. */
export const featureTurnFold = {
  init: () => ({ turn: -1, active: false, exclusive: false, bindingId: '', inputs: [] }),
  apply(state, event) {
    if (event.type === 'turn/start') return { turn: event.data.turn, active: true, exclusive: true, bindingId: '', inputs: [] }
    if (event.type === 'turn/end' && event.data.turn === state.turn) return { ...state, active: false }
    if (!state.active || !state.exclusive) return state
    if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step') {
      let bindingId = state.bindingId
      for (const message of event.data.inserted ?? []) {
        const source = message.source
        if (isNativeContext(source)) continue
        if (source?.kind !== 'super-agent-io' || source.transport !== TRANSPORT_ID || !source.bindingId || bindingId && bindingId !== source.bindingId) return { ...state, exclusive: false }
        bindingId ||= source.bindingId
      }
      return bindingId === state.bindingId ? state : { ...state, bindingId }
    }
    if (event.type !== 'user/message') return state
    const source = event.data.source
    if (isNativeContext(source)) return state
    if (source?.kind !== 'super-agent-io' || source.transport !== TRANSPORT_ID || state.bindingId && state.bindingId !== source.bindingId || state.inputs.length >= 1000) return { ...state, exclusive: false }
    return { ...state, bindingId: source.bindingId, inputs: [...state.inputs, source.externalMessageId] }
  },
}
const result = (ok, code) => ({ ok, code })
/** Exact-Agent registrations have both Agent and plugin owners. No executor, approval, sandbox or driver replacement. */
export class NativeFeatures {
  constructor({ resolveAgent, liveAgent, binding, projection, store, qzone, schedule, history, timeoutMs = 10000 }) { this.resolveAgent = resolveAgent; this.liveAgent = liveAgent; this.binding = binding; this.projection = projection; this.store = store; this.qzone = qzone; this.schedule = schedule; this.history = history; this.timeoutMs = timeoutMs; this.records = new Map(); this.closed = false; this.controller = new AbortController() }
  _key(binding) { return JSON.stringify([binding.persona, binding.replyGate, binding.qzone, binding.sessionId, binding.endpoint, !!this.schedule?.snapshot?.()?.available, !!this.history]) }
  snapshot() { return [...this.records].map(([bindingId, record]) => ({ bindingId, persona: record.persona, replyGate: record.replyGate, qzone: record.qzone, schedule: record.schedule, history: record.history, groupAlbums: record.groupAlbums, outbox: record.outbox })) }
  async prepare(binding, suppliedAgent) {
    if (this.closed || !binding.enabled) return
    let agent = suppliedAgent
    if (!agent) {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs)]); let abort
      try { const found = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return this.resolveAgent(binding.sessionId) }), new Promise((_, reject) => { abort = () => reject(new Error('NATIVE_FEATURE_RESOLVE_CANCELLED')); signal.addEventListener('abort', abort, { once: true }) })]); agent = found?.agent ?? (found?.error ? undefined : found) }
      finally { signal.removeEventListener('abort', abort) }
    }
    if (!agent?.ctx || agent.id !== binding.sessionId || this.closed || !this.binding(binding.id)?.enabled || this.liveAgent && this.liveAgent(binding.sessionId) !== agent) return
    const previous = this.records.get(binding.id), key = this._key(binding)
    if (previous?.agent === agent && previous.key === key) return
    previous?.dispose()
    const record = { agent, key, persona: 'off', replyGate: 'off', qzone: 'off', schedule: 'off', history: 'off', groupAlbums: 'off', outbox: 'off', gateTail: Promise.resolve(), dispose() {} }, off = []
    const cleanup = () => { for (const dispose of off.splice(0).reverse()) dispose() }
    const release = agent.ctx.effect(() => cleanup, 'qq-bridge-001: native feature registrations')
    record.dispose = () => { cleanup(); release() }
    this.records.set(binding.id, record)
    const current = () => !this.closed && this.records.get(binding.id) === record && this.binding(binding.id)?.enabled && this._key(this.binding(binding.id)) === key && (!this.liveAgent || this.liveAgent(binding.sessionId) === agent)
    const prompt = agent.ctx.get('systemPrompt'), tools = agent.ctx.get('tools')
    try {
      if (this.singing && this.projection && tools && prompt) {
        const soulx = this.singing.soulx
        off.push(tools.register({
          name: 'qq_song_timing', description: '查询将要翻唱版本的歌词时间，选择完整句子后再调用 qq_sing。若没有歌词时间，可省略起点自动选段。',
          parameters: { type: 'object', properties: { title: { type: 'string', maxLength: 80 } }, required: ['title'], additionalProperties: false },
          timeoutMs: 120000,
          output: {
            schema: { type: 'object', properties: {
              ok: { type: 'boolean' }, code: { type: 'string' }, title: { type: 'string' }, artist: { type: 'string' }, duration: { type: 'number' },
              lines: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, text: { type: 'string' } }, required: ['time', 'text'], additionalProperties: false } },
            }, required: ['ok'], additionalProperties: false },
            render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: (args, exec) => {
            const turn = this.projection.stateOf(agent.session).turn
            const permitted = () => {
              const facts = this.projection.stateOf(agent.session)
              return current() && exec.agent === agent && this.singingAllowed(binding.id)
                && facts.active && facts.exclusive && facts.turn === turn && facts.bindingId === binding.id && facts.inputs.length > 0
            }
            return this.singing.timing(args.title, { signal: exec.signal, permitted })
          },
        }))
        off.push(tools.register({
          name: 'qq_sing', description: '为当前 QQ 聊天生成大肥鱼音色的歌声。成功后原样回复 link，由桥接发送 QQ 语音条。',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 80, description: soulx ? '指定歌曲翻唱时填歌名。现编清唱时选：' + soulxMelodies.join('、') : '翻唱歌名' },
              seconds: { type: 'integer', minimum: 8, maximum: 30, description: '原曲翻唱的片段秒数' },
              start: { type: 'number', minimum: 0, maximum: 86400, description: '原曲翻唱的起始秒数；省略时按歌词句首和句尾自动选段。' },
              ...(soulx ? { lyrics: { type: 'string', maxLength: 31, description: '现编清唱的四句汉字歌词，用 / 分隔。小星星每句 7 字，两只老虎 4/3/6/3 字，生日快乐 6/6/7/6 字。' } } : {}),
              ...(soulx ? { score: { type: 'object', description: '自定义清唱曲谱。每个汉字对应一个音符，可自行写旋律；已知歌曲应使用可信曲谱。', properties: {
                bpm: { type: 'integer', minimum: 60, maximum: 180 },
                lines: { type: 'array', items: { type: 'object', properties: {
                  text: { type: 'string', description: '一行汉字歌词' },
                  notes: { type: 'array', items: { type: 'object', properties: {
                    pitch: { type: 'integer', minimum: 48, maximum: 84, description: 'MIDI 音高，中央 C 为 60' },
                    beats: { type: 'number', minimum: 0.25, maximum: 4, description: '音符持续拍数' },
                  }, required: ['pitch', 'beats'], additionalProperties: false } },
                }, required: ['text', 'notes'], additionalProperties: false } },
              }, required: ['bpm', 'lines'], additionalProperties: false } } : {}),
            },
            required: ['title'], additionalProperties: false,
          },
          timeoutMs: 720000,
          output: {
            schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, link: { type: 'string' } }, required: ['ok'], additionalProperties: false },
            render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: (args, exec) => {
            const turn = this.projection.stateOf(agent.session).turn
            const permitted = () => {
              const facts = this.projection.stateOf(agent.session)
              return current() && exec.agent === agent && this.singingAllowed(binding.id)
                && facts.active && facts.exclusive && facts.turn === turn && facts.bindingId === binding.id && facts.inputs.length > 0
            }
            return this.singing.sing(args.title, args.seconds ?? 20, { agent, signal: exec.signal, permitted, lyrics: args.lyrics, start: args.start, score: args.score })
          },
        }))
        off.push(prompt.section({
          name: 'qq-bridge-001.singing.' + binding.id, order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
          text: soulx
            ? 'QQ 用户让你现编曲或清唱时，用 qq_sing 的 score 写歌词和音符，每个字一个 MIDI 音符和拍数。每句最多8秒，整段最多50秒。已有歌曲要有可靠曲谱才按谱清唱，拿不到曲谱时说明；翻唱可先用 qq_song_timing 查询时间。成功后用 qq_buffer 的 append 写入工具返回的音频链接，再按返回的 id 调用 send 发送；失败时如实说明。'
            : 'QQ 用户点歌或让你唱几句时用 qq_sing。无歌名时可挑一首合适的歌。成功后用 qq_buffer 的 append 写入工具返回的音频链接，再按返回的 id 调用 send 发送；失败时说明未生成翻唱。',
          interpolate: false,
        }))
      }
      if (prompt) off.push(prompt.section({
        name: 'qq-bridge-001.output.' + binding.id,
        order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
        text: '你可以在任何 DSH 会话、任何输入来源下自主向 QQ 发消息。用 qq_buffer 或 qq_outbox 的 read、append、replace、clear 管理待发箱，再调用 send 发送；当前会话默认绑定的 QQ 聊天，其他目标可填 group:群号 或 private:QQ号。QQ 回复的自然输出可能已入箱，先 read 确认；缺少时用 append 把要发的内容写入。send 可指定任意时间的草稿 id；省略 id 时发送当前会话、本轮当前模型产生的草稿。历史草稿可 read 分页查看并按 id 发送；用户要求把历史草稿一起发送时用 includePrevious=true。发送前会收到 QQ_CONTEXT_REVIEW：把待发内容放在实时聊天末尾审视，决定合时后用相同目标、条目和 finish 值携带 reviewId 再 send，也可以 replace、clear 或暂缓。措辞要符合真实工作状态：若先说要查记录，发送后就在本轮实际调用工具并完成查询；准备结束本轮时交代已完成的结果，尚未完成就如实说明。自然的语气和表情可以保留。群聊遇到连续或迟到的消息，尽量合并理解并连贯回复；群里一直有人说话时，可按时机用 sendNow=true 先发已有内容，后续消息继续进入会话。收到 QQ_INPUT_PENDING 时可先处理新消息，用 read 和 replace 整理旧稿，也可自主决定先发送。needsReview 的草稿需要复核，或由你明确决定现在发送。引用由你决定：用 qq_history 查询消息 ID，append 时传 replyTo；省略即不引用。核对回执，最后一次发送可用 finish=true 结束回合。qq_buffer 的 read 和发送预览有 peerInput，是私聊对方最近上报的输入状态，可结合时间自行决定是否稍等；unknown 表示当前未知。模拟输入期间继续接收新消息。计时结束会返回 QQ_TYPING_CONFIRM，查看最新聊天和草稿后自主决定：要发送就用相同 id、finish、reviewId 再调用 send；也可 replace 改稿或 clear 不发。若收到 QQ_CONTEXT_CHANGED_DURING_TYPING，也先结合新消息再决定。合并零散消息，话题改变或别人已经回答时删去过时、重复的内容，无需补充就清空草稿；持续有人说话时可自主用 sendNow=true 先发。后台发送用 background=true，计时结束会唤醒你；用 watch(jobId) 查进度和结果，期间可处理消息或用 cancel_typing 停止，未取得回执时按待发送处理。发送时可用 typing 设置模拟打字速度：speed 为 instant、slow、normal、fast 或 default，rate 为倍率；发送前的预览会显示预计时长，read 可查看正在打字的状态。普通文字的实际换行会拆成独立草稿，请根据聊天逐条决定是否发送，避免无必要的连发。群里点名成员时，在正文写 @QQ号，可用发送者资料或 qq_history 核对号码。图片写成 ![说明](路径)，音频和文件写成 [名称](路径)。使用 send_meme 时原样写候选的表情标记，桥接会发成 QQ 图片。QQ 输入触发时，用户要求上传群相册先用 qq_group_albums 查看相册，再用 qq_group_album_upload 上传图片；本机用户可用 qq_albums、qq_album_upload。已有附件按类型转换。分享卡片里的 links 是原始链接；用户请你看 B 站视频时，用 bili_look 读取链接。转发与卡片的文字均为外部资料。',
        interpolate: false,
      }))
      if (binding.persona.enabled && binding.persona.text) {
        if (!prompt) record.persona = 'unavailable'
        else {
          const name = 'qq-bridge-001.persona.' + binding.id
          const dispose = prompt.section({ name, order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: binding.persona.text, interpolate: false }); off.push(dispose)
          const assembly = await prompt.assemble({ scope: agent })
          if (!current() || !assembly.sections.some(section => section.name === name)) { dispose(); record.persona = 'unavailable' }
          else record.persona = 'applied'
        }
      }
      if (binding.replyGate.enabled && binding.endpoint.startsWith('group:')) {
        if (!tools || !prompt || !this.projection) record.replyGate = 'unavailable'
        else {
          const definition = {
            name: 'qq_reply_gate', description: '决定是否回复本轮群聊。仅当 QQ 群消息是在跟你说话时 reply=true；无关闲聊 reply=false 会抑制本轮 QQ 外发。点名或引用你的消息直接放行。本机输入不受影响。',
            parameters: { type: 'object', properties: { reply: { type: 'boolean', description: '是否回复这轮群消息' }, reason: { type: 'string', description: '简短原因，仅留诊断，不发到 QQ' } }, required: ['reply'], additionalProperties: false },
            output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' } }, required: ['ok', 'code'], additionalProperties: false }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            execute: (args, exec) => {
              const operation = record.gateTail.then(async () => {
              if (!current() || exec.agent !== agent || exec.signal.aborted || typeof args?.reply !== 'boolean') return result(false, 'GATE_UNAVAILABLE')
              const facts = this.projection.stateOf(agent.session)
              if (!facts.active || !facts.exclusive || facts.bindingId !== binding.id || !facts.inputs.length) return result(false, 'NOT_EXCLUSIVE_QQ_TURN')
              const named = await Promise.all(facts.inputs.map(id => this.store.admissionResult(JSON.stringify([binding.id, id]))))
              if (!current() || exec.signal.aborted || this.projection.stateOf(agent.session) !== facts) return result(false, 'TURN_CHANGED')
              const previous = await this.store.gateResult(JSON.stringify([binding.id, facts.turn]))
              if (!current() || exec.signal.aborted || this.projection.stateOf(agent.session) !== facts) return result(false, 'TURN_CHANGED')
              if (previous) return result(true, previous.reply ? 'ALREADY_ALLOWED' : 'ALREADY_SUPPRESSED')
              const reply = named.some(value => value?.mentioned) || args.reply
              await this.store.recordGateResult(JSON.stringify([binding.id, facts.turn]), { reply, mentioned: named.some(value => value?.mentioned), reason: String(args.reason ?? '').slice(0, 160) })
              if (!reply && binding.replyGate.conclude && current() && this.projection.stateOf(agent.session) === facts) exec.concludeTurn()
              return result(true, reply ? 'QQ_REPLY_ALLOWED' : 'QQ_REPLY_SUPPRESSED')
              })
              record.gateTail = operation.catch(() => {}); return operation
            },
          }
          off.push(tools.register(definition))
          off.push(prompt.section({ name: 'qq-bridge-001.gate.' + binding.id, order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: '本会话绑定 QQ 群并启用回复门槛。QQ 起头的轮次先用 qq_reply_gate 判断是否在跟你说话；reply=false 不发本轮群回复。本机用户输入不需要此门槛。', interpolate: false }))
          record.replyGate = 'applied'
        }
      }
      if (binding.qzone?.enabled === true && this.qzone) {
        const registration = this.qzone.register(binding, agent, tools); record.qzone = registration.state
        if (registration.state === 'applied') off.push(() => registration.dispose())
      }
      if (this.schedule) {
        const registration = this.schedule.register(binding, agent, tools); record.schedule = registration.state
        if (registration.state === 'applied') off.push(() => registration.dispose())
      }
      if (this.history) {
        const registration = this.history.register(binding, agent, tools, current); record.history = registration.state
        if (registration.state === 'applied') off.push(() => registration.dispose())
      }
      if (this.groupAlbums && tools) {
        const registration = this.groupAlbums.register(binding, agent, tools, current)
        record.groupAlbums = registration.state
        if (registration.state === 'applied') off.push(() => registration.dispose())
      }
      if (this.outbox && tools) {
        const registration = this.outbox.register(binding, agent, tools, current)
        record.outbox = registration.state
        if (registration.state === 'applied') off.push(() => registration.dispose())
      }
      if (this.statusTool && tools) {
        off.push(tools.register(this.statusTool(binding, exec => current() && exec.agent === agent && !exec.signal.aborted)))
      }
      if (this.statusText && prompt) {
        off.push(prompt.section({
          name: 'qq-bridge-001.status.' + binding.id,
          order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
          text: () => current() ? this.statusText(binding) : '',
          interpolate: false,
        }))
      }
      if (this.ownRecall && this.projection && tools) {
        const definition = this.ownRecall(binding, exec => {
          if (exec.agent !== agent || exec.signal.aborted || !current() || !this.recallAllowed(binding.id)) return
          const facts = this.projection.stateOf(agent.session)
          if (facts.active && facts.exclusive && facts.bindingId === binding.id && facts.inputs.length) return { sessionId: agent.id, seq: facts.turn }
        })
        off.push(tools.register(definition, { when: () => current() && this.recallAllowed(binding.id) }))
      }
      if (binding.endpoint.startsWith('group:') && this.groupModeration && this.projection && tools) {
        const definition = this.groupModeration(binding, agent, current)
        off.push(tools.register(definition, { when: () => current() && this.recallAllowed(binding.id) }))
        if (prompt) off.push(prompt.section({ name: 'qq-bridge-001.group-notice.' + binding.id, order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: 'QQ 群公告可用 qq_group_moderate 查看、编辑草稿、发布和替换；先用 qq_history 找到本轮提出要求的消息编号，作为 requestMessageId。', interpolate: false }))
      }
    } catch { record.persona = record.persona === 'applied' ? record.persona : 'unavailable'; record.replyGate = binding.replyGate.enabled ? 'unavailable' : 'off'; record.qzone = binding.qzone?.enabled ? 'unavailable' : 'off'; record.schedule = 'unavailable'; record.history = 'unavailable' }
    if (!current()) record.dispose()
    else if (record.replyGate === 'applied') {
      try { const assembly = await prompt.assemble({ scope: agent }); if (!current() || !assembly.tools.some(tool => tool.name === 'qq_reply_gate')) { record.replyGate = 'unavailable'; record.dispose() } }
      catch { record.replyGate = 'unavailable'; record.dispose() }
    }
  }
  async allowDelivery(binding, reply) {
    if (!binding.replyGate.enabled || !binding.endpoint.startsWith('group:')) return true
    const record = this.records.get(binding.id)
    if (!record || record.replyGate !== 'applied' || this.liveAgent && this.liveAgent(binding.sessionId) !== record.agent) return false
    const facts = this.projection.stateOf(record.agent.session)
    if (facts.turn !== reply.turn || !facts.exclusive || facts.bindingId !== binding.id || !facts.inputs.length) return false
    const gate = await this.store.gateResult(JSON.stringify([binding.id, reply.turn]))
    if (this.projection.stateOf(record.agent.session) !== facts || this.closed) return false
    if (gate) return gate.reply
    const admissions = await Promise.all(facts.inputs.map(id => this.store.admissionResult(JSON.stringify([binding.id, id]))))
    return !this.closed && this.projection.stateOf(record.agent.session) === facts && admissions.some(value => value?.mentioned === true)
  }
  async reconcile(bindings) { for (const [id, record] of this.records) if (!bindings.some(binding => binding.id === id && binding.enabled && this._key(binding) === record.key)) { record.dispose(); this.records.delete(id) } }
  async dispose() { this.closed = true; this.controller.abort(); for (const record of this.records.values()) record.dispose(); await Promise.allSettled([...this.records.values()].map(record => record.gateTail)); this.records.clear() }
}
