import { spawnSync } from 'node:child_process'
const suite = spawnSync(process.execPath, ['--test', 'tests/adapter.test.mjs', 'tests/routes.test.mjs', 'tests/client.test.mjs', 'tests/io-e2e.test.mjs', 'tests/client-dom.test.mjs', 'tests/model-policy.test.mjs', 'tests/quota-policy.test.mjs', 'tests/package-invariants.test.mjs', 'tests/second-increment.test.mjs', 'tests/polling-merge.test.mjs', 'tests/history-tool.test.mjs', 'tests/recall.test.mjs', 'tests/status.test.mjs', 'tests/line-splitting.test.mjs', 'tests/group-album.test.mjs', 'tests/outbox.test.mjs'], { stdio: 'inherit' })
if (suite.status !== 0) process.exit(suite.status || 1)
const legacy = spawnSync(process.execPath, ['tests/inbound-steer.mjs'], { stdio: 'inherit' })
process.exit(legacy.status || 0)
