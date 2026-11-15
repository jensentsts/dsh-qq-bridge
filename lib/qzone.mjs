/** Qzone extension actions over the same OneBot HTTP origin. Reads are bounded; writes require the business send gate. */
const clip = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, max)
const integer = (value, fallback, min, max) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback }
const qqNumber = value => { const text = String(value ?? '').trim(); return /^[0-9]{4,12}$/.test(text) ? Number(text) : text }
const tidValue = value => { const text = String(value ?? '').trim(); return /^[0-9]{1,24}$/.test(text) ? Number(text) : text }
const dateText = value => {
  const number = Number(value) || 0
  if (!number) return '时间不明'
  const date = new Date(number * 1000), pad = value => String(value).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}
export const qzoneHtmlText = (html, max = 300) => {
  let text = String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h[1-6])>/gi, ' ').replace(/<[^>]*>/g, '')
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}
const output = {
  schema: { type: 'object', properties: { ok: { type: 'boolean' }, text: { type: 'string' } }, required: ['ok', 'text'], additionalProperties: false },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}
const result = (ok, text) => ({ ok, text: clip(text, 6000) })
/** Exact-Agent scoped Qzone tools. No update/install, no local path reads, no send outside the bridge gate. */
export class QzoneTools {
  constructor({ onebot, binding, networkEnabled = () => false, sendEnabled = () => false, report = () => {} }) {
    this.onebot = onebot; this.binding = binding; this.networkEnabled = networkEnabled; this.sendEnabled = sendEnabled; this.report = report
  }
  snapshot() { return { available: true, writes: 'business-send-gate', localPaths: false } }
  _current(binding) { const value = this.binding(binding.id); return value && value.qzone?.enabled === true && value.enabled === true ? value : undefined }
  _writeAllowed(binding, kind) { const current = this._current(binding); return Boolean(current && current.sendEnabled && current.qzone[kind] === true && this.sendEnabled()) }
  async _call(action, params, signal) {
    if (!this.networkEnabled()) return { ok: false, code: 'NETWORK_ACCESS_DISABLED', text: 'Host networkAccess 未开启，未发出空间请求。' }
    try {
      if (typeof this.onebot.callRaw === 'function') {
        const raw = await this.onebot.callRaw(action, params, { signal, timeoutMs: 10000, maxBytes: 1048576 })
        if (!raw.ok) {
          const wording = String(raw.text || raw.wording || '')
          if (Number(raw.retcode) === 100 && /msglist/i.test(wording)) return { ok: false, empty: true, code: 'QZONE_EMPTY', text: '这个号的空间里还没有说说' }
          return { ok: false, code: raw.code || 'QZONE_REJECTED', retcode: raw.retcode, text: clip(wording || ('QQ 后端拒绝了这次空间请求' + (raw.retcode !== undefined ? '（retcode ' + raw.retcode + '）' : '')), 300) }
        }
        return { ok: true, data: raw.data }
      }
      return { ok: true, data: await this.onebot.call(action, params, { signal, timeoutMs: 10000, maxBytes: 1048576 }) }
    } catch (error) { return { ok: false, code: clip(error?.code || 'QZONE_FAILED', 80), text: 'QQ 后端拒绝了这次空间请求或连接失败。' } }
  }
  _definitions(binding, agent) {
    const current = () => this._current(binding), sameAgent = exec => !exec?.agent || exec.agent === agent, aborted = exec => exec?.signal?.aborted === true
    const guard = exec => current() && sameAgent(exec) && !aborted(exec)
    return [
      {
        name: 'qq_space_list', description: '看 QQ 空间说说列表：时间、正文摘要、评论数、是否私密、图片数，每条带 tid。只读。', parameters: { type: 'object', properties: { qq: { type: 'string', description: '看谁的 QQ 号；不填为机器人自己' }, num: { type: 'integer', minimum: 1, maximum: 50 }, pos: { type: 'integer', minimum: 0 } }, additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          const body = { pos: integer(args.pos, 0, 0, 10000), num: integer(args.num, 10, 1, 50) }, qq = qqNumber(args.qq)
          if (qq) body.target_uin = qq
          const reply = await this._call('get_qzone_msg_list', body, exec?.signal)
          if (!reply.ok) return result(Boolean(reply.empty), reply.text)
          const list = Array.isArray(reply.data?.msglist) ? reply.data.msglist : []
          if (!list.length) return result(true, '这个号的空间里还没有说说。')
          const lines = []
          for (const [index, item] of list.entries()) {
            if (!item) continue
            lines.push((body.pos + index + 1) + '. ' + dateText(item.time) + (item.tid != null ? '　tid ' + String(item.tid) : '') + '　评论 ' + (Number(item.comment_num) || 0) + (item.is_private ? '　私密' : '') + '　图 ' + (Array.isArray(item.images) ? item.images.length : 0) + ' 张\n   ' + (clip(item.content, 200) || '（没有文字）'))
          }
          return result(true, '共 ' + (Number(reply.data?.total) || list.length) + ' 条说说（这次取 ' + lines.length + ' 条）：\n' + lines.join('\n'))
        },
      },
      {
        name: 'qq_space_detail', description: '看一条 QQ 说说的正文和一页评论。tid 从 qq_space_list 拿。只读。', parameters: { type: 'object', properties: { tid: { type: 'string' }, qq: { type: 'string' }, num: { type: 'integer', minimum: 1, maximum: 50 }, pos: { type: 'integer', minimum: 0 } }, required: ['tid'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          const tid = tidValue(args.tid)
          if (tid === '') return result(false, '要给一个说说的 tid。')
          const body = { tid, pos: integer(args.pos, 0, 0, 10000), num: integer(args.num, 20, 1, 50) }, qq = qqNumber(args.qq)
          if (qq) body.target_uin = qq
          const reply = await this._call('get_qzone_msg_detail', body, exec?.signal)
          if (!reply.ok) return result(false, reply.text)
          const comments = Array.isArray(reply.data?.comments) ? reply.data.comments : [], lines = ['正文：' + (clip(reply.data?.content, 500) || '（没有文字）')]
          if (!comments.length) lines.push('还没有评论。')
          else {
            lines.push('评论（' + (Number(reply.data?.comment_num) || comments.length) + ' 条，下面列 ' + comments.length + ' 条）：')
            for (const comment of comments) {
              if (!comment) continue
              const author = clip(comment.nickname || comment.name || (comment.uin != null ? 'QQ ' + comment.uin : comment.user_id != null ? 'QQ ' + comment.user_id : '某人'), 80)
              lines.push('· ' + (comment.time ? dateText(comment.time) + '　' : '') + author + '：' + (clip(comment.content ?? comment.text ?? comment.msg, 200) || '（空）'))
            }
          }
          return result(true, '说说 ' + String(tid) + '\n' + lines.join('\n'))
        },
      },
      {
        name: 'qq_space_feeds', description: '看 QQ 空间好友动态流：谁发的、什么时候、说了什么。HTML 会先去标签和压缩空白。只读。', parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 50 }, page: { type: 'integer', minimum: 1 } }, additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          const reply = await this._call('get_qzone_feeds', { page_num: integer(args.page, 1, 1, 100), count: integer(args.count, 10, 1, 50) }, exec?.signal)
          if (!reply.ok) return result(false, reply.text)
          const feeds = Array.isArray(reply.data?.feeds) ? reply.data.feeds : []
          if (!feeds.length) return result(true, '这一页没有好友动态。')
          const lines = []
          for (const feed of feeds) {
            if (!feed) continue
            const author = clip(feed.nickname || (feed.uin != null ? 'QQ ' + feed.uin : '某人'), 80)
            lines.push('· ' + dateText(feed.time) + '　' + author + '\n   ' + (qzoneHtmlText(feed.html, 300) || '（这条没有文字，可能只有图或视频）'))
          }
          return result(true, '好友动态 ' + lines.length + ' 条' + (reply.data?.has_more ? '（还有更多）' : '') + '：\n' + lines.join('\n'))
        },
      },
      {
        name: 'qq_space_post', description: '往机器人自己的 QQ 空间发一条说说。必须同时开启业务外发总开关、绑定的外发开关和空间发说说开关。只接受 http(s) 图片或 base64:// 数据，不读取任意本地路径。', parameters: { type: 'object', properties: { content: { type: 'string' }, images: { type: 'array', items: { type: 'string' }, maxItems: 9 }, ugc_right: { type: 'integer', enum: [1, 4, 16, 64, 128] }, target_uins: { type: 'array', items: { type: 'string' }, maxItems: 100 } }, additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          if (!this._writeAllowed(binding, 'post')) return result(false, '业务外发总开关、绑定外发或空间发说说开关尚未打开，这条没有发出去。')
          const text = clip(args.content, 4096), images = (Array.isArray(args.images) ? args.images : []).map(value => clip(value, 8 * 1024 * 1024)).filter(Boolean).slice(0, 9)
          if (!text.trim() && !images.length) return result(false, '正文和图片都是空的。')
          let imageBytes = 0
          for (const image of images) {
            imageBytes += image.length
            if (imageBytes > 16 * 1024 * 1024) return result(false, '图片总大小超过 16 MiB 上限。')
            if (image.startsWith('base64://')) { if (!/^base64:\/\/[A-Za-z0-9+/]+={0,2}$/.test(image)) return result(false, 'base64 图片数据不合法。'); continue }
            if (!/^https?:\/\/[^\s"'<>]{1,2048}$/i.test(image)) return result(false, '图片只接受 http(s) 地址或 base64:// 数据。')
            try { const url = new URL(image); if (url.username || url.password) throw new Error('credentials') } catch { return result(false, '图片地址不合法。') }
          }
          const right = [1, 4, 16, 64, 128].includes(Number(args.ugc_right)) ? Number(args.ugc_right) : 1
          const targets = (Array.isArray(args.target_uins) ? args.target_uins : []).map(qqNumber).filter(value => value !== '').slice(0, 100)
          if ((right === 16 || right === 128) && !targets.length) return result(false, '部分可见/部分不可见需要 target_uins 名单。')
          const body = { content: text, ugc_right: right, ...(images.length ? { images } : {}), ...(targets.length && (right === 16 || right === 128) ? { target_uins: targets } : {}) }
          const reply = await this._call('send_qzone_msg', body, exec?.signal)
          if (!reply.ok) return result(false, '没发出去：' + reply.text)
          const data = reply.data, tid = data && typeof data === 'object' ? (data.tid ?? data.data?.tid ?? '') : (data ?? '')
          return result(true, '发好了' + (tid ? '，tid ' + String(tid) : ''))
        },
      },
      {
        name: 'qq_space_like', description: '给一条 QQ 空间说说点赞。必须同时开启业务外发总开关、绑定外发和空间点赞开关。', parameters: { type: 'object', properties: { tid: { type: 'string' }, uin: { type: 'string' }, abstime: { type: 'integer' } }, required: ['tid'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          if (!this._writeAllowed(binding, 'like')) return result(false, '业务外发总开关、绑定外发或空间点赞开关尚未打开，没有点赞。')
          const tid = tidValue(args.tid), uin = qqNumber(args.uin), body = { tid, ...(uin ? { target_uin: uin } : {}), ...(Number(args.abstime) > 0 ? { abstime: Number(args.abstime) } : {}) }
          const reply = await this._call('like_qzone', body, exec?.signal)
          return reply.ok ? result(true, '点好赞了。') : result(false, '没有点上：' + reply.text)
        },
      },
      {
        name: 'qq_space_comment', description: '评论一条 QQ 空间说说，可带二级回复字段。必须同时开启业务外发总开关、绑定外发和空间评论开关。', parameters: { type: 'object', properties: { tid: { type: 'string' }, uin: { type: 'string' }, content: { type: 'string' }, abstime: { type: 'integer' }, reply_comment_id: { type: 'string' }, reply_uin: { type: 'string' } }, required: ['tid', 'content'], additionalProperties: false }, output,
        execute: async (args = {}, exec) => {
          if (!guard(exec)) return result(false, '空间工具已不可用或调用者不匹配。')
          if (!this._writeAllowed(binding, 'comment')) return result(false, '业务外发总开关、绑定外发或空间评论开关尚未打开，没有评论。')
          const text = clip(args.content, 1000)
          if (!text.trim()) return result(false, '评论正文是空的。')
          const tid = tidValue(args.tid), uin = qqNumber(args.uin)
          const body = { tid, content: text, ...(uin ? { target_uin: uin } : {}), ...(Number(args.abstime) > 0 ? { abstime: Number(args.abstime) } : {}), ...(args.reply_comment_id ? { reply_comment_id: clip(args.reply_comment_id, 128) } : {}), ...(args.reply_uin ? { reply_uin: qqNumber(args.reply_uin) } : {}) }
          const reply = await this._call('comment_qzone', body, exec?.signal)
          return reply.ok ? result(true, '评论好了。') : result(false, '没有评论上：' + reply.text)
        },
      },
    ]
  }
  register(binding, agent, tools) {
    if (binding.qzone?.enabled !== true) return { state: 'off', dispose() {} }
    if (!tools || typeof tools.register !== 'function') return { state: 'unavailable', dispose() {} }
    const off = []
    try { for (const definition of this._definitions(binding, agent)) { const dispose = tools.register(definition); if (typeof dispose === 'function') off.push(dispose) } }
    catch (error) { this.report({ code: 'QZONE_TOOL_REGISTER_FAILED', bindingId: binding.id }); for (const dispose of off.splice(0)) { try { dispose() } catch {} } return { state: 'unavailable', dispose() {} } }
    return { state: off.length ? 'applied' : 'unavailable', dispose() { for (const dispose of off.splice(0).reverse()) { try { dispose() } catch {} } } }
  }
}
