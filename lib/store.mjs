import { createHash } from 'node:crypto'
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs'
const encodedKey = /^dshk_[a-f0-9]{64}$/i
const windowsDevice = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
const recallKey = row => diskKey(JSON.stringify([row.origin, row.endpoint, row.messageId]))
const recallFields = ['authorId', 'operatorId', 'authorName', 'excerpt', 'messageTime']
function enrichRecall(previous, next) {
  return Object.fromEntries(recallFields.filter(field => !previous[field] && next[field]).map(field => [field, next[field]]))
}
/** Storage filenames stay bounded even when a QQ or compound key contains punctuation. */
function diskKey(key) {
  if (/^[a-zA-Z0-9_-]{1,128}$/.test(key) && !encodedKey.test(key) && !windowsDevice.test(key)) return key
  return 'dshk_' + createHash('sha256').update(JSON.stringify(key)).digest('hex')
}
/** Stores transport facts only. Session history remains owned by native DSH/IO. */
export class QqDomainStore {
  constructor(domain) { this.domain = domain; this.recallWrites = Promise.resolve() }
  config() { return normalizeConfig(this.domain.global.get()) }
  setConfig(value) { return this.domain.global.set(normalizeConfig(value)) }
  setLegacy(value) { return this.domain.table('migration').put('legacy', { version: 1, value, importedAt: Date.now() }) }
  async ingressReceipt(bindingId, externalMessageId) { return this.domain.table('ingress').get(diskKey(JSON.stringify([bindingId, externalMessageId]))) }
  async recordIngressReceipt(bindingId, externalMessageId, receipt) {
    const table = this.domain.table('ingress'), key = diskKey(JSON.stringify([bindingId, externalMessageId]))
    if (!table.get(key) && table.size >= 10000) throw new Error('Ingress sidecar capacity reached')
    return table.put(key, { version: 1, traceId: receipt.traceId })
  }
  async backpressure(bindingId) { return this.domain.table('backpressure').get(diskKey(bindingId)) }
  async recordBackpressure(bindingId, value) { return this.domain.table('backpressure').put(diskKey(bindingId), value) }
  async asrResult(key) { return this.domain.table('asr').get(diskKey(key)) }
  async recordAsrResult(key, value) {
    const table = this.domain.table('asr'), storedKey = diskKey(key)
    if (!table.get(storedKey) && table.size >= 10000) throw new Error('ASR sidecar capacity reached')
    return table.put(storedKey, value)
  }
  async admissionResult(key) { return this.domain.table('admission').get(diskKey(key)) }
  async recordAdmissionResult(key, value) {
    const table = this.domain.table('admission'), storedKey = diskKey(key)
    if (!table.get(storedKey) && table.size >= 10000) throw new Error('Admission sidecar capacity reached')
    return table.put(storedKey, value)
  }
  async admissionState(bindingId) { return this.domain.table('admission_state').get(diskKey(bindingId)) }
  async recordAdmissionState(bindingId, value) { return this.domain.table('admission_state').put(diskKey(bindingId), value) }
  async gateResult(key) { return this.domain.table('gates').get(diskKey(key)) }
  async recordGateResult(key, value) {
    const table = this.domain.table('gates'), storedKey = diskKey(key)
    if (!table.get(storedKey) && table.size >= 10000) throw new Error('Gate sidecar capacity reached')
    return table.put(storedKey, value)
  }
  async quotaResult(id) { return this.domain.table('quota').get(diskKey(id)) }
  async recordQuotaResult(id, value) { return this.domain.table('quota').put(diskKey(id), { version: 1, ...value }) }
  async modelResult(id) { return this.domain.table('models').get(diskKey(id)) }
  async recordModelResult(id, value) { return this.domain.table('models').put(diskKey(id), { version: 1, ...value }) }
  async messageEndpoint(id) { return this.domain.table('messages').get(diskKey(String(id)))?.endpoint }
  async messageRecord(id) { return this.domain.table('messages').get(diskKey(String(id))) }
  async recordMessage(id, endpoint, fields = {}) {
    const table = this.domain.table('messages'), key = diskKey(String(id)), existing = table.get(key)
    // Conflicting OneBot IDs are not evidence for either chat.
    if (existing && existing.endpoint !== endpoint) return table.put(key, { endpoint: '', ambiguous: true })
    if (!existing && table.size >= 10000) throw new Error('Message sidecar capacity reached')
    return table.put(key, { ...(!fields.origin || existing?.origin === fields.origin ? existing : undefined), ...fields, endpoint })
  }
  recordRecall(value) {
    const operation = this.recallWrites.then(async () => {
      const table = this.domain.table('recalls'), key = recallKey(value), existing = table.get(key)
      if (existing) {
        const extra = enrichRecall(existing, value)
        if (Object.keys(extra).length) await table.put(key, { ...existing, ...extra })
        return
      }
      if (table.size >= 1000) {
        const oldest = [...table.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) await table.delete(oldest[0])
      }
      await table.put(key, value)
    })
    this.recallWrites = operation.catch(() => {})
    return operation
  }
  async recallsFor(endpoint, limit = 20, origin) {
    return [...this.domain.table('recalls').entries()].map(([, value]) => value).filter(row => row.endpoint === endpoint && (!origin || row.origin === origin)).sort((a, b) => b.at - a.at).slice(0, limit)
  }
  showRecall(value) {
    const operation = this.recallWrites.then(async () => {
      const table = this.domain.table('recalls'), key = recallKey(value), row = table.get(key)
      if (row && !row.shown) await table.put(key, { ...row, shown: true })
    })
    this.recallWrites = operation.catch(() => {})
    return operation
  }
  async delivery(key) { return this.domain.table('deliveries').get(diskKey(key)) }
  async recordDelivery(key, value) {
    const table = this.domain.table('deliveries'), storedKey = diskKey(key)
    if (!table.get(storedKey) && table.size >= 10000) throw new Error('Delivery sidecar capacity reached')
    return table.put(storedKey, { version: 1, ...value })
  }
  async outbox(bindingId) { return this.domain.table('outbox').get(diskKey(bindingId)) }
  async recordOutbox(bindingId, value) { return this.domain.table('outbox').put(diskKey(bindingId), value) }
  async pollingState(key) { return this.domain.table('polling').get(diskKey(key)) }
  async recordPollingState(key, value) { return this.domain.table('polling').put(diskKey(key), { version: 1, ...value }) }
  async pollingRun() { return this.domain.table('polling_run').get('state') }
  async recordPollingRun(value) { return this.domain.table('polling_run').put('state', { version: 1, ...value }) }
}
export class MemoryQqStore {
  constructor(config = DEFAULT_CONFIG) { this.value = normalizeConfig(config); this.messages = new Map(); this.messageDetails = new Map(); this.recalls = new Map(); this.deliveries = new Map(); this.outboxes = new Map(); this.models = new Map(); this.quota = new Map(); this.ingress = new Map(); this.asr = new Map(); this.admission = new Map(); this.admissions = new Map(); this.gates = new Map(); this.pressure = new Map(); this.polling = new Map(); this.pollingRunState = undefined }
  config() { return structuredClone(this.value) }
  async setConfig(value) { this.value = normalizeConfig(value) }
  async setLegacy(value) { this.legacy = structuredClone(value) }
  async ingressReceipt(bindingId, externalMessageId) { return this.ingress.get(JSON.stringify([bindingId, externalMessageId])) }
  async recordIngressReceipt(bindingId, externalMessageId, receipt) { this.ingress.set(JSON.stringify([bindingId, externalMessageId]), { traceId: receipt.traceId }) }
  async backpressure(bindingId) { return this.pressure.get(bindingId) }
  async recordBackpressure(bindingId, value) { this.pressure.set(bindingId, structuredClone(value)) }
  async asrResult(key) { return this.asr.get(key) }
  async recordAsrResult(key, value) { this.asr.set(key, structuredClone(value)) }
  async admissionResult(key) { return this.admission.get(key) }
  async recordAdmissionResult(key, value) { this.admission.set(key, structuredClone(value)) }
  async admissionState(bindingId) { return this.admissions.get(bindingId) }
  async recordAdmissionState(bindingId, value) { this.admissions.set(bindingId, structuredClone(value)) }
  async gateResult(key) { return this.gates.get(key) }
  async recordGateResult(key, value) { this.gates.set(key, structuredClone(value)) }
  async quotaResult(id) { return this.quota.get(id) }
  async recordQuotaResult(id, value) { this.quota.set(id, structuredClone(value)) }
  async modelResult(id) { return this.models.get(id) }
  async recordModelResult(id, value) { this.models.set(id, structuredClone(value)) }
  async messageEndpoint(id) { return this.messages.get(id) }
  async messageRecord(id) {
    const endpoint = this.messages.get(id)
    return endpoint === undefined ? undefined : { ...this.messageDetails.get(id), endpoint }
  }
  async recordMessage(id, endpoint, fields = {}) {
    const previous = this.messages.get(id)
    if (this.messages.has(id) && previous !== endpoint) { this.messages.set(id, ''); this.messageDetails.delete(id); return }
    this.messages.set(id, endpoint)
    const existing = this.messageDetails.get(id)
    this.messageDetails.set(id, { ...(!fields.origin || existing?.origin === fields.origin ? existing : undefined), ...fields })
  }
  async recordRecall(value) {
    const key = recallKey(value), previous = this.recalls.get(key)
    this.recalls.set(key, previous ? { ...previous, ...enrichRecall(previous, value) } : structuredClone(value))
  }
  async recallsFor(endpoint, limit = 20, origin) { return [...this.recalls.values()].filter(row => row.endpoint === endpoint && (!origin || row.origin === origin)).sort((a, b) => b.at - a.at).slice(0, limit) }
  async showRecall(value) { const key = recallKey(value), row = this.recalls.get(key); if (row && !row.shown) this.recalls.set(key, { ...row, shown: true }) }
  async delivery(key) { const value = this.deliveries.get(key); return value && structuredClone(value) }
  async recordDelivery(key, value) { this.deliveries.set(key, structuredClone(value)) }
  async outbox(bindingId) { const value = this.outboxes.get(bindingId); return value && structuredClone(value) }
  async recordOutbox(bindingId, value) { this.outboxes.set(bindingId, structuredClone(value)) }
  async pollingState(key) { const value = this.polling.get(key); return value && structuredClone(value) }
  async recordPollingState(key, value) { this.polling.set(key, structuredClone(value)) }
  async pollingRun() { return this.pollingRunState && structuredClone(this.pollingRunState) }
  async recordPollingRun(value) { this.pollingRunState = structuredClone(value) }
}
