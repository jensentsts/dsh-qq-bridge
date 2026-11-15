import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const worker = fileURLToPath(new URL('./singing-worker.mjs', import.meta.url))

const scoreLengths = { 小星星: [7, 7, 7, 7], 两只老虎: [4, 3, 6, 3], 生日快乐: [6, 6, 7, 6] }
export const soulxMelodies = Object.keys(scoreLengths)

export function createQqSinger({ root, soulxRoot, attachments, render }) {
  let busy = false
  const clips = new Map()
  async function renderCover(request) {
    const { stdout } = await run(process.execPath, ['--use-env-proxy', worker, root, request.keyword, String(request.seconds), ...(request.start === undefined ? [] : [String(request.start)])],
      { windowsHide: true, maxBuffer: 64 * 1024 })
    const clip = JSON.parse(stdout)
    const directory = await realpath(clip.directory)
    const file = await realpath(clip.mp3Path)
    const within = relative(directory, file)
    if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('COVER_FILE_OUTSIDE_CACHE')
    const info = await stat(file)
    if (!info.isFile() || !info.size || info.size > 8 * 1024 * 1024) throw new Error('COVER_FILE_SIZE')
    return readFile(file)
  }
  async function renderSoulx(melody, lyrics, signal, score) {
    const audioDir = join(soulxRoot, 'audio')
    await mkdir(audioDir, { recursive: true })
    const directory = await mkdtemp(join(audioDir, '.qq-soulx-'))
    try {
      const file = join(directory, 'sing.wav')
      const python = join(root, 'venv312', 'Scripts', 'python.exe')
      await run(python, [join(soulxRoot, 'render_preview.py'), '--melody', melody, '--lyrics', lyrics ?? '', '--output', file, ...(score ? ['--score', JSON.stringify(score)] : [])], {
        windowsHide: true, maxBuffer: 64 * 1024, signal, timeout: 180000,
        env: { ...process.env, PYTHONPATH: join(soulxRoot, 'deps'), HF_HOME: join(soulxRoot, 'hf-cache'), HF_HUB_OFFLINE: '1', PYTHONUTF8: '1' },
      })
      const info = await stat(file)
      if (!info.isFile() || info.size <= 44 || info.size > 8 * 1024 * 1024) throw new Error('SOULX_FILE_SIZE')
      return await readFile(file)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  return {
    soulx: !!soulxRoot,
    async timing(title, { signal, permitted }) {
      if (!permitted() || signal.aborted) return { ok: false, code: 'QQ_TURN_REQUIRED' }
      if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\r\n\0]/u.test(title)) return { ok: false, code: 'INVALID_SONG' }
      try {
        const { stdout } = await run(process.execPath, ['--use-env-proxy', worker, root, title.trim(), 'timing'],
          { windowsHide: true, maxBuffer: 64 * 1024, timeout: 90000, signal })
        if (!permitted() || signal.aborted) return { ok: false, code: 'TURN_CHANGED' }
        return JSON.parse(stdout)
      } catch { return { ok: false, code: signal.aborted ? 'TURN_CHANGED' : 'SONG_TIMING_FAILED' } }
    },
    attachment(sessionId, path) {
      const entry = clips.get(path)
      return entry?.sessionId === sessionId ? entry.block : undefined
    },
    async sing(title, seconds, { agent, signal, permitted, lyrics, start, score }) {
      if (!permitted() || signal.aborted) return { ok: false, code: 'QQ_TURN_REQUIRED' }
      if (typeof title !== 'string' || !title.trim() || title.length > 80 || /[\r\n\0]/u.test(title)) return { ok: false, code: 'INVALID_SONG' }
      const local = lyrics !== undefined || score !== undefined
      if (score !== undefined) {
        if (!soulxRoot) return { ok: false, code: 'SOULX_UNAVAILABLE' }
        if (!score || !Number.isInteger(score.bpm) || score.bpm < 60 || score.bpm > 180 || !Array.isArray(score.lines) || score.lines.length < 1 || score.lines.length > 8) return { ok: false, code: 'INVALID_SCORE' }
        let totalBeats = 0
        for (const line of score.lines) {
          if (typeof line.text !== 'string' || !/^\p{Script=Han}{1,16}$/u.test(line.text) || !Array.isArray(line.notes) || line.notes.length !== [...line.text].length) return { ok: false, code: 'INVALID_SCORE' }
          let lineBeats = 0
          for (const note of line.notes) {
            if (!Number.isInteger(note?.pitch) || note.pitch < 48 || note.pitch > 84 || !Number.isFinite(note.beats) || note.beats < 0.25 || note.beats > 4) return { ok: false, code: 'INVALID_SCORE' }
            lineBeats += note.beats
          }
          if (lineBeats * 60 / score.bpm > 8) return { ok: false, code: 'INVALID_SCORE' }
          totalBeats += lineBeats
        }
        if (totalBeats * 60 / score.bpm > 50) return { ok: false, code: 'INVALID_SCORE' }
      } else if (local) {
        const lengths = Object.hasOwn(scoreLengths, title) ? scoreLengths[title] : undefined
        if (!soulxRoot) return { ok: false, code: 'SOULX_UNAVAILABLE' }
        if (!lengths || typeof lyrics !== 'string' || !/^\p{Script=Han}+(\/\p{Script=Han}+){3}$/u.test(lyrics)
          || !lyrics.split('/').every((line, index) => [...line].length === lengths[index])) return { ok: false, code: 'INVALID_SCORE_LYRICS' }
      } else if (!Number.isInteger(seconds) || seconds < 8 || seconds > 30) return { ok: false, code: 'INVALID_SONG' }
      if (start !== undefined && (!Number.isFinite(start) || start < 0 || start > 86400 || local)) return { ok: false, code: 'INVALID_START' }
      if (busy) return { ok: false, code: 'COVER_BUSY' }
      busy = true
      try {
        const data = local ? await renderSoulx(title, lyrics, signal, score)
          : await (render ?? renderCover)({ keyword: title.trim(), mode: 'cover', seconds, ...(start === undefined ? {} : { start }) })
        if (signal.aborted || !permitted()) return { ok: false, code: 'TURN_CHANGED' }
        const name = local ? 'qq-soulx-' + randomUUID() + '.wav' : 'qq-cover-' + randomUUID() + '.mp3'
        const attachment = await attachments.saveFile({ data, name })
        if (signal.aborted || !permitted()) return { ok: false, code: 'TURN_CHANGED' }
        if (clips.size >= 64) clips.delete(clips.keys().next().value)
        clips.set(name, { sessionId: agent.id, block: { type: 'file', attachment } })
        return { ok: true, link: '[' + (local ? '大肥鱼清唱' : '大肥鱼翻唱') + '](' + name + ')' }
      } catch {
        return { ok: false, code: signal.aborted ? 'TURN_CHANGED' : local ? 'SOULX_FAILED' : 'COVER_FAILED' }
      } finally { busy = false }
    },
  }
}
