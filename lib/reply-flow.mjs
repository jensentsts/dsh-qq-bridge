import { setTimeout as wait } from 'node:timers/promises'

const contextKinds = new Set(['runtime-context', 'time-context', 'agent-instructions', 'skill-catalog', 'system-prompt', 'session-reference', 'repeat-tool-reminder', 'working-directory', 'model-selection'])

/** Identify an active QQ-group conversation while keeping local proactive sends independent. */
export function isQqGroupTurn(bridge, scope) {
  if (!scope.target.endpoint.startsWith('group:') || scope.target.sessionId !== scope.agent?.id) return false
  try {
    const facts = bridge.nativeFeatures?.projection?.stateOf(scope.agent.session)
    return !!(facts?.active && facts.bindingId === scope.target.id && facts.turn === scope.anchor.reply.turn && facts.inputs?.length)
  } catch { return false }
}

/** The native inbox and bridge ingress are the owners of pending messages. */
export function pendingGroupInput(bridge, scope) {
  let known = new Set()
  try { known = new Set(bridge.nativeFeatures?.projection?.stateOf(scope.agent.session)?.inputs ?? []) } catch {}
  const inbox = scope.agent.inbox
  const nextStep = (inbox?.nextStep ?? []).filter(message => !contextKinds.has(message.source?.kind))
  const nextTurn = (inbox?.nextTurn ?? []).filter(message => {
    if (message.source?.kind !== 'super-agent-io' || message.source.bindingId !== scope.target.id) return false
    try {
      const receipt = bridge.io.receipt?.(message.source.traceId)
      return receipt?.requestedMode === 'steer' || receipt?.requestedMode === 'auto'
    } catch { return false }
  })
  const state = bridge.merger?.states?.get(scope.target.id)
  const ingress = new Set()
  for (const item of state?.events ?? []) if (!known.has(item.event.externalMessageId)) ingress.add(item.event.externalMessageId)
  for (const id of state?.inFlight ?? []) if (!known.has(id)) ingress.add(id)
  return { nextStep: nextStep.length, nextTurn: nextTurn.length, receiving: ingress.size }
}

/** Leave a brief quiet interval for a completed thought or picture to arrive. */
export async function checkReplyFlow(bridge, scope, signal, { allowPending = false } = {}) {
  if (!isQqGroupTurn(bridge, scope)) return undefined
  const delay = Math.max(allowPending ? 0 : bridge.config.replyQuietMs ?? 1200, await bridge.admission.sendDelay(scope.target))
  const deadline = performance.now() + delay
  while (true) {
    scope.guard()
    const pending = pendingGroupInput(bridge, scope)
    if (!allowPending && (pending.nextStep || pending.nextTurn || pending.receiving)) return pending
    const remaining = deadline - performance.now()
    if (remaining <= 0) return undefined
    await wait(Math.min(200, remaining), undefined, signal ? { signal } : undefined)
  }
}
