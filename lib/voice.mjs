// Port of installed dsh-qq-link 1.5.4 VOICE OUTBOUND PATCH (Yuuyuko-uu package).
// The full baseline remains in legacy-host.js; this function preserves its mmx text-file/voice/model flow.
import { mkdir, writeFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
export function createVoiceSynthesizer({ cacheDir, mmxEntry, nodePath = process.execPath, spawn: spawnFn = spawn }) {
  return async function synthesize(text, config, { signal } = {}) {
    const limit = Math.max(60, Math.min(Number(config.maxChars) || 600, 3000))
    // Do not silently truncate spoken content. Return text fallback when it cannot fit.
    if (!config.enabled || !String(text).trim() || text.length > limit || signal?.aborted) return ''
    if (!mmxEntry) return ''
    try { await stat(mmxEntry) } catch { return '' }
    await mkdir(cacheDir, { recursive: true })
    const name = 'v-' + randomUUID(), draft = join(cacheDir, name + '.txt'), audio = join(cacheDir, name + '.mp3')
    await writeFile(draft, text, 'utf8')
    try {
      const success = await new Promise(resolve => {
        let child, timer, settled = false
        const done = value => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value) }
        const abort = () => { try { child?.kill() } catch { /* Already exited. */ } done(false) }
        try {
          child = spawnFn(nodePath, [mmxEntry, 'speech', 'synthesize', '--text-file', draft, '--voice', config.voice || 'female-shaonv', '--model', config.model || 'speech-2.8-turbo', '--format', 'mp3', '--out', audio], { windowsHide: true, stdio: 'ignore' })
          child.once('exit', code => done(code === 0)); child.once('error', () => done(false))
          timer = setTimeout(abort, 60000); timer.unref?.(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
        } catch { done(false) }
      })
      if (!success || !(await stat(audio)).size) return ''
      return pathToFileURL(audio).href
    } finally { await unlink(draft).catch(() => {}) }
  }
}
