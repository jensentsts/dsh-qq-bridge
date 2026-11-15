// Input-status notices are ephemeral; keep the reported data rather than
// guessing the meaning of protocol-specific event_type values.
export function isPeerTypingEvent(event) {
  return event?.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'input_status'
}

export function peerTypingNotice(event, now = Date.now()) {
  if (!isPeerTypingEvent(event)) return undefined
  if (event.group_id !== undefined && String(event.group_id) !== '0') return undefined
  const validId = id => (typeof id === 'string' && /^[1-9]\d{0,23}$/.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
  if (!validId(event.user_id) || !validId(event.self_id) || String(event.user_id) === String(event.self_id)) return undefined
  const eventType = Number(event.event_type)
  if (!Number.isSafeInteger(eventType) || eventType < 0 || eventType > 255) return undefined
  const statusText = typeof event.status_text === 'string' ? event.status_text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : ''
  return { endpoint: 'private:' + String(event.user_id), userId: String(event.user_id), eventType, statusText, observedAt: now, expiresAt: now + 8000 }
}
