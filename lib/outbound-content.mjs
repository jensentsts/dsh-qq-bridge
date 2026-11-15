import { fileURLToPath } from 'node:url'
import { extname } from 'node:path'

const audioExtensions = new Set(['.amr', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.silk', '.wav'])
export const isVoiceFile = name => typeof name === 'string' && audioExtensions.has(extname(name).toLowerCase())
const linkStart = /(!?)\[(?:\\.|[^\]\\\r\n])*\]\(/y
const memeMarker = /\[表情\s*[:：]\s*([^\]\r\n]*)\](?:\(https?:\/\/[^\s)]+\))?/y
const mentionToken = /@([1-9]\d{0,23})(?![\w/@]|\.[A-Za-z0-9])/y
const bareUrl = /(?:https?:\/\/|www\.)[^\s<>"']+/iy

function readLink(text, start) {
  linkStart.lastIndex = start
  const match = linkStart.exec(text)
  if (!match) return
  const begin = linkStart.lastIndex
  let depth = 0, angle = text[begin] === '<'
  for (let end = begin; end < text.length; end++) {
    const char = text[end]
    if (char === '\n' || char === '\r') return
    if (char === '\\' && /[()[\]<>]/.test(text[end + 1] ?? '')) { end++; continue }
    if (angle) { if (char === '>') angle = false; continue }
    if (char === '(') depth++
    if (char !== ')') continue
    if (depth) { depth--; continue }
    const destination = text.slice(begin, end).trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, '')
    const value = destination.replace(/^<(.*)>$/, '$1').replace(/\\([()[\]<>])/g, '$1')
    return { end: end + 1, image: match[1] === '!', value }
  }
}

function resourceOf(link) {
  const { value, image } = link
  if (!value || value.startsWith('#')) return
  if (/^https?:\/\//i.test(value)) {
    const url = URL.parse(value)
    if (url && (image || isVoiceFile(url.pathname))) return { url: url.href, image }
    return
  }
  if (value.includes('#') || /:\d+(?::\d+|-\d+)?$/.test(value)) return
  try {
    const file = /^file:/i.test(value) ? fileURLToPath(value) : decodeURIComponent(value)
    if (!file || /[\x00-\x1f\x7f?]/.test(file) || /[\\/]$/.test(file)) return
    if (!/^[a-z]:[\\/]/i.test(file) && /^[a-z][a-z\d+.-]*:/i.test(file)) return
    if (!image && !/[\\/]/.test(file) && !extname(file)) return
    return { path: file, image }
  } catch { return }
}

function inlineCodeEnd(text, start) {
  const ticks = /`+/g
  ticks.lastIndex = start
  const opening = ticks.exec(text)
  for (let next; (next = ticks.exec(text));) {
    if (next[0].length === opening[0].length) return ticks.lastIndex
  }
  return start + opening[0].length
}

/** Only complete public text is examined. Code examples and ordinary links keep their literal content. */
export function outboundParts(text, { groupMentions = false } = {}) {
  const parts = []
  let fence, start = 0
  for (let index = 0; index < text.length;) {
    if (index === 0 || text[index - 1] === '\n') {
      const nextLine = text.indexOf('\n', index)
      const lineEnd = nextLine < 0 ? text.length : nextLine + 1
      const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(text.slice(index, lineEnd))
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
        index = lineEnd
        continue
      }
      if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
        fence = marker[1]
        index = lineEnd
        continue
      }
      if (/^(?: {4}|\t)/.test(text.slice(index, lineEnd))) { index = lineEnd; continue }
    }
    if (text[index] === '\\') { index += 2; continue }
    if (text[index] === '`') { index = inlineCodeEnd(text, index); continue }
    if (!groupMentions && text[index] === '[') {
      memeMarker.lastIndex = index
      const meme = memeMarker.exec(text)
      if (meme) {
        if (index > start) parts.push({ type: 'text', text: text.slice(start, index) })
        parts.push({ type: 'meme', caption: meme[1].trim() })
        start = index = memeMarker.lastIndex
        continue
      }
    }
    const link = (text[index] === '[' || text[index] === '!') ? readLink(text, index) : undefined
    if (link) {
      const resource = groupMentions ? undefined : resourceOf(link)
      if (resource) {
        if (index > start) parts.push({ type: 'text', text: text.slice(start, index) })
        parts.push({ type: 'resource', ...resource, original: text.slice(index, link.end) })
        start = link.end
      }
      index = link.end
      continue
    }
    if (groupMentions) {
      bareUrl.lastIndex = index
      if (bareUrl.test(text)) { index = bareUrl.lastIndex; continue }
      if (text[index] === '@' && !/[\w/.:@?&=]/.test(text[index - 1] ?? '')) {
        mentionToken.lastIndex = index
        const mention = mentionToken.exec(text)
        if (mention) {
          if (index > start) parts.push({ type: 'text', text: text.slice(start, index) })
          parts.push({ type: 'at', qq: mention[1] })
          start = index = mentionToken.lastIndex
          continue
        }
      }
    }
    const tag = !groupMentions && text[index] === '[' && /^\[\/?QQ\]/i.exec(text.slice(index, index + 5))
    if (tag) {
      if (index > start) parts.push({ type: 'text', text: text.slice(start, index) })
      index += tag[0].length
      start = index
      continue
    }
    index++
  }
  if (start < text.length) parts.push({ type: 'text', text: text.slice(start) })
  return parts
}

/** Convert text mentions after resource resolution and preserve existing QQ segments. */
export function withGroupMentions(message) {
  if (message?.action !== 'send_group_msg') return message
  let changed = false
  const segments = message.params.message.flatMap(segment => {
    if (segment.type !== 'text') return [segment]
    const parts = outboundParts(segment.data.text, { groupMentions: true })
    if (!parts.some(part => part.type === 'at')) return [segment]
    changed = true
    return parts.map(part => part.type === 'at' ? { type: 'at', data: { qq: part.qq } } : { type: 'text', data: { text: part.text } })
  })
  return changed ? { ...message, params: { ...message.params, message: segments } } : message
}

export async function prepareOutboundContent(content, { resolveResource, resolveMeme, onMemeUnavailable, maxMedia, signal }) {
  const output = [], memeFiles = []
  let mediaCount = 0, omitted = false, mediaError = false, pendingText = ''
  const appendText = text => {
    if (!text) return
    if (output.at(-1)?.type === 'text') output.at(-1).text += text
    else output.push({ type: 'text', text })
  }
  const flushText = async () => {
    for (const part of outboundParts(pendingText)) {
      if (part.type === 'text') { appendText(part.text); continue }
      if (part.type === 'meme') {
        if (mediaCount < maxMedia) {
          mediaCount++
          try {
            const file = await resolveMeme?.(part.caption)
            if (file) { memeFiles.push(file); continue }
          } catch {
            signal?.throwIfAborted()
          }
        }
        mediaError = true
        onMemeUnavailable?.()
        continue
      }
      if (!resolveResource) { mediaError = true; appendText(part.original); continue }
      if (mediaCount >= maxMedia) { omitted = true; continue }
      mediaCount++
      try { output.push(await resolveResource(part)) }
      catch {
        signal?.throwIfAborted()
        mediaError = true
        appendText(part.original + '\n[附件未发送]')
      }
    }
    pendingText = ''
  }
  for (const block of content) {
    if (block.type === 'text') { pendingText += block.text; continue }
    await flushText()
    if (block.type !== 'image' && block.type !== 'file') continue
    if (mediaCount >= maxMedia) { omitted = true; continue }
    mediaCount++
    output.push(block)
  }
  await flushText()
  if (omitted) appendText('\n[其余附件超出此消息的媒体上限]')
  return { content: output, memeFiles, mediaError: mediaError || omitted }
}
