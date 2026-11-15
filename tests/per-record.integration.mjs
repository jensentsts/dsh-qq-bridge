import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import storagePlugin from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import { domainSpec as ioSpec } from '../../dsh-super-agent-io/domain.mjs'
import { DomainStore } from '../../dsh-super-agent-io/store.mjs'
import { identityKey, normalizeBinding } from '../../dsh-super-agent-io/contract.mjs'
import { domainSpec as qqSpec } from '../lib/host.js'
import { QqDomainStore } from '../lib/store.mjs'

test('QQ binding and receipt keys round-trip through the native per-record JSON backend', async () => {
  const temporary = await realpath(import.meta.dirname)
  const root = await mkdtemp(join(temporary, '.dsh-qq-records-'))
  const ctx = new Context()
  try {
    await ctx.plugin(storagePlugin)
    await ctx.plugin(storageJson, { root })
    await ctx.plugin(storageDomain, { backend: 'json' })
    const io = new DomainStore(await ctx.storageDomain.open(ioSpec), ioSpec)
    const binding = normalizeBinding({ id: 'qq-bridge-001:group:123456:session-test', transport: 'qq-bridge-001', sessionId: 'session-test', endpoint: 'group:123456', enabled: true })
    const audit = { version: 1, kind: 'binding', id: binding.id, state: 'enabled', at: 100, bindingId: binding.id, sessionId: binding.sessionId }
    const auditKey = identityKey(audit.kind, audit.id, audit.state)
    await io.domain.table('bindings').put('legacy-safe-id', { ...binding, id: 'legacy-safe-id' })
    await io.put('bindings', binding.id, binding)
    await io.put('audit', auditKey, audit)
    await io.close()

    const restoredIo = new DomainStore(await ctx.storageDomain.open(ioSpec), ioSpec)
    assert.deepEqual(restoredIo.get('bindings', binding.id), binding)
    assert.equal(restoredIo.get('bindings', 'legacy-safe-id').id, 'legacy-safe-id')
    assert.deepEqual(restoredIo.entries('audit'), [[auditKey, audit]])
    await restoredIo.close()

    const qq = new QqDomainStore(await ctx.storageDomain.open(qqSpec))
    const message = 'qq:message/123'
    await qq.recordIngressReceipt(binding.id, message, { traceId: 'trace-1' })
    await qq.recordMessage(message, binding.endpoint)
    await qq.recordPollingState(binding.id, { watermark: 200, enabledAt: 100 })
    const origin = 'http://127.0.0.1:3000'
    const recall = { origin, endpoint: binding.endpoint, messageId: '-42', authorId: '123', operatorId: '456', at: 300, excerpt: '原句', messageTime: 250 }
    await qq.recordMessage(recall.messageId, recall.endpoint, { origin, senderId: recall.authorId, excerpt: recall.excerpt, time: recall.messageTime })
    await Promise.all([qq.recordRecall(recall), qq.recordRecall({ ...recall, authorName: '原作者' })])
    await qq.showRecall(recall)
    await qq.domain.close()
    const restoredQq = new QqDomainStore(await ctx.storageDomain.open(qqSpec))
    assert.deepEqual(await restoredQq.ingressReceipt(binding.id, message), { version: 1, traceId: 'trace-1' })
    assert.equal(await restoredQq.messageEndpoint(message), binding.endpoint)
    assert.equal((await restoredQq.pollingState(binding.id)).watermark, 200)
    assert.equal((await restoredQq.messageRecord(recall.messageId)).excerpt, '原句')
    assert.deepEqual(await restoredQq.recallsFor(recall.endpoint, 20, origin), [{ ...recall, authorName: '原作者', shown: true }])
    await restoredQq.domain.close()
  } finally {
    await ctx.fiber.dispose()
    const resolved = await realpath(root)
    if (dirname(resolved) === temporary) await rm(resolved, { recursive: true, force: true })
  }
})
