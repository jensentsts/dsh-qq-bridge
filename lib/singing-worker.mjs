import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, keyword, seconds, start] = process.argv.slice(2)
const engine = join(root, 'qqmusic')
const { resolveSettings } = await import(pathToFileURL(join(engine, 'index.mjs')).href)
const { renderSinging } = await import(pathToFileURL(join(engine, 'src', 'singing.mjs')).href)
const settings = resolveSettings({ rvcRoot: root, model: 'DaFeiYu', authEnabled: false, fallbackToOriginal: false })
process.env.PATH = settings.applioDir + delimiter + (process.env.PATH ?? '')
if (seconds === 'timing') {
  const { searchSongs, rankCandidates, matchScore, downloadSong, fetchLyric } = await import(pathToFileURL(join(engine, 'src', 'qqmusic.mjs')).href)
  const songs = rankCandidates(await searchSongs(keyword, settings.searchLimit), keyword).slice(0, settings.maxCandidates)
  if (!songs.length || matchScore(keyword, songs[0]) < settings.minMatchScore) throw new Error('SONG_NOT_FOUND')
  let picked
  for (const song of songs) {
    try { await downloadSong(song, join(settings.workDir, song.mid.replace(/[^a-zA-Z0-9_-]/g, '')), () => {}); picked = song; break } catch {}
  }
  if (!picked) throw new Error('SONG_UNAVAILABLE')
  const lyric = await fetchLyric(picked.mid)
  const lines = [...lyric.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]([^\r\n]*)/g)]
    .filter(match => match[3].trim()).map(match => ({ time: Number(match[1]) * 60 + Number(match[2]), text: match[3].trim().slice(0, 150) })).slice(0, 100)
  process.stdout.write(JSON.stringify({ ok: true, title: picked.title, artist: picked.artist, duration: picked.interval, lines }))
  process.exit(0)
}
const clip = await renderSinging({ keyword, mode: 'cover', seconds: Number(seconds), ...(start !== undefined ? { start: Number(start) } : {}) }, settings, () => {})
if (clip.model !== 'DaFeiYu' || !clip.mp3Path) throw new Error('DaFeiYu cover audio was not generated')
process.stdout.write(JSON.stringify({ mp3Path: clip.mp3Path, directory: settings.workDir }))
