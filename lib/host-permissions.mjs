/** Owner-facing controls over the official DSH per-session permission presets. */
export class HostPermissions {
  constructor({ service, sandbox, bindings, liveAgent, resolveAgent }) {
    this.service = service; this.sandbox = sandbox; this.bindings = bindings
    this.liveAgent = liveAgent; this.resolveAgent = resolveAgent
  }
  catalog() {
    const service = this.service()
    if (!service || typeof service.catalog !== 'function' || typeof service.current !== 'function' || typeof service.set !== 'function') return { available: false, options: [], bindings: [] }
    const catalog = service.catalog()
    const options = (catalog?.options ?? []).filter(row => typeof row.value === 'string').map(row => ({ value: row.value, name: String(row.name ?? row.value), ...(typeof row.description === 'string' ? { description: row.description } : {}) }))
    const bindings = this.bindings().map(binding => {
      const agent = this.liveAgent(binding.sessionId)
      if (!agent || agent.id !== binding.sessionId) return { bindingId: binding.id, sessionId: binding.sessionId, available: false }
      try {
        const mode = this.sandbox()?.resolve?.({ session: agent.session })
        return { bindingId: binding.id, sessionId: binding.sessionId, available: true, current: service.current(agent.session), ...(mode ? { sandbox: mode.mode, workspaceRoot: mode.workspaceRoot } : {}) }
      } catch { return { bindingId: binding.id, sessionId: binding.sessionId, available: false } }
    })
    return { available: true, options, bindings }
  }
  async set(bindingId, preset) {
    const service = this.service(), before = this.bindings().find(row => row.id === bindingId)
    if (!before || !service || typeof service.set !== 'function' || typeof service.catalog !== 'function') throw new Error('HOST_PERMISSIONS_UNAVAILABLE')
    if (typeof preset !== 'string' || !service.catalog().options.some(option => option.value === preset)) throw new Error('HOST_PERMISSION_INVALID_PRESET')
    const found = this.liveAgent(before.sessionId) ?? await this.resolveAgent(before.sessionId)
    const agent = found?.agent ?? (found?.error ? undefined : found)
    const after = this.bindings().find(row => row.id === bindingId)
    if (!agent?.session || agent.id !== before.sessionId || this.liveAgent(before.sessionId) !== agent || !after || after.sessionId !== before.sessionId || after.endpoint !== before.endpoint) throw new Error('HOST_PERMISSION_BINDING_CHANGED')
    service.set(agent.session, preset)
    return { bindingId, sessionId: before.sessionId, current: service.current(agent.session) }
  }
}
