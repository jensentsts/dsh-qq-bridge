/** Plain-ESM artifact build. Runtime JavaScript is already authored under lib; no install or profile mutation. */
import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = import.meta.dirname, out = resolve(root, 'dist')
async function copyTree(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(join(source, entry.name), join(target, entry.name))
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name))
  }
}
await mkdir(out, { recursive: true })
for (const directory of ['lib', 'locale', 'legacy', 'tools']) await copyTree(join(root, directory), join(out, directory))
for (const file of ['icon.svg', 'cordis.patch.yml', 'README.md', 'README-HISTORY.md', 'LICENSE', 'PROVENANCE.json', 'SECOND-INCREMENT.md']) await copyFile(join(root, file), join(out, file))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
delete manifest.scripts
await writeFile(join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('Built dsh-qq-bridge@0.0.1 plain-ESM package: ' + out)
