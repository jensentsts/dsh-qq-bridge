import { normalizeQuote, parseEndpoint } from './onebot.mjs'

const qqId = value => {
  const text = String(value ?? '')
  return /^(?:[1-9]\d{0,23})$/.test(text) && (typeof value !== 'number' || Number.isSafeInteger(value)) ? text : ''
}
const messageKey = value => {
  const text = String(value ?? '')
  return /^-?\d{1,24}$/.test(text) && (typeof value !== 'number' || Number.isSafeInteger(value)) ? text : ''
}
export const isRecallNotice = value => value?.post_type === 'notice' && ['group_recall', 'friend_recall'].includes(value.notice_type)

export const recallTime = value => {
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 8640000000000 ? seconds * 1000 : undefined
}

export function recallExcerpt(parts) {
  const labels = { image: '图片', record: '语音', video: '视频', file: '文件' }
  const media = (parts.media ?? []).slice(0, 4).map(part => `[${labels[part.type] ?? '附件'}]`)
  if (parts.rich?.length) media.push('[分享或转发]')
  return [parts.text?.trim(), ...media].filter(Boolean).join(' ').slice(0, 320)
}

export function recalledMessage(data, { endpoint, messageId, selfId, knownEndpoint }) {
  if (data?.message_type !== parseEndpoint(endpoint).kind) throw new Error('Recall target kind mismatch')
  const quote = normalizeQuote(data, { endpoint, messageId, selfId, knownEndpoint, maxTextChars: 320, maxMedia: 4 })
  if (!qqId(quote.senderId)) throw new Error('Recall sender ID invalid')
  return { senderId: quote.senderId, senderName: quote.senderName, excerpt: recallExcerpt(quote), time: recallTime(data.time) }
}

export async function recallNotice(value, lookup, allowed) {
  if (!isRecallNotice(value)) return
  const messageId = messageKey(value.message_id), userId = qqId(value.user_id), selfId = qqId(value.self_id)
  if (!messageId || !userId) return
  const group = value.notice_type === 'group_recall'
  const peer = group ? qqId(value.group_id) : userId
  if (!peer || !group && peer === selfId) return
  const endpoint = `${group ? 'group' : 'private'}:${peer}`
  if (!allowed(endpoint, group ? userId : undefined, selfId)) return
  const original = await lookup({ endpoint, messageId, selfId })
  const known = group && original?.senderId && original.senderId !== userId ? undefined : original
  const authorId = group ? userId : known?.senderId || (known?.outbound ? selfId : '')
  if (!allowed(endpoint, authorId, selfId)) return
  const operatorId = group ? qqId(value.operator_id) : authorId
  return {
    endpoint, messageId, authorId, operatorId, at: recallTime(value.time) ?? Date.now(),
    ...(known?.senderName ? { authorName: known.senderName } : {}),
    ...(known?.excerpt ? { excerpt: known.excerpt } : {}),
    ...(known?.time ? { messageTime: known.time } : {}),
  }
}

const chinaTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export function recallText(row) {
  const same = row.operatorId && row.operatorId === row.authorId
  const name = row.authorName?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const author = name && name !== row.authorId ? `${row.authorId} ${name}` : row.authorId
  const action = same ? `${author} 撤回了一条消息` : `${row.operatorId || 'QQ'} 撤回了${author ? ' ' + author + ' 的' : ''}一条消息`
  const excerpt = row.excerpt?.split(/\r\n?|\n/).map(line => '> ' + line).join('\n')
  const sent = row.messageTime ? `，原消息发送于 ${chinaTime.format(row.messageTime)}` : ''
  return `${chinaTime.format(row.at)} ${action}（消息 ${row.messageId}${sent}）${excerpt ? '\n' + excerpt : ''}`
}
