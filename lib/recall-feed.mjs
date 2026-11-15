import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isRecallNotice } from './recall.mjs'
import { isPeerTypingEvent } from './peer-typing.mjs'

const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
const maxConfigBytes = 262144
const maxEventChars = 2097152

function socketOrigin(protocol, { host, port }) {
  const hostname = host === '::1' ? '[::1]' : host
  if (!loopback.has(hostname) || !Number.isInteger(port) || port < 1 || port > 65535) return
  return new URL(`${protocol}://${hostname}:${port}`)
}

export function snowLumaRecallSocket(config, baseUrl) {
  const http = config?.networks?.httpServers, ws = config?.networks?.wsServers
  if (!Array.isArray(http) || !Array.isArray(ws)) return
  const server = http.find(row => row && row.enabled !== false && socketOrigin('http', row)?.origin === baseUrl)
  if (!server) return
  const host = socketOrigin('http', server).hostname
  for (const entry of ws) {
    if (!entry || entry.enabled === false || ![undefined, 'Universal', 'Event'].includes(entry.role)) continue
    const url = socketOrigin('ws', entry), path = entry.path || '/'
    if (!url || url.hostname !== host || typeof path !== 'string' || !/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(path)) continue
    url.pathname = path === '/' && entry.role !== 'Event' ? '/event' : path
    const token = typeof entry.accessToken === 'string' ? entry.accessToken.trim() : ''
    return { url: url.href, token }
  }
}

async function loadConfig(file) {
  if (!isAbsolute(file)) return
  const handle = await open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxConfigBytes) return
    const buffer = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead !== stat.size) return
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''))
  } finally { await handle.close() }
}

/** One read-only event socket carries recall notices and own-account status. */
export class QqRecallFeed {
  constructor({ bridge, file, readConfig = loadConfig, Socket = globalThis.WebSocket }) {
    this.bridge = bridge
    this.file = file
    this.readConfig = readConfig
    this.Socket = Socket
    this.status = file ? 'waiting' : 'unconfigured'
    this.jobs = new Set()
  }
  start() {
    if (!this.file || this.timer || this.closed) return
    this.timer = setInterval(() => void this.sync(), 5000)
    this.timer.unref()
    void this.sync()
  }
  desiredOrigin() {
    const bridge = this.bridge
    if (!this.closed && bridge.networkEnabled() && (bridge.config.enabled && bridge.config.bindings.some(row => row.enabled) ||
      bridge.config.sendEnabled && bridge.config.outboundTargets?.some(row => row.enabled))) return bridge.config.baseUrl
  }
  async sync() {
    const origin = this.desiredOrigin()
    if (this.connection && this.connection.origin !== origin) this.disconnect()
    if (!origin || !this.file || this.connection || this.connecting) return
    this.connecting = true
    try {
      const settings = snowLumaRecallSocket(await this.readConfig(this.file), origin)
      if (!settings) { this.status = 'configuration-mismatch'; return }
      if (origin !== this.desiredOrigin()) return
      const account = await this.bridge.onebot.call('get_login_info', {}, { signal: this.bridge.controller.signal, timeoutMs: 3000, maxBytes: 16384 })
      const selfId = String(account?.user_id ?? '')
      if (!/^[1-9]\d{0,23}$/.test(selfId)) { this.status = 'account-unavailable'; return }
      if (origin !== this.desiredOrigin()) return
      const socket = new this.Socket(settings.url, { headers: settings.token ? { Authorization: 'Bearer ' + settings.token } : {} })
      const connection = { socket, origin, selfId, controller: new AbortController() }
      this.connection = connection
      this.status = 'connecting'
      const fail = () => {
        if (this.connection !== connection) return
        this.disconnect()
        this.status = 'waiting'
      }
      socket.addEventListener('open', () => {
        if (this.connection !== connection) return
        this.status = 'connected'
        clearTimeout(connection.timeout)
      })
      socket.addEventListener('close', fail)
      socket.addEventListener('error', fail)
      socket.addEventListener('message', event => this.onMessage(connection, event.data))
      connection.timeout = setTimeout(fail, 5000)
      connection.timeout.unref()
    } catch { this.status = 'waiting' }
    finally { this.connecting = false }
  }
  onMessage(connection, raw) {
    if (this.connection !== connection || connection.origin !== this.desiredOrigin() || typeof raw !== 'string' || raw.length > maxEventChars) return
    try {
      const event = JSON.parse(raw)
      if (String(event?.self_id ?? '') !== connection.selfId) return
      if (this.bridge.qqStatus?.observe(event, connection.selfId)) return
      if (isPeerTypingEvent(event)) { this.bridge.observePeerTyping?.(event); return }
      if (!isRecallNotice(event)) {
        this.bridge.observeRecallMessage(event)
        return
      }
      if (this.jobs.size >= 32) return
      const job = this.bridge.receive(event, { signal: connection.controller.signal, via: 'recall-socket' })
        .catch(() => { this.status = 'record-error' })
      this.jobs.add(job)
      void job.finally(() => this.jobs.delete(job))
    } catch { /* Invalid frames have no effect on other events. */ }
  }
  disconnect() {
    const connection = this.connection
    this.connection = undefined
    if (connection) {
      clearTimeout(connection.timeout)
      connection.controller.abort()
      this.bridge.qqStatus?.streamClosed()
      this.bridge.peerInputStates?.clear()
      connection.socket.close()
    }
    if (this.file) this.status = 'waiting'
  }
  async dispose() {
    this.closed = true
    clearInterval(this.timer)
    this.disconnect()
    await Promise.allSettled([...this.jobs])
  }
}
