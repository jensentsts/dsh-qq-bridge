import { extname, isAbsolute, relative, sep, win32 } from 'node:path'
import { open, realpath } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { pathToFileURL } from 'node:url'
import { boundedBytes, combineSignal } from './onebot-http.mjs'
import { isVoiceFile } from './outbound-content.mjs'
import { parseEndpoint } from './onebot.mjs'
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const imageTypeByExtension = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']])
const memeCaptionKey = value => String(value ?? '').replace(/[“”‘’「」『』«»"'\s]/g, '')

async function indexedMemeFile(service, caption, maxBytes, signal) {
  const key = memeCaptionKey(caption)
  if (!key || caption.length > 200 || service?.contractVersion !== 1) return
  signal?.throwIfAborted()
  const result = await service.search({ query: caption, limit: 30 })
  const matches = new Map()
  for (const candidate of result?.memes ?? []) {
    if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path)) continue
    const description = String(candidate.caption ?? '')
    const forms = [description, description.slice(0, 80), description.slice(0, 100), win32.basename(candidate.path)]
    if (forms.some(form => memeCaptionKey(form) === key)) matches.set(candidate.path, candidate)
  }
  if (matches.size !== 1) return
  const [candidate] = matches.values()
  const pack = (await service.packs()).find(row => row.id === candidate.pack)
  if (!pack?.path || !isAbsolute(pack.path)) return
  const [root, target] = await Promise.all([realpath(pack.path), realpath(candidate.path)])
  const inside = relative(root, target)
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) return
  if (!imageTypeByExtension.has(extname(target).toLowerCase())) return
  const handle = await open(target, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return
    const data = Buffer.alloc(info.size)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    signal?.throwIfAborted()
    if (bytesRead === data.length) return 'base64://' + data.toString('base64')
  } finally {
    await handle.close()
  }
}
/** Only explicit HTTPS/HTTP origins; no local paths, credentials, redirects or ambient file reads. */
export function admittedMediaUrl(value, config) {
  const url = new URL(String(value))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || !config.mediaOrigins.includes(url.origin)) throw new Error('MEDIA_ORIGIN_DENIED')
  return url.href
}
function admittedInlineImageUrl(value, config) {
  const url = new URL(String(value))
  // QQ's bot-card image CDN is used by Markdown/preview images in received messages.
  if (url.origin === 'https://qqbot.ugcimg.cn' && !url.username && !url.password && !url.hash) return url.href
  return admittedMediaUrl(value, config)
}
function publicIpv4(host) {
  if (!isIPv4(host)) return false
  const [a, b, c] = host.split('.').map(Number)
  return a > 0 && a < 224 && a !== 10 && a !== 127 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)) &&
    !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
    !(a === 203 && b === 0 && c === 113)
}

function admittedOneBotFileUrl(value, config, peer) {
  try { return admittedMediaUrl(value, config) } catch { /* Resolve the local QQ backend's signed download format below. */ }
  const url = new URL(value)
  const base = new URL(config.baseUrl)
  const localBackend = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  const qqHost = /(?:^|\.)qq\.com(?:\.cn)?$/i.test(url.hostname)
  const qqDownload = peer.kind === 'group'
    ? url.protocol === 'https:' && /^\/ftn_handler\/[a-f\d]+\/$/i.test(url.pathname)
    : ['http:', 'https:'].includes(url.protocol) && url.searchParams.get('isthumb') === '0'
  if (!localBackend || !qqDownload || url.username || url.password || url.hash || !(qqHost || publicIpv4(url.hostname))) throw new Error('MEDIA_ORIGIN_DENIED')
  return url.href
}
export function createMediaAdapter({ attachments, workspace, memeService, singing, fetch: fetchFn = globalThis.fetch }) {
  const saveImage = async input => {
    if (['image/gif', 'image/webp'].includes(input.mediaType) && typeof attachments.saveImages === 'function') {
      const [ref] = await attachments.saveImages([input])
      return ref
    }
    return attachments.saveImage(input)
  }
  return {
    exportMeme(caption, { signal, config }) {
      return indexedMemeFile(memeService?.(), caption, config.maxMediaBytes, signal)
    },
    async admit(part, { signal, config, endpoint, onebot }) {
      if (!attachments) throw new Error('ATTACHMENTS_UNAVAILABLE')
      const file = part.type !== 'image', maxBytes = file ? config.maxFileBytes : config.maxMediaBytes
      if (part.bytes > maxBytes) throw new Error('MEDIA_TOO_LARGE')
      let url
      try { url = part.type === 'image' && part.inlineMarkdown ? admittedInlineImageUrl(part.url, config) : admittedMediaUrl(part.url, config) }
      catch (error) {
        const request = { signal, timeoutMs: 5000, maxBytes: 16384 }
        if (part.type === 'file' && part.fileId) {
          const peer = parseEndpoint(endpoint)
          const result = peer.kind === 'group'
            ? await onebot.call('get_group_file_url', { group_id: peer.id, file_id: part.fileId, ...(part.busId ? { busid: part.busId } : {}) }, request)
            : await onebot.call('get_private_file_url', { user_id: peer.id, file_id: part.fileId, ...(part.fileHash ? { file_hash: part.fileHash } : {}) }, request)
          url = admittedOneBotFileUrl(result?.url, config, peer)
        } else if (!part.url && part.type === 'image' && (part.file || part.fileId)) {
          const result = await onebot.call('get_image', { file: part.file || part.fileId }, request)
          url = admittedMediaUrl(result?.url, config)
        } else throw error
      }
      const combined = combineSignal(signal, 15000)
      const response = await fetchFn(url, { signal: combined, redirect: 'error' })
      if (!response.ok) throw new Error('MEDIA_HTTP_FAILED')
      const bytes = await boundedBytes(response, maxBytes, combined)
      const mediaType = (response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase()
      if (!file) {
        if (!imageTypes.has(mediaType)) throw new Error('UNSUPPORTED_IMAGE_TYPE')
        return { type: 'image', attachment: await saveImage({ data: bytes, mediaType, ...(part.name ? { name: part.name } : {}) }) }
      }
      const name = (part.name || (part.type === 'record' ? 'qq-voice.audio' : part.type === 'video' ? 'qq-video.bin' : 'qq-file')).replace(/[\\/\x00-\x1f]/g, '_')
      return { type: 'file', attachment: await attachments.saveFile({ data: bytes, name }) }
    },
    async resolveOutbound(resource, { signal, config, sessionId }) {
      const cover = resource.path && singing?.attachment(sessionId, resource.path)
      if (cover) return cover
      if (!attachments) throw new Error('ATTACHMENTS_UNAVAILABLE')
      const destination = resource.path ?? new URL(resource.url).pathname
      const name = win32.basename(destination) || (resource.image ? 'image' : 'attachment')
      let mediaType = imageTypeByExtension.get(extname(name).toLowerCase())
      const image = resource.image || !!mediaType
      const maxBytes = image ? config.maxMediaBytes : config.maxFileBytes
      let data
      if (resource.url) {
        const url = admittedMediaUrl(resource.url, config)
        const response = await fetchFn(url, { signal, redirect: 'error' })
        if (!response.ok) throw new Error('MEDIA_HTTP_FAILED')
        data = await boundedBytes(response, maxBytes, signal)
        mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || mediaType
      } else {
        const scope = await workspace?.(sessionId, signal)
        if (!scope?.fs || !scope.cwd) throw new Error('WORKSPACE_FILES_UNAVAILABLE')
        const { fs, cwd } = scope
        const root = await fs.resolve(scope.root ?? cwd, { signal })
        const target = await fs.resolve(resource.path, { cwd, signal })
        if (!fs.contains(root, target)) throw new Error('ATTACHMENT_OUTSIDE_WORKSPACE')
        const info = await fs.stat(target, signal)
        if (info?.type !== 'file') throw new Error('ATTACHMENT_NOT_FOUND')
        data = await fs.readBytes(target, signal, maxBytes)
      }
      if (image) {
        if (!imageTypes.has(mediaType)) throw new Error('UNSUPPORTED_IMAGE_TYPE')
        return { type: 'image', attachment: await saveImage({ data, mediaType, name }) }
      }
      return { type: 'file', attachment: await attachments.saveFile({ data, name }) }
    },
    async export(block, { signal, config }) {
      const ref = block.attachment, maxBytes = block.type === 'image' ? config.maxMediaBytes : config.maxFileBytes
      if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > maxBytes) throw new Error('MEDIA_SIZE_DENIED')
      if (!attachments) throw new Error('ATTACHMENTS_UNAVAILABLE')
      if (block.type === 'image') {
        const stored = await attachments.readImage(ref, signal)
        if (stored.data.byteLength > maxBytes) throw new Error('MEDIA_SIZE_DENIED')
        return { file: 'base64://' + Buffer.from(stored.data).toString('base64') }
      }
      // OneBot file upload APIs require a host path; only a durable attachment's own backend may resolve it.
      const hostPath = attachments.fileHostPath(ref)
      if (!hostPath) throw new Error('FILE_BACKEND_HAS_NO_HOST_PATH')
      // Verify content-addressed bytes before exposing provider-owned path to OneBot.
      let total = 0
      for await (const chunk of attachments.readFileStream(ref, signal)) { total += chunk.byteLength; if (total > maxBytes) throw new Error('MEDIA_SIZE_DENIED') }
      if (total !== ref.bytes) throw new Error('FILE_INTEGRITY_MISMATCH')
      return { file: isVoiceFile(ref.name) ? pathToFileURL(hostPath).href : hostPath, name: ref.name }
    },
  }
}
