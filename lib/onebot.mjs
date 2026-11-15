/** QQ fork 0.0.1 transport normalization. Derived package: Yuuyuko-uu/dsh-qq-link; see LICENSE.
 * Pure plans never send, start Agents, grant permission, or parse assistant text as commands.
 */
import { isVoiceFile } from './outbound-content.mjs'

export const TRANSPORT_ID = 'qq-bridge-001'
export const ROUTE_PREFIX = '/dsh-qq-bridge-001'
export const DOMAIN_NAME = 'qq_bridge_001'
const id = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe numeric OneBot ID')
  const s = String(value ?? '')
  if (!/^-?\d{1,24}$/.test(s)) throw new Error('Invalid OneBot message ID')
  return s
}
export function parseEndpoint(endpoint) {
  const match = /^(private|group):([1-9]\d{0,23})$/.exec(String(endpoint))
  if (!match) throw new Error('Expected private:<QQ ID> or group:<group ID>')
  return { kind: match[1], id: match[2] }
}
export function bindingId(endpoint) { parseEndpoint(endpoint); return `${TRANSPORT_ID}:${endpoint}` }
export function textSegment(text) { return { type: 'text', data: { text: String(text) } } }
const clip = (value, max) => String(value ?? '').slice(0, max)
const mentionId = value => typeof value === 'number' && !Number.isSafeInteger(value) ? '' : /^(?:[1-9]\d{0,23}|all)$/.test(String(value ?? '')) ? String(value) : ''
/** QQ bot cards often embed images in their Markdown text rather than an image segment. */
function* inlineMarkdownImages(value) {
  let fence = ''
  for (const line of value.slice(0, 24576).split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      continue
    }
    if (fence) continue
    // Code spans may show example Markdown; leave them as literal text.
    const scanned = line.replace(/(`+)([^`\r\n]*)\1/g, match => ' '.repeat(match.length))
    const pattern = /(?<!\\)!\[([^\]\r\n]{0,160})\]\(\s*(?:<(https?:\/\/[^\s<>]{1,4096})>|(https?:\/\/[^\s()<>]{1,4096}))(?:\s+["'][^"'\r\n]{0,160}["'])?\s*\)/gi
    for (const match of scanned.matchAll(pattern)) {
      yield { type: 'image', url: match[2] || match[3], file: '', fileId: '', name: match[1], bytes: 0, inlineMarkdown: true }
    }
  }
}
function stringSegments(text, limit) {
  const output = []
  let start = 0
  for (const tag of text.matchAll(/\[CQ:(at|reply),([^\[\]\r\n]+)\]/g)) {
    let part
    if (tag[1] === 'at') {
      const qq = mentionId(/(?:^|,)qq=([^,]+)(?:,|$)/.exec(tag[2])?.[1])
      if (qq) part = { type: 'at', data: { qq } }
    } else {
      const replyId = /(?:^|,)id=(-?\d{1,24})(?:,|$)/.exec(tag[2])?.[1]
      if (replyId) part = { type: 'reply', data: { id: replyId } }
    }
    if (!part) continue
    if (tag.index > start) output.push(textSegment(text.slice(start, tag.index)))
    output.push(part)
    start = tag.index + tag[0].length
    if (output.length > limit) return output
  }
  if (start < text.length) output.push(textSegment(text.slice(start)))
  return output
}
export function readKeyboardRows(data) {
  const rows = Array.isArray(data.rows) ? data.rows : data.content?.rows
  if (!Array.isArray(rows)) return undefined
  const maxRows = 5, maxButtons = 5, maxLabelChars = 80
  const buttons = []
  let truncated = rows.length > maxRows
  for (const row of rows.slice(0, maxRows)) {
    if (!Array.isArray(row?.buttons)) continue
    const names = []
    if (row.buttons.length > maxButtons) truncated = true
    for (const button of row.buttons.slice(0, maxButtons)) {
      const value = button?.label ?? button?.render_data?.label
      if (typeof value !== 'string') continue
      const name = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
      if (name.length > maxLabelChars) truncated = true
      if (name) names.push({ label: name.slice(0, maxLabelChars), source: button })
    }
    if (names.length) buttons.push(names)
  }
  return { rows: buttons, truncated }
}
export function normalizeSegments(message, { maxSegments = 48, maxTextChars = 24576 } = {}) {
  const input = typeof message === 'string' ? stringSegments(message, maxSegments) : Array.isArray(message) ? message : []
  const segments = [], media = [], rich = [], mentions = [], warnings = []
  let text = '', replyTo, inlineCount = 0, truncated = input.length > maxSegments
  const appendText = (value, scanImages = false) => {
    const remaining = Math.max(0, maxTextChars - text.length)
    const next = value.slice(0, remaining)
    text += next
    segments.push(textSegment(next))
    if (scanImages) for (const image of inlineMarkdownImages(value)) {
      if (inlineCount >= 8) { truncated = true; break }
      inlineCount++
      media.push(image)
    }
    if (value.length > remaining) truncated = true
  }
  const boundedInput = input.slice(0, maxSegments)
  for (const [index, part] of boundedInput.entries()) {
    if (!part || typeof part !== 'object') continue
    const d = part.data && typeof part.data === 'object' ? part.data : {}
    const type = String(part.type || '')
    if (type === 'markdown') {
      const value = String(d.text ?? d.content ?? '')
      // SnowLuma reports the same card as adjacent Markdown and text segments.
      const duplicate = [boundedInput[index - 1], boundedInput[index + 1]].some(other => other?.type === 'text' && typeof other.data?.text === 'string' && other.data.text === value)
      if (!duplicate) appendText(value, true)
    } else if (type === 'text') {
      appendText(String(d.text ?? d.content ?? ''), true)
    } else if (type === 'reply') {
      try { if (replyTo === undefined) replyTo = id(d.id) } catch { warnings.push('Invalid reply ID omitted') }
    } else if (['image', 'mface', 'record', 'video', 'file'].includes(type)) {
      const descriptor = { type: type === 'mface' ? 'image' : type, url: clip(d.url, 4096), file: clip(d.file, 4096), fileId: clip(d.file_id ?? d.id, 256), name: clip(d.name ?? d.file_name ?? d.summary, 160), bytes: Math.max(0, Number(d.size ?? d.file_size) || 0) }
      if (type === 'file') {
        const fileHash = clip(d.file_hash, 256)
        const busId = Number(d.busid ?? d.bus_id)
        if (fileHash) descriptor.fileHash = fileHash
        if (Number.isSafeInteger(busId) && busId > 0) descriptor.busId = busId
      }
      media.push(descriptor); segments.push({ type, data: descriptor })
    } else if (type === 'at') {
      const mention = mentionId(d.qq ?? d.user_id)
      if (!mention) continue
      mentions.push(mention)
      const value = mention === 'all' ? '@全体成员' : `@${mention}`
      if (text.length + value.length <= maxTextChars) { text += value; segments.push(textSegment(value)) }
      else truncated = true
    } else if (type === 'inline_keyboard' || type === 'keyboard') {
      const keyboard = readKeyboardRows(d)
      if (!keyboard) continue
      if (keyboard.truncated) truncated = true
      if (keyboard.rows.length) appendText('\n[QQ 按钮（外部资料）] ' + JSON.stringify(keyboard.rows.map(row => row.map(button => button.label))) + '\n')
    } else if (type === 'share') {
      rich.push({ type, title: clip(d.title, 256), description: clip(d.content, 256), url: clip(d.url, 512), image: clip(d.image ?? d.image_url ?? d.imageUrl ?? d.cover, 4096) })
    } else if (['json', 'xml', 'forward'].includes(type)) {
      let payload = d.data ?? d.content ?? d.xml ?? ''
      try { if (typeof payload !== 'string') payload = JSON.stringify(payload) } catch { payload = '' }
      rich.push(type === 'forward' ? { type, id: clip(d.id ?? d.message_id ?? d.res_id ?? d.content, 257) } : { type, payload: clip(payload, 16384) })
      warnings.push(`${type} payload not expanded without explicit rich-content opt-in`)
    }
  }
  return { text, segments, media, rich, mentions, ...(replyTo !== undefined ? { replyTo } : {}), truncated, warnings }
}
/** Includes top-level file-only messages and OneBot group_upload notices. */
export function normalizeEvent(event, limits) {
  if (!event || typeof event !== 'object') throw new Error('Invalid OneBot event')
  const upload = event.post_type === 'notice' && event.notice_type === 'group_upload'
  if (event.post_type !== 'message' && !upload) return null
  const kind = upload || event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : null
  if (!kind) return null
  const peer = kind === 'group' ? event.group_id : event.user_id ?? event.sender?.user_id
  const endpoint = `${kind}:${id(peer)}`
  parseEndpoint(endpoint)
  const senderId = id(event.user_id ?? event.sender?.user_id)
  if (event.self_id !== undefined && senderId === id(event.self_id)) return null
  let message = event.message
  if (event.file && (!Array.isArray(message) || !message.some(p => p?.type === 'file'))) {
    const f = event.file
    message = [...(Array.isArray(message) ? message : typeof message === 'string' ? [textSegment(message)] : []), { type: 'file', data: { ...f, file_id: f.file_id ?? f.id } }]
  }
  const normalized = normalizeSegments(message, limits)
  const uploadId = upload && normalized.media.find(part => part.type === 'file')?.fileId
  const externalMessageId = event.message_id !== undefined ? id(event.message_id) : uploadId ? 'upload:' + uploadId : null
  if (!externalMessageId) throw new Error('OneBot event has no stable message/file ID')
  return { endpoint, externalMessageId, senderId, ...(event.self_id !== undefined ? { selfId: id(event.self_id) } : {}), senderName: clip(event.sender?.card || event.sender?.nickname || senderId, 120), senderNickname: clip(event.sender?.nickname, 120), senderCard: kind === 'group' ? clip(event.sender?.card, 120) : '', senderTitle: kind === 'group' ? clip(event.sender?.title, 120) : '', time: Number(event.time) || 0, ...normalized }
}
/** A quoted message must be proven to belong to this exact chat; no cross-group fallback. */
export function normalizeQuote(data, { endpoint, messageId, selfId, knownEndpoint, maxTextChars = 3000, maxMedia = 2 } = {}) {
  if (!data || typeof data !== 'object' || id(data.message_id) !== id(messageId)) throw new Error('Quoted message identity mismatch')
  const target = parseEndpoint(endpoint)
  const senderId = id(data.sender?.user_id ?? data.user_id)
  let proven = false
  if (target.kind === 'group') proven = data.message_type === 'group' && String(data.group_id ?? '') === target.id
  else if (data.message_type === 'private') {
    proven = String(data.user_id ?? data.sender?.user_id ?? '') === target.id || String(data.target_id ?? '') === target.id && senderId === String(selfId ?? '')
  }
  if (knownEndpoint && knownEndpoint !== endpoint) throw new Error('Quoted message belongs to another chat')
  // get_msg often omits private/group addressing on our own messages. Sidecar can prove it, never a heuristic.
  if (!proven && knownEndpoint === endpoint && (data.group_id === undefined || target.kind === 'group' && String(data.group_id) === target.id)) proven = true
  if (!proven) throw new Error('Quoted message chat cannot be verified')
  const parts = normalizeSegments(data.message, { maxSegments: 24, maxTextChars })
  return { messageId: id(messageId), senderId, senderName: clip(data.sender?.card || data.sender?.nickname || senderId, 120), text: parts.text, media: parts.media.slice(0, maxMedia), truncated: parts.truncated || parts.media.length > maxMedia }
}
export function quoteText(quote) {
  const mediaLabels = { image: '图片', record: '语音', video: '视频', file: '文件' }
  const media = quote.media.map(part => `[${mediaLabels[part.type] ?? '附件'}${part.name ? ' ' + part.name.replace(/\s+/g, ' ') : ''}]`)
  const lines = [quote.text.trim(), ...media, ...(quote.truncated ? ['…'] : [])].filter(Boolean)
  return lines.flatMap(line => line.split(/\r\n?|\n/)).map(line => '> ' + line).join('\n')
}
/** Each real committed assistant message produces one unsplit text/media plan. */
export async function planOutbound(content, { endpoint, replyTo, exportMedia, allowGroupFiles = false, memeFiles = [] } = {}) {
  const peer = parseEndpoint(endpoint), message = [], files = [], extras = [], warnings = []
  if (replyTo !== undefined) {
    try { message.push({ type: 'reply', data: { id: id(replyTo) } }) }
    catch { warnings.push('Source event has no native QQ message ID; reply segment omitted') }
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (block?.type === 'text' && typeof block.text === 'string') message.push(textSegment(block.text))
    else if ((block?.type === 'image' || block?.type === 'file') && block.attachment) {
      try {
        const voice = block.type === 'file' && isVoiceFile(block.attachment.name)
        if (block.type === 'file' && !voice && peer.kind === 'group' && !allowGroupFiles) throw new Error('Group file sending is disabled')
        if (typeof exportMedia !== 'function') throw new Error('Attachment exporter unavailable')
        const part = await exportMedia(block)
        if (!part || typeof part.file !== 'string' || !part.file) throw new Error('Attachment is not exportable')
        if (block.type === 'image') message.push({ type: 'image', data: { file: part.file } })
        else if (voice) extras.push(sendMessage([{ type: 'record', data: { file: part.file } }]))
        else {
          const upload = { action: peer.kind === 'group' ? 'upload_group_file' : 'upload_private_file', params: { [peer.kind === 'group' ? 'group_id' : 'user_id']: peer.id, file: part.file, name: part.name || block.attachment.name || 'attachment' } }
          files.push(upload)
          extras.push(upload)
        }
      } catch (error) {
        const warning = `附件未发送：${clip(block.attachment.name || block.type, 120)}（${clip(error.message, 160)}）`
        warnings.push(warning); message.push(textSegment(`\n${warning}`))
      }
    }
    // Reasoning, tool calls, attempts and arbitrary outbound block kinds are never public.
  }
  const meaningful = message.some(p => p.type !== 'reply' && (p.type !== 'text' || p.data.text.trim()))
  const memeMessages = memeFiles.map(file => sendMessage([{ type: 'image', data: { file } }]))
  return { ...(meaningful ? { message: sendMessage(message) } : {}), files, extras, memeMessages, warnings }
  function sendMessage(parts) {
    return { action: peer.kind === 'group' ? 'send_group_msg' : 'send_private_msg', params: { [peer.kind === 'group' ? 'group_id' : 'user_id']: peer.id, message: parts, auto_escape: true } }
  }
}
/** Split actual line breaks into QQ messages, keeping the native reply on the first one. */
export function splitChatMessages(message) {
  const segments = message?.params?.message
  if (!message) return []
  if (!Array.isArray(segments) || !segments.some(part => part.type === 'text' && /[\r\n]/u.test(part.data.text))) return [message]
  const quotes = segments.filter(part => part.type === 'reply')
  const messages = []
  let line = []
  const flush = () => {
    if (line.some(part => part.type !== 'text' || part.data.text.trim())) {
      messages.push({
        ...message,
        params: { ...message.params, message: [...(messages.length ? [] : quotes), ...line] },
      })
    }
    line = []
  }
  for (const part of segments) {
    if (part.type === 'reply') continue
    if (part.type !== 'text') { line.push(part); continue }
    const pieces = part.data.text.split(/\r\n|\r|\n/u)
    for (const [index, piece] of pieces.entries()) {
      if (piece) line.push(textSegment(piece))
      if (index < pieces.length - 1) flush()
    }
  }
  flush()
  return messages
}

/** Synthesize a plain reply and keep its native quote on the original text. */
export async function planVoice(message, config, synthesize) {
  const parts = message?.params?.message
  if (!config?.enabled || !Array.isArray(parts) || typeof synthesize !== 'function') return { messages: message ? [message] : [], synthesized: false }
  const mixed = parts.some(p => p.type !== 'text' && p.type !== 'reply')
  const text = parts.filter(p => p.type === 'text').map(p => p.data.text).join('')
  if (mixed || !text.trim()) return { messages: [message], synthesized: false }
  let audio
  try { audio = await synthesize(text, config) } catch { /* Keep original text on TTS failure. */ }
  if (!audio) return { messages: [message], synthesized: false, warning: 'TTS unavailable; preserved original text' }
  // QQ can display only the quote when reply and record are sent together.
  const voice = { ...message, params: { ...message.params, message: [{ type: 'record', data: { file: audio } }] } }
  return { messages: config.keepText ? [voice, message] : [voice], synthesized: true }
}
