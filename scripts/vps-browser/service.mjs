/** Systemd socket worker for fixed, private Computer operations. */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { BROWSER_HEIGHT, BROWSER_WIDTH, browserInput, createBrowserPage, parseWebsite } from './page.mjs'
import { loginDestination } from './saved-login.mjs'

const BOT = /^bot-[a-zA-Z0-9][a-zA-Z0-9-]{0,245}$/u
const SESSION = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BOTS = 64
const MAX_PAGES = 4
const MAX_CLIENTS = 24
const MAX_REQUEST = 16 * 1024
const MAX_VAULT_REQUEST = 64 * 1024
const MAX_REPLY = 3 * 1024 * 1024
const REQUEST_TIMEOUT = 25_000
const IDLE_TIMEOUT = 10 * 60_000
const LOGIN_TTL = 5 * 60_000
const LOGIN_RECEIPT_TTL = 60_000
const LOGIN_ID = /^[a-f0-9]{32}$/u
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
  } else if (value.action === 'request-login' && fields(value, base)) {
    return { session: value.session, action: value.action }
  } else if ((value.action === 'login-status' || value.action === 'cancel-login') && fields(value, [...base, 'id'])
    && typeof value.id === 'string' && LOGIN_ID.test(value.id)) {
    return { session: value.session, action: value.action, id: value.id }
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

function endpoint(handle, requestLimit = MAX_REQUEST) {
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
      if (size > requestLimit) socket.destroy()
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

function credential(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && Buffer.byteLength(value) <= limit
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
}

function browserLogins(pool, enabled) {
  const byId = new Map()
  const bySession = new Map()
  function remove(record) {
    clearTimeout(record.timeout)
    byId.delete(record.id)
    if (bySession.get(record.session) === record) bySession.delete(record.session)
  }
  function finish(record, state) {
    clearTimeout(record.timeout)
    if (bySession.get(record.session) === record) bySession.delete(record.session)
    record.state = state
    record.page = undefined
    record.reviewed = undefined
    record.timeout = setTimeout(() => remove(record), LOGIN_RECEIPT_TTL).unref()
    return { state }
  }
  function expires(record) {
    return record.state === 'pending' && performance.now() >= record.deadline
  }
  function find(id) {
    const record = byId.get(id)
    if (record !== undefined && expires(record)) finish(record, 'unavailable')
    return record
  }
  function view(record) {
    return { id: record.id, origin: record.reviewed.origin, destination: record.reviewed.destination, state: 'pending' }
  }
  return {
    reserved: session => bySession.has(session),
    async control({ session, action, id }, signal) {
      if (!enabled) return UNAVAILABLE
      if (action === 'request-login') {
        return pool.run(session, async page => {
          if (bySession.has(session) || byId.size >= MAX_BOTS) return UNAVAILABLE
          const id = randomBytes(16).toString('hex')
          const reviewed = await page.captureLogin(id)
          signal.throwIfAborted()
          if (!loginDestination(reviewed.origin, reviewed.destination)) return UNAVAILABLE
          const record = { id, session, page, reviewed, state: 'pending', deadline: performance.now() + LOGIN_TTL }
          record.timeout = setTimeout(() => finish(record, 'unavailable'), LOGIN_TTL).unref()
          bySession.set(session, record)
          byId.set(id, record)
          void page.closed.then(() => { if (record.state === 'pending') finish(record, 'unavailable') })
          return view(record)
        }, signal)
      }
      const record = find(id)
      if (record === undefined || record.session !== session) return { state: 'unavailable' }
      if (action === 'cancel-login' && record.state === 'pending') return finish(record, 'unavailable')
      return { state: record.state === 'using' ? 'pending' : record.state }
    },
    async vault(body, signal) {
      if (!enabled || !object(body) || typeof body.id !== 'string' || !LOGIN_ID.test(body.id)) return UNAVAILABLE
      const record = find(body.id)
      if (record?.state !== 'pending') return UNAVAILABLE
      if (fields(body, ['action', 'id'])) {
        if (body.action === 'inspect-login') return view(record)
        if (body.action === 'cancel-login') return finish(record, 'unavailable')
      }
      if (body.action !== 'use-login' || !fields(body, ['action', 'id', 'origin', 'username', 'password'])
        || body.origin !== record.reviewed.origin || !credential(body.username, 512) || !credential(body.password, 8192)) return UNAVAILABLE
      return pool.run(record.session, async page => {
        if (record.state !== 'pending') return UNAVAILABLE
        if (expires(record) || page !== record.page) return finish(record, 'unavailable')
        clearTimeout(record.timeout)
        record.state = 'using'
        try {
          const result = await page.submitLogin(record.reviewed, body.username, body.password, signal)
          return finish(record, result === 'submitted' ? result : 'needs-owner')
        } catch (error) { void error; return finish(record, 'needs-owner') }
      }, signal)
    },
    close() {
      for (const record of byId.values()) remove(record)
    },
  }
}

/** Build both listeners without binding any TCP port. */
export function browserServers(options) {
  const pool = browserPool(options)
  const logins = browserLogins(pool, options.savedLogins === true)
  const control = endpoint(async (body, signal) => {
    const request = parseControl(body, options.grants)
    if (request.action === 'status') return { available: true }
    if (request.action === 'request-login' || request.action === 'login-status' || request.action === 'cancel-login') {
      return logins.control(request, signal)
    }
    return pool.run(request.session, async page => {
      if (logins.reserved(request.session)) return UNAVAILABLE
      if (request.action === 'frame') return { jpeg: await page.frame(), width: BROWSER_WIDTH, height: BROWSER_HEIGHT }
      if (request.action === 'input') await page.input(request.input)
      else await page.navigate(request.url)
      return { ok: true }
    }, signal)
  })
  const vault = endpoint(logins.vault, MAX_VAULT_REQUEST)
  return { control: control.server, vault: vault.server, close: async () => {
    await Promise.all([control.close(), vault.close()])
    await pool.close()
    logins.close()
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
    'saved-logins': { type: 'boolean' },
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
  const servers = browserServers({ executable, root: values.root, grants, savedLogins: values['saved-logins'] })
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
