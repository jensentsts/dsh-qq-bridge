import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '..'), installed = process.env.DSH_QQ_LINK_BASELINE || ''
const read = name => readFileSync(resolve(root, name), 'utf8')
test('fork keeps exact full LICENSE, author and first-screen source attribution', () => {
  if (installed) assert.equal(read('LICENSE'), readFileSync(resolve(installed, 'LICENSE'), 'utf8'))
  const packageJson = JSON.parse(read('package.json')), first = read('README.md').slice(0, 1200)
  assert.equal(packageJson.name, 'dsh-qq-bridge'); assert.equal(packageJson.version, '0.0.1'); assert.match(packageJson.author, /Yuuyuko-uu/); assert.match(packageJson.license, /LICENSE/)
  assert.match(first, /派生自 https:\/\/github.com\/Yuuyuko-uu\/dsh-qq-link/); assert.match(first, /原作者 Yuuyuko-uu/)
})
test('baseline hashes are independently rechecked, installed voice and exact-Agent Qzone dedupe survived targeted merge', { skip: !installed }, () => {
  const provenance = JSON.parse(read('PROVENANCE.json'))
  for (const [path, expected] of Object.entries(provenance.baseline.sha256)) assert.equal(createHash('sha256').update(readFileSync(resolve(installed, path))).digest('hex'), expected)
  const legacy = read('lib/legacy-host.js')
  assert.match(legacy, /VOICE OUTBOUND PATCH/); assert.match(legacy, /已挂\.agent === agent/); assert.match(legacy, /await agent\.steer\(消息\)/)
  assert.match(legacy, /Legacy entry disabled; explicit mock harness required/)
})
test('both Client graphs and production Host contain no selfupdate import/register, update/install UI or original identity reuse', () => {
  const client = read('lib/client.js'), old = read('legacy/client.js'), host = read('lib/host.js'), legacy = read('lib/legacy-host.js')
  for (const value of [client, old, host, legacy]) assert.doesNotMatch(value, /createSelfUpdate|import\s+.*selfupdate|(?:get|post)\('\/(?:update|install)(?:[?'\/]|')/)
  assert.doesNotMatch(old, /更新页|设更新忙|查更新/)
  assert.match(client, /id: 'dsh-qq-bridge'/); assert.match(host, /name = 'qq-bridge-001'/)
  assert.equal(JSON.parse(read('package.json')).exports['./legacy'], undefined)
})
test('new JavaScript and metadata files are UTF-8 with final newline and all package resources exist', () => {
  const manifest = JSON.parse(read('package.json'))
  for (const path of ['lib/host.js', 'lib/client.js', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'cordis.patch.yml', 'LICENSE', 'PROVENANCE.json']) assert.equal(statSync(resolve(root, path)).isFile(), true)
  for (const path of readdirSync(resolve(root, 'lib')).filter(path => path !== 'legacy-host.js')) {
    const content = read('lib/' + path)
    assert.ok(content.endsWith('\n'), path); assert.doesNotMatch(content, /[ \t]+\n/, path)
  }
})
