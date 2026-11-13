/** Systemd socket worker for fixed, private Computer operations. */

import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { BROWSER_HEIGHT, BROWSER_WIDTH, browserInput, createBrowserPage, parseWebsite } from './page.mjs'

const BOT = /^bot-[a-zA-Z0-9][a-zA-Z0-9-]{0,245}$/u
const SESSION = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BOTS = 64
const MAX_PAGES = 4
const MAX_CLIENTS = 24
const MAX_REQUEST = 16 * 1024
const MAX_REPLY = 3 * 1024 * 1024
const REQUEST_TIMEOUT = 25_000
const IDLE_TIMEOUT = 10 * 60_000
const UNAVAILABLE = Object.freeze({ error: 'unavailable' })

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fields(value, names) {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

/** Read a bounded, administrator-owned roster to select exactly one profile per Session. */
export function parseGrants(value) {
  if (!Array.isArray(value) || value.length > MAX_BOTS) throw new Error('Invalid isolated browser grants')
  const sessions = new Set()
  const grants = new Map()
  for (const entry of value) {
    if (!fields(entry, ['bot', 'session']) || typeof entry.bot !== 'string' || !BOT.test(entry.bot)
      || typeof entry.session !== 'string' || !SESSION.test(entry.session)
      || grants.has(entry.bot) || sessions.has(entry.session)) throw new Error('Invalid isolated browser grants')
    grants.set(entry.bot, entry.session)
    sessions.add(entry.session)
  }
  return grants
}

function parseControl(value, grants) {
  if (!object(value) || typeof value.bot !== 'string' || grants.get(value.bot) !== value.session
    || typeof value.session !== 'string') throw new Error('Browser unavailable')
  const base = ['action', 'bot', 'session']
  if (value.action === 'frame' || value.action === 'status') {
    if (fields(value, base)) return { session: value.session, action: value.action }
  } else if (value.action === 'input' && fields(value, [...base, 'input'])) {
    return { session: value.session, action: 'input', input: browserInput(value.input) }
  } else if (value.action === 'navigate' && fields(value, [...base, 'url'])) {
    return { session: value.session, action: 'navigate', url: parseWebsite(value.url) }
  }
  throw new Error('Browser unavailable')
}

async function profileDirectory(root, session) {
  const path = join(root, session)
  await mkdir(path, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Browser profile is unavailable')
  }
  return path
}

function browserPool({ root, executable, createPage = createBrowserPage }) {
  const pages = new Map()
  let closed = false
  function disposePage(session, entry) {
    clearTimeout(entry.idle)
    if (entry.disposal !== undefined) return entry.disposal
    entry.disposal = entry.page.then(page => page.close()).finally(() => {
      if (pages.get(session) === entry) pages.delete(session)
    })
    return entry.disposal
  }
  return {
    async run(session, operation, signal) {
      signal.throwIfAborted()
      if (closed) throw new Error('Browser unavailable')
      let entry = pages.get(session)
      if (entry?.disposal !== undefined) {
        await entry.disposal
        signal.throwIfAborted()
        if (closed) throw new Error('Browser unavailable')
        entry = pages.get(session)
      }
      if (entry === undefined) {
        if (pages.size >= MAX_PAGES) throw new Error('Too many active browsers')
        const next = { page: profileDirectory(root, session).then(path => createPage(executable, path)),
          queue: Promise.resolve(), pending: 0, idle: undefined, disposal: undefined }
        pages.set(session, next)
        void next.page.then(page => page.closed).catch(() => undefined).then(() => {
          if (pages.get(session) === next) pages.delete(session)
          clearTimeout(next.idle)
        })
        entry = next
      }
      const active = entry
      clearTimeout(active.idle)
      active.pending++
      const result = active.queue.then(async () => {
        signal.throwIfAborted()
        const page = await active.page
        signal.throwIfAborted()
        return operation(page)
      })
      active.queue = result.then(() => undefined, () => undefined)
      try { return await result } finally {
        active.pending--
        if (active.pending === 0 && !closed && pages.get(session) === active && active.disposal === undefined) {
          active.idle = setTimeout(() => { void disposePage(session, active).catch(() => undefined) }, IDLE_TIMEOUT).unref()
        }
      }
    },
    async close() {
      closed = true
      await Promise.allSettled([...pages].map(([session, entry]) => disposePage(session, entry)))
    },
  }
}

function endpoint(handle) {
  const clients = new Set()
  const server = createServer({ allowHalfOpen: true }, socket => {
    if (clients.size >= MAX_CLIENTS) { socket.destroy(); return }
    clients.add(socket)
    const controller = new AbortController()
    const timeout = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT).unref()
    const chunks = []
    let size = 0
    socket.on('error', () => socket.destroy())
    socket.once('close', () => {
      clearTimeout(timeout)
      clients.delete(socket)
      controller.abort()
    })
    socket.on('data', chunk => {
      size += chunk.length
      if (size > MAX_REQUEST) socket.destroy()
      else chunks.push(chunk)
    })
    socket.once('end', () => {
      void Promise.resolve().then(() => {
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
        return handle(JSON.parse(body), controller.signal)
      }).catch(() => UNAVAILABLE).then(reply => {
        if (socket.destroyed) return
        const data = JSON.stringify(reply)
        socket.end(Buffer.byteLength(data) > MAX_REPLY ? JSON.stringify(UNAVAILABLE) : data)
      })
    })
  })
  return { server, close: () => {
    for (const socket of clients) socket.destroy()
    return new Promise(resolve => { server.close(() => resolve()) })
  } }
}

/** Build both listeners without binding any TCP port. */
export function browserServers(options) {
  const pool = browserPool(options)
  const control = endpoint(async (body, signal) => {
    const request = parseControl(body, options.grants)
    if (request.action === 'status') return { available: true }
    return pool.run(request.session, async page => {
      if (request.action === 'frame') return { jpeg: await page.frame(), width: BROWSER_WIDTH, height: BROWSER_HEIGHT }
      if (request.action === 'input') await page.input(request.input)
      else await page.navigate(request.url)
      return { ok: true }
    }, signal)
  })
  const vault = endpoint(() => UNAVAILABLE)
  return { control: control.server, vault: vault.server, close: async () => {
    await Promise.all([control.close(), vault.close()])
    await pool.close()
  } }
}

async function trustedFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Browser installation unavailable')
  const file = await realpath(path)
  const info = await lstat(file)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Browser installation unavailable')
  return file
}

async function main() {
  const { values } = parseArgs({ options: {
    chromium: { type: 'string' }, root: { type: 'string' }, 'cloud-uid': { type: 'string' }, grants: { type: 'string' },
  } })
  const cloudUid = Number(values['cloud-uid'])
  const uid = process.getuid()
  if (uid === 0 || !Number.isSafeInteger(cloudUid) || cloudUid <= 0 || uid === cloudUid) throw new Error('Browser identity unavailable')
  const [executable, grantsFile] = await Promise.all([trustedFile(values.chromium), trustedFile(values.grants)])
  const grantInfo = await lstat(grantsFile)
  if (grantInfo.size > 32 * 1024 || typeof values.root !== 'string' || !isAbsolute(values.root)) throw new Error('Browser profile unavailable')
  const root = await lstat(values.root)
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o077) !== 0) throw new Error('Browser profile unavailable')
  const grants = parseGrants(JSON.parse(await readFile(grantsFile, 'utf8')))
  const names = process.env.LISTEN_FDNAMES?.split(':') ?? []
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '2'
    || names.length !== 2 || !names.includes('control') || !names.includes('vault')) throw new Error('Browser sockets unavailable')
  const servers = browserServers({ executable, root: values.root, grants })
  const stop = () => { void servers.close().catch(() => { process.exitCode = 1 }) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  for (const name of ['control', 'vault']) {
    servers[name].once('error', () => { process.exitCode = 1; stop() })
    servers[name].listen({ fd: names.indexOf(name) + 3 })
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error('The private browser could not start.'); process.exitCode = 1 })
}
