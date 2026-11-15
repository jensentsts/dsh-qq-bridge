import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { normalizeQuote, normalizeSegments, parseEndpoint, TRANSPORT_ID } from './onebot.mjs'
import { OneBotError } from './onebot-http.mjs'

const textResult = (ok, text, code) => ({ ok, text, ...(code ? { code } : {}) })
const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' }, code: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false },
  render: (_, value) => [{ type: 'text', text: value.text }],
}
const messageId = value => typeof value === 'string' && /^-?\d{1,10}$/.test(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647 ? Number(value) : undefined
const clip = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max)
const failure = code => new OneBotError(code, 'failed')

/** Group-album operations use the same account, bindings, media and send switches as the QQ channel. */
export class QqGroupAlbums {
  constructor(bridge, { projection }) { this.bridge = bridge; this.projection = projection }

  targets(write) {
    const bridge = this.bridge
    const configured = [
      ...(bridge.config.enabled ? bridge.config.bindings.filter(row => row.enabled) : []),
      ...bridge.config.outboundTargets.filter(row => row.enabled).map(row => ({ ...row, id: TRANSPORT_ID + ':outbound:' + row.endpoint })),
    ]
    return configured.filter(row => row.endpoint.startsWith('group:') &&
      (write ? bridge.sendTarget(row.id, true) : bridge.statusTarget(row.id)))
  }

  choose(input, binding, write) {
    const targets = this.targets(write)
    const value = typeof input === 'string' ? input.trim() : ''
    if (!value && binding?.endpoint.startsWith('group:')) return targets.find(row => row.id === binding.id)
    if (!value) return targets.length === 1 ? targets[0] : undefined
    const matches = targets.filter(row => [row.id, row.endpoint, row.endpoint.slice(6), row.label].includes(value))
    if (matches.length === 1) return matches[0]
    if (matches.length && matches.every(row => row.endpoint === matches[0].endpoint)) return matches.find(row => row.id === binding?.id) ?? matches[0]
  }

  groups(write) {
    return this.targets(write).map(row => ({ group: row.endpoint.slice(6), name: row.label, destination: row.id }))
  }

  context(args, exec, { binding, agent, current, authorize, write }) {
    const bridge = this.bridge
    if (!bridge.networkEnabled() || exec.signal?.aborted) throw failure('QQ_ALBUM_UNAVAILABLE')
    let anchor, turn
    if (binding) {
      if (exec.agent !== agent || !current()) throw failure('QQ_ALBUM_UNAVAILABLE')
      const facts = this.projection?.stateOf(agent.session)
      if (write && (!facts?.active || !facts.exclusive || facts.bindingId !== binding.id || !facts.inputs.length)) throw failure('QQ_ALBUM_TURN_CHANGED')
      turn = facts?.turn
    } else {
      anchor = authorize()
    }
    const target = this.choose(args.group, binding, write)
    if (!target) return { groups: this.groups(write) }
    const origin = bridge.config.baseUrl
    const signal = AbortSignal.any([exec.signal, bridge.controller.signal].filter(Boolean))
    const guard = () => {
      if (signal.aborted || !bridge.networkEnabled() || bridge.config.baseUrl !== origin) throw failure('QQ_ALBUM_UNAVAILABLE')
      if (binding) {
        if (!current() || exec.agent !== agent) throw failure('QQ_ALBUM_UNAVAILABLE')
        if (write) {
          const facts = this.projection?.stateOf(agent.session)
          if (!facts?.active || !facts.exclusive || facts.bindingId !== binding.id || facts.turn !== turn || !facts.inputs.length) throw failure('QQ_ALBUM_TURN_CHANGED')
        }
      } else {
        const now = authorize()
        if (now.callId !== anchor.callId || now.reply.sessionId !== anchor.reply.sessionId || now.reply.seq !== anchor.reply.seq) throw failure('QQ_ALBUM_TURN_CHANGED')
      }
      const live = write ? bridge.sendTarget(target.id, true) : bridge.statusTarget(target.id)
      if (!live || live.endpoint !== target.endpoint || live.sessionId !== target.sessionId) throw failure('QQ_ALBUM_UNAVAILABLE')
    }
    guard()
    const sourceEndpoint = binding?.endpoint.startsWith('group:') ? binding.endpoint : target.endpoint
    const key = 'group-album:' + JSON.stringify(binding
      ? [binding.id, agent.id, turn, exec.callId]
      : [anchor.reply.sessionId, anchor.reply.seq, anchor.callId])
    return { target, sourceEndpoint, origin, signal, guard, key }
  }

  async albums(scope) {
    scope.guard()
    const groupId = parseEndpoint(scope.target.endpoint).id
    const answer = await this.bridge.onebot.callRaw('get_group_album_list', { group_id: groupId }, {
      signal: scope.signal, timeoutMs: 20000, maxBytes: 2097152, beforeSend: scope.guard,
    })
    scope.guard()
    if (!answer.ok) throw failure(answer.code ?? 'QQ_ALBUM_LIST_FAILED')
    if (!Array.isArray(answer.data)) throw failure('QQ_ALBUM_LIST_INVALID')
    return answer.data.filter(row => typeof row?.id === 'string' && row.id && typeof row.name === 'string' && row.name)
      .map(row => ({ id: row.id, name: row.name, count: Number.isFinite(Number(row.picNum)) ? Number(row.picNum) : undefined }))
  }

  async imageFromMessage(value, index, scope) {
    const id = messageId(value)
    if (id === undefined) throw failure('QQ_ALBUM_INVALID_MESSAGE')
    const onebot = this.bridge.onebot
    const read = async current => {
      scope.guard()
      const raw = await onebot.call('get_msg', { message_id: current }, { signal: scope.signal, timeoutMs: 5000, maxBytes: 1048576, beforeSend: scope.guard })
      scope.guard()
      const quote = normalizeQuote(raw, { endpoint: scope.sourceEndpoint, messageId: String(current), maxTextChars: 0, maxMedia: 8 })
      return { raw, images: quote.media.filter(part => part.type === 'image') }
    }
    let found = await read(id)
    if (!found.images.length) {
      const reply = normalizeSegments(found.raw.message).replyTo
      const original = messageId(reply)
      if (original !== undefined) found = await read(original)
    }
    const part = found.images[index - 1]
    if (!part) throw failure('QQ_ALBUM_IMAGE_NOT_FOUND')
    return this.bridge.media.admit(part, { signal: scope.signal, config: this.bridge.config, endpoint: scope.sourceEndpoint, onebot })
  }

  recentImage(agent, attachmentId, index, binding) {
    const messages = agent?.session?.deriveMessages?.()
    if (!Array.isArray(messages)) return
    for (const message of messages.toReversed()) {
      if (!['user', 'assistant'].includes(message.role)) continue
      if (binding && message.role === 'user' && message.source?.kind === 'super-agent-io' && message.source.bindingId !== binding.id) continue
      const images = (Array.isArray(message.content) ? message.content : []).filter(block => block?.type === 'image' && block.attachment)
      if (!attachmentId && images.length) return images[index - 1]
      if (attachmentId) {
        const selected = images.find(block => block.attachment.attachmentId === attachmentId)
        if (selected) return selected
      }
    }
  }

  async image(args, exec, scope, binding) {
    const index = args.imageIndex ?? 1
    if (!Number.isSafeInteger(index) || index < 1) throw failure('QQ_ALBUM_INVALID_IMAGE_INDEX')
    const selectors = [args.file, args.messageId, args.attachmentId].filter(value => typeof value === 'string' && value.trim())
    if (selectors.length > 1) throw failure('QQ_ALBUM_MULTIPLE_IMAGE_SOURCES')
    if (args.messageId) return this.imageFromMessage(args.messageId, index, scope)
    if (args.file) {
      const value = String(args.file).trim()
      let resource
      if (/^https?:\/\//i.test(value)) resource = { url: value, image: true }
      else resource = { path: /^file:/i.test(value) ? fileURLToPath(value) : value, image: true }
      return this.bridge.media.resolveOutbound(resource, { signal: scope.signal, config: this.bridge.config, sessionId: exec.agent.id })
    }
    const block = this.recentImage(exec.agent, args.attachmentId, index, binding)
    if (!block) throw failure('QQ_ALBUM_IMAGE_NOT_FOUND')
    return block
  }

  async upload(args, exec, options) {
    let scope
    try { scope = this.context(args, exec, { ...options, write: true }) }
    catch (error) { return textResult(false, 'QQ 群相册当前不可用。', error.code) }
    if (!scope.target) return textResult(false, JSON.stringify({ message: '请选择要上传的 QQ 群。', groups: scope.groups }), 'QQ_ALBUM_GROUP_REQUIRED')
    const intent = createHash('sha256').update(JSON.stringify([scope.target.endpoint, args.albumId, args.albumName, args.file, args.messageId, args.attachmentId, args.imageIndex])).digest('hex')
    return this.bridge._deliveryFlight(scope.key, async () => {
      const prior = await this.bridge.store.delivery(scope.key)
      if (prior) {
        if (prior.parts?.[0] !== intent) return textResult(false, '本次上传参数已变化。', 'QQ_ALBUM_ACTION_CONFLICT')
        if (prior.state === 'delivered') return textResult(true, '这张图片已上传到群相册。', 'QQ_ALBUM_ALREADY_UPLOADED')
        return textResult(false, prior.state === 'failed' ? '之前的上传已失败。' : '上传结果尚未确认，请先检查群相册。', prior.reason ?? 'QQ_ALBUM_RESULT_UNKNOWN')
      }
      let selected, file
      try {
        const albums = await this.albums(scope)
        const matches = albums.filter(row => args.albumId ? row.id === args.albumId : args.albumName ? row.name === args.albumName : true)
        if (!matches.length) return textResult(false, albums.length ? '没有找到指定的群相册。' : '这个群还没有相册，请先创建群相册。', 'QQ_ALBUM_NOT_FOUND')
        if (matches.length > 1) return textResult(false, JSON.stringify({ message: '请选择群相册。', albums: matches }), 'QQ_ALBUM_SELECTION_REQUIRED')
        selected = matches[0]
        const image = await this.image(args, exec, scope, options.binding)
        scope.guard()
        if (image?.type !== 'image') throw failure('QQ_ALBUM_IMAGE_NOT_FOUND')
        file = await this.bridge.media.export(image, { signal: scope.signal, config: this.bridge.config })
        if (typeof file?.file !== 'string' || !file.file) throw failure('QQ_ALBUM_IMAGE_UNAVAILABLE')
        scope.guard()
        await this.bridge.store.recordDelivery(scope.key, { state: 'sending', parts: [intent] })
      } catch (error) {
        return textResult(false, '图片或群相册读取失败，请检查图片来源和相册。', error.code ?? 'QQ_ALBUM_PREPARE_FAILED')
      }
      let answer
      try {
        answer = await this.bridge.onebot.callRaw('upload_image_to_qun_album', {
          group_id: parseEndpoint(scope.target.endpoint).id, album_id: selected.id, album_name: selected.name, file: file.file,
        }, { signal: scope.signal, timeoutMs: 120000, maxBytes: 65536, beforeSend: scope.guard })
      } catch (error) {
        answer = { ok: false, code: error?.code ?? 'QQ_ALBUM_RESPONSE_UNKNOWN', deliveryState: error?.deliveryState }
      }
      const state = answer.ok ? 'delivered' : answer.code === 'ONEBOT_API_REJECTED' || answer.deliveryState === 'failed' ? 'failed' : 'unknown'
      const reason = answer.ok ? undefined : answer.code ?? 'QQ_ALBUM_RESPONSE_UNKNOWN'
      try { await this.bridge.store.recordDelivery(scope.key, { state, parts: [intent], ...(reason ? { reason } : {}) }) }
      catch { return textResult(false, '上传请求已提交，结果记录失败。请先查看群相册。', 'QQ_ALBUM_RECEIPT_UNKNOWN') }
      if (state === 'delivered') return textResult(true, `已上传图片到群相册「${selected.name}」。`)
      if (state === 'failed') return textResult(false, 'QQ 拒绝了图片上传' + (answer.wording ? '：' + clip(answer.wording, 300) : '。'), reason)
      return textResult(false, '上传结果尚未确认，请先查看群相册。', reason)
    })
  }

  definitions(options = {}) {
    const bound = !!options.binding
    const group = { type: 'string', description: 'QQ 群号、已配置群的名称或 io_destinations 返回的目标。省略时使用当前群。' }
    const list = {
      name: bound ? 'qq_group_albums' : 'qq_albums',
      description: '查看已配置 QQ 群的相册名称和 ID，用于选择图片上传目标。',
      parameters: { type: 'object', properties: { group, offset: { type: 'integer', minimum: 0, description: '从该序号开始列出相册，默认为 0。' } }, additionalProperties: false }, output,
      execute: async (args = {}, exec, authorize) => {
        try {
          const scope = this.context(args, exec, { ...options, authorize, write: false })
          if (!scope.target) return textResult(true, JSON.stringify({ message: '请选择 QQ 群。', groups: scope.groups }))
          const albums = await this.albums(scope)
          const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
          const page = albums.slice(offset, offset + 100)
          return textResult(true, JSON.stringify({ group: scope.target.endpoint.slice(6), albums: page, total: albums.length, ...(offset + page.length < albums.length ? { nextOffset: offset + page.length } : {}) }))
        } catch (error) { return textResult(false, '群相册读取失败。', error.code ?? 'QQ_ALBUM_LIST_FAILED') }
      },
    }
    const upload = {
      name: bound ? 'qq_group_album_upload' : 'qq_album_upload',
      description: '把一张图片上传到 QQ 群相册。先查询相册；可用当前会话里的最近图片、QQ 消息编号或工作区图片路径。多张图片分别调用。上传结果不确定时先检查相册。',
      timeoutMs: 180000,
      parameters: { type: 'object', properties: {
        group,
        albumId: { type: 'string', description: '群相册 ID。' },
        albumName: { type: 'string', description: '群相册名称。' },
        file: { type: 'string', description: '工作区图片路径或已允许的图片 URL。' },
        messageId: { type: 'string', description: '含图片或回复图片的 QQ 消息编号。' },
        attachmentId: { type: 'string', description: '当前会话中的图片附件 ID。' },
        imageIndex: { type: 'integer', minimum: 1, description: '同一消息中第几张图片，从 1 开始。' },
      }, additionalProperties: false }, output,
      execute: (args = {}, exec, authorize) => this.upload(args, exec, { ...options, authorize }),
    }
    return { list, upload }
  }

  register(binding, agent, tools, current) {
    const definitions = this.definitions({ binding, agent, current })
    const off = []
    try {
      off.push(tools.register(definitions.list))
      off.push(tools.register(definitions.upload))
      return { state: 'applied', dispose() { for (const stop of off.splice(0).reverse()) stop?.() } }
    } catch {
      for (const stop of off.splice(0).reverse()) stop?.()
      return { state: 'unavailable', dispose() {} }
    }
  }
}
