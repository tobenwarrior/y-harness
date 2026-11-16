/** Systemd socket worker for fixed, private Computer operations. */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  BROWSER_HEIGHT, BROWSER_WIDTH, browserInput, canonicalHttpsOrigin, createBrowserPage, parseWebsite,
} from './page.mjs'
import { loginDestination } from './saved-login.mjs'

const BOT = /^bot-[a-zA-Z0-9][a-zA-Z0-9-]{0,245}$/u
const SESSION = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHARED_SESSION = /^shared-session-(?:group-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
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
const LEASE = /^[a-f0-9]{32}$/u
const HANDOFF_TTL = 10 * 60_000
const SHARING_REVISION = /^[a-f0-9]{32}$/u
const SHARED_POLICY_MODE = 0o640
const UNAVAILABLE = Object.freeze({ error: 'unavailable' })
const RESTARTED = Object.freeze({ status: 'restarted' })
const BUSY = Object.freeze({ status: 'busy' })

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fields(value, names) {
  return object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}

function validLease(value) {
  return typeof value === 'string' && LEASE.test(value)
}

/** Read a bounded, administrator-owned roster to select exactly one profile per Session. */
export function parseGrants(value) {
  if (!Array.isArray(value) || value.length > MAX_BOTS) throw new Error('Invalid isolated browser grants')
  const sessions = new Set()
  const grants = new Map()
  for (const entry of value) {
    const base = ['bot', 'session']
    if (!(fields(entry, base) || (fields(entry, [...base, 'shared']) && entry.shared === true))
      || typeof entry.bot !== 'string' || !BOT.test(entry.bot)
      || typeof entry.session !== 'string' || !SESSION.test(entry.session)
      || grants.has(entry.bot) || sessions.has(entry.session)) throw new Error('Invalid isolated browser grants')
    grants.set(entry.bot, { session: entry.session, shared: entry.shared === true })
    sessions.add(entry.session)
  }
  return grants
}

function parseSharingPolicy(value, grants) {
  if (!fields(value, ['version', 'bots']) || value.version !== 1
    || !Array.isArray(value.bots) || value.bots.length > MAX_BOTS) {
    throw new Error('Invalid shared browser policy')
  }
  const bots = new Map()
  for (const entry of value.bots) {
    if (!fields(entry, ['bot', 'session', 'enabled', 'revision'])
      || typeof entry.bot !== 'string' || !BOT.test(entry.bot)
      || typeof entry.session !== 'string' || !SESSION.test(entry.session)
      || typeof entry.enabled !== 'boolean'
      || typeof entry.revision !== 'string' || !SHARING_REVISION.test(entry.revision)
      || bots.has(entry.bot) || !grants.has(entry.bot)
      || grants.get(entry.bot).session !== entry.session) {
      throw new Error('Invalid shared browser policy')
    }
    bots.set(entry.bot, { enabled: entry.enabled, revision: entry.revision, session: entry.session })
  }
  return bots
}

async function readSharingPolicy(path, grants, trusted = false) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o7777) !== SHARED_POLICY_MODE
      || (trusted && (info.uid !== 0 || info.gid !== process.getgid()))) {
      throw new Error('Invalid shared browser policy')
    }
    if (info.size > 32 * 1024) throw new Error('Invalid shared browser policy')
    return { kind: 'managed', bots: parseSharingPolicy(JSON.parse(await readFile(path, 'utf8')), grants) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'legacy', bots: new Map() }
    return { kind: 'invalid', bots: new Map() }
  }
}

function sharedProfileSession(bot, sharedSession, revision = undefined) {
  const suffix = revision === undefined ? sharedSession : sharedSession + '\0' + revision
  return 'shared-' + createHash('sha256').update(bot + '\0' + suffix).digest('hex')
}

function sharingPolicy(path, grants, trusted = false) {
  let reconciled
  let loading = Promise.resolve()
  const initial = readSharingPolicy(path, grants, trusted)

  async function latest() {
    await loading
    return readSharingPolicy(path, grants, trusted)
  }

  async function refresh() {
    let result
    const operation = loading.then(async () => {
      const previous = reconciled ?? await initial
      const next = await readSharingPolicy(path, grants, trusted)
      reconciled = next
      result = { previous, next }
    })
    loading = operation.catch(() => undefined)
    await operation
    return result
  }

  async function resolve(request) {
    const grant = grants.get(request.bot)
    if (grant === undefined || grant.session !== request.ownerSession) throw new Error('Browser unavailable')
    const active = await latest()
    const override = active.kind === 'managed' ? active.bots.get(request.bot) : undefined
    const managed = active.kind === 'managed'
    const legacy = active.kind === 'managed' || active.kind === 'legacy' ? grant.shared === true : false
    const allowed = request.shared === true && active.kind !== 'invalid'
      && (override !== undefined ? override.enabled : legacy)
    const profile = override !== undefined
      ? sharedProfileSession(request.bot, request.sharedSession, override.revision)
      : sharedProfileSession(request.bot, request.sharedSession)
    return {
      allowed, managed, legacy, override: override?.enabled ?? null, profile,
      identity: { bot: request.bot, ownerSession: request.ownerSession, sharedSession: request.sharedSession },
    }
  }

  async function admission(request) {
    const resolved = await resolve(request)
    if (!resolved.allowed || resolved.profile !== request.session) throw new Error('Browser unavailable')
    return resolved
  }

  async function status(bot, ownerSession) {
    const resolved = await resolve({
      bot, ownerSession, shared: true, sharedSession: 'shared-session-00000000-0000-4000-8000-000000000000',
    })
    return { managed: resolved.managed, legacy: resolved.legacy, override: resolved.override }
  }

  function affected(previous, next) {
    const identities = []
    for (const [bot, grant] of grants) {
      const oldOverride = previous.kind === 'managed' ? previous.bots.get(bot) : undefined
      const newOverride = next.kind === 'managed' ? next.bots.get(bot) : undefined
      const oldValue = oldOverride === undefined
        ? { enabled: grant.shared === true, revision: undefined }
        : { enabled: oldOverride.enabled, revision: oldOverride.revision }
      const newValue = newOverride === undefined
        ? { enabled: grant.shared === true, revision: undefined }
        : { enabled: newOverride.enabled, revision: newOverride.revision }
      if (oldValue.enabled !== newValue.enabled || oldValue.revision !== newValue.revision
        || previous.kind === 'invalid' || next.kind === 'invalid') {
        identities.push({ bot, ownerSession: grant.session })
      }
    }
    return identities
  }

  return { current: latest, refresh, resolve, admission, status, affected }
}

function parseControl(value, grants) {
  if (!object(value) || typeof value.bot !== 'string' || typeof value.session !== 'string') throw new Error('Browser unavailable')
  const grant = grants.get(value.bot)
  const shared = grant !== undefined && SHARED_SESSION.test(value.session)
  if (!shared && grant?.session !== value.session) throw new Error('Browser unavailable')
  const session = shared ? 'shared-' + createHash('sha256').update(value.bot + '\0' + value.session).digest('hex') : value.session
  const base = ['action', 'bot', 'session']
  const request = extra => ({
    bot: value.bot, ownerSession: grant.session, shared, sharedSession: shared ? value.session : undefined, session, ...extra,
  })
  if (value.action === 'begin-handoff' && shared && fields(value, [...base, 'lease']) && validLease(value.lease)) {
    return request({ action: value.action, lease: value.lease })
  } else if (value.action === 'end-handoff' && shared && fields(value, [...base, 'lease', 'outcome'])
    && validLease(value.lease) && (value.outcome === 'complete' || value.outcome === 'discard')) {
    return request({ action: value.action, lease: value.lease, outcome: value.outcome })
  } else if (value.action === 'restart' && !shared && fields(value, base)) {
    return request({ action: value.action })
  } else if (value.action === 'frame' || value.action === 'status') {
    if (value.action === 'frame' && shared && fields(value, [...base, 'lease']) && validLease(value.lease)) {
      return request({ action: value.action, lease: value.lease })
    }
    if (value.action === 'status' && !shared && fields(value, [...base, 'capability'])
      && value.capability === 'restart') {
      return request({ action: value.action, capability: value.capability })
    }
    if (fields(value, base)) return request({ action: value.action })
  } else if (value.action === 'sharing-status' && !shared && fields(value, base)) {
    return request({ action: value.action })
  } else if (value.action === 'input' && fields(value, [...base, 'input'])) {
    return request({ action: 'input', input: browserInput(value.input) })
  } else if (value.action === 'input' && fields(value, [...base, 'lease', 'origin', 'input'])
    && shared && validLease(value.lease) && typeof value.origin === 'string' && value.origin.length > 0
    && canonicalHttpsOrigin(value.origin) === value.origin) {
    return request({ action: 'input', lease: value.lease, origin: value.origin, input: browserInput(value.input) })
  } else if (value.action === 'navigate' && fields(value, [...base, 'url'])) {
    return request({ action: 'navigate', url: parseWebsite(value.url) })
  } else if (value.action === 'navigate' && shared && fields(value, [...base, 'lease', 'url']) && validLease(value.lease)) {
    const url = parseWebsite(value.url)
    if (!url.startsWith('https://')) throw new Error('Invalid website')
    return request({ action: 'navigate', lease: value.lease, url })
  } else if (value.action === 'request-login' && fields(value, base)) {
    return request({ action: value.action })
  } else if ((value.action === 'login-status' || value.action === 'cancel-login') && fields(value, [...base, 'id'])
    && typeof value.id === 'string' && LOGIN_ID.test(value.id)) {
    return request({ action: value.action, id: value.id })
  } else if (shared && value.action === 'authorize-login' && fields(value, [...base, 'id', 'challenge'])
    && typeof value.id === 'string' && LOGIN_ID.test(value.id)
    && typeof value.challenge === 'string' && LOGIN_ID.test(value.challenge)) {
    return request({ action: value.action, id: value.id, challenge: value.challenge })
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

function browserPool({ root, executable, createPage = createBrowserPage, handoffNow = () => performance.now(),
  handoffSchedule = (callback, delay) => setTimeout(callback, delay) }) {
  const pages = new Map()
  let closed = false

  function clearHandoffTimer(handoff) {
    if (handoff.timer !== undefined) clearTimeout(handoff.timer)
    handoff.timer = undefined
  }

  function scheduleHandoffExpiry(session, entry, handoff) {
    const timer = handoffSchedule(() => {
      if (closed || pages.get(session) !== entry || entry.handoff !== handoff || handoff.state !== 'active') return
      if (handoffNow() < handoff.expiresAt) {
        scheduleHandoffExpiry(session, entry, handoff)
        return
      }
      handoff.state = 'expired'
      void queueDiscard(session, entry, handoff.lease).catch(() => undefined)
    }, HANDOFF_TTL)
    timer?.unref?.()
    handoff.timer = timer
  }

  function markExpired(session, entry) {
    const handoff = entry.handoff
    if (handoff?.state !== 'active' || handoffNow() < handoff.expiresAt) return false
    handoff.state = 'expired'
    clearHandoffTimer(handoff)
    void queueDiscard(session, entry, handoff.lease).catch(() => undefined)
    return true
  }

  function disposePage(session, entry) {
    clearTimeout(entry.idle)
    if (entry.disposal !== undefined) return entry.disposal
    entry.disposal = entry.page.then(page => page.close()).finally(() => {
      if (pages.get(session) === entry) pages.delete(session)
    })
    return entry.disposal
  }

  function queueDiscard(session, entry, lease) {
    if (entry.discardTask !== undefined) return entry.discardTask
    entry.discardTask = enqueue(session, entry, async page => {
      const handoff = entry.handoff
      if (handoff === undefined || handoff.lease !== lease
        || (handoff.state !== 'expired' && handoff.state !== 'discarding')) throw new Error('Browser unavailable')
      handoff.state = 'discarding'
      clearHandoffTimer(handoff)
      await page.close()
      entry.disposed = true
      if (pages.get(session) === entry) pages.delete(session)
      return { ok: true }
    }, undefined, { kind: 'discard', lease })
    return entry.discardTask
  }

  async function entryFor(session, signal, create, identity = undefined) {
    signal?.throwIfAborted()
    if (closed) throw new Error('Browser unavailable')
    let entry = pages.get(session)
    if (entry?.disposal !== undefined) {
      await entry.disposal
      signal?.throwIfAborted()
      if (closed) throw new Error('Browser unavailable')
      entry = pages.get(session)
    }
    if (entry?.retired || entry?.restarting) throw new Error('Browser unavailable')
    if (entry === undefined) {
      if (!create) throw new Error('Browser unavailable')
      if (pages.size >= MAX_PAGES) throw new Error('Too many active browsers')
      const next = { page: profileDirectory(root, session).then(path => createPage(executable, path)),
        queue: Promise.resolve(), pending: 0, idle: undefined, disposal: undefined,
        handoff: undefined, discardTask: undefined, disposed: false, retired: false,
        starting: true, restarting: false, identity }
      pages.set(session, next)
      void next.page.then(() => { next.starting = false }, () => { next.starting = false })
      void next.page.then(page => page.closed).catch(() => undefined).then(() => {
        if (pages.get(session) === next) pages.delete(session)
        clearTimeout(next.idle)
      })
      entry = next
    }
    return entry
  }

  function checkAdmission(session, entry, admission) {
    if (pages.get(session) !== entry || entry.disposed) throw new Error('Browser unavailable')
    if (admission.kind !== 'retire' && entry.retired) throw new Error('Browser unavailable')
    if (admission.kind !== 'retire' && entry.restarting) throw new Error('Browser unavailable')
    if (admission.kind === 'retire') return
    if (admission.kind === 'begin') {
      if (entry.handoff !== undefined) throw new Error('Browser unavailable')
      return
    }
    const handoff = entry.handoff
    if (admission.kind === 'discard') {
      if (handoff === undefined || handoff.lease !== admission.lease
        || (handoff.state !== 'expired' && handoff.state !== 'discarding')) throw new Error('Browser unavailable')
      return
    }
    if (admission.kind === 'owner') {
      if (handoff === undefined || handoff.lease !== admission.lease || handoff.state !== 'active'
        || handoffNow() >= handoff.expiresAt) {
        markExpired(session, entry)
        throw new Error('Browser unavailable')
      }
      return
    }
    if (handoff !== undefined) {
      markExpired(session, entry)
      throw new Error('Browser unavailable')
    }
  }

  function enqueue(session, entry, operation, signal, admission = { kind: 'ordinary' }) {
    signal?.throwIfAborted()
    if (entry.handoff?.state === 'active') markExpired(session, entry)
    entry.pending++
    const result = entry.queue.then(async () => {
      signal?.throwIfAborted()
      checkAdmission(session, entry, admission)
      await admission.authorize?.()
      checkAdmission(session, entry, admission)
      const page = await entry.page
      signal?.throwIfAborted()
      checkAdmission(session, entry, admission)
      await admission.authorize?.()
      checkAdmission(session, entry, admission)
      const value = await operation(page)
      await admission.after?.()
      if (admission.kind === 'ordinary') checkAdmission(session, entry, admission)
      return value
    })
    entry.queue = result.then(() => undefined, () => undefined)
    void result.finally(() => {
      entry.pending--
      if (entry.pending === 0 && !closed && pages.get(session) === entry && entry.disposal === undefined
        && entry.handoff === undefined && !entry.retired) {
        entry.idle = setTimeout(() => { void disposePage(session, entry).catch(() => undefined) }, IDLE_TIMEOUT).unref()
      }
    }).catch(() => undefined)
    return result
  }

  return {
    async run(
      session, operation, signal, lease = undefined, identity = undefined,
      authorize = undefined, releaseAuthorize = authorize,
    ) {
      await authorize?.()
      const active = await entryFor(session, signal, lease === undefined, identity)
      clearTimeout(active.idle)
      return enqueue(session, active, operation, signal,
        lease === undefined
          ? { kind: 'ordinary', authorize, after: releaseAuthorize }
          : { kind: 'owner', lease, authorize, after: releaseAuthorize })
    },
    async restart(session, signal, reserved = () => false) {
      signal?.throwIfAborted()
      if (reserved()) return BUSY
      const active = pages.get(session)
      if (active === undefined) return RESTARTED
      if (active.starting || active.pending > 0 || active.disposal !== undefined
        || active.handoff !== undefined || active.restarting) return BUSY
      active.restarting = true
      try {
        if (reserved()) return BUSY
        await disposePage(session, active)
        return RESTARTED
      } finally {
        active.restarting = false
      }
    },
    async begin(
      session, lease, operation, signal, identity = undefined,
      authorize = undefined, releaseAuthorize = authorize,
    ) {
      const active = await entryFor(session, signal, false, identity)
      clearTimeout(active.idle)
      const result = enqueue(session, active, async page => {
        const result = await operation(page)
        signal?.throwIfAborted()
        await releaseAuthorize?.()
        signal?.throwIfAborted()
        const handoff = { lease, expiresAt: handoffNow() + HANDOFF_TTL, state: 'active', timer: undefined }
        active.handoff = handoff
        scheduleHandoffExpiry(session, active, handoff)
        return result
      }, signal, { kind: 'begin', authorize })
      return result
    },
    async end(
      session, lease, outcome, signal, identity = undefined,
      authorize = undefined, releaseAuthorize = authorize,
    ) {
      const active = await entryFor(session, signal, false, identity)
      clearTimeout(active.idle)
      return enqueue(session, active, async page => {
        const handoff = active.handoff
        if (handoff === undefined || handoff.lease !== lease || handoff.state !== 'active') {
          throw new Error('Browser unavailable')
        }
        if (outcome === 'complete') {
          clearHandoffTimer(handoff)
          active.handoff = undefined
          return { ok: true }
        }
        handoff.state = 'discarding'
        clearHandoffTimer(handoff)
        await page.close()
        active.disposed = true
        if (pages.get(session) === active) pages.delete(session)
        return { ok: true }
      }, signal, { kind: 'owner', lease, authorize, after: releaseAuthorize })
    },
    async retire(predicate) {
      const tasks = []
      for (const [session, entry] of pages) {
        if (entry.identity === undefined || !predicate(entry.identity)) continue
        entry.retired = true
        if (entry.handoff !== undefined) {
          entry.handoff.state = 'revoked'
          clearHandoffTimer(entry.handoff)
        }
        if (entry.retireTask === undefined) {
          entry.retireTask = enqueue(session, entry, async page => {
            await page.close()
            entry.disposed = true
            if (pages.get(session) === entry) pages.delete(session)
            return { ok: true }
          }, undefined, { kind: 'retire' })
        }
        tasks.push(entry.retireTask)
      }
      const results = await Promise.allSettled(tasks)
      if (results.some(result => result.status === 'rejected')) throw new Error('Browser unavailable')
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

function browserLogins(pool, enabled, authorize) {
  const byId = new Map()
  const bySession = new Map()
  function cancelApproval(record) {
    const approval = record.approval
    record.approval = undefined
    approval?.resolve(false)
  }
  function remove(record) {
    clearTimeout(record.timeout)
    cancelApproval(record)
    byId.delete(record.id)
    if (bySession.get(record.session) === record) bySession.delete(record.session)
  }
  function finish(record, state) {
    clearTimeout(record.timeout)
    cancelApproval(record)
    if (bySession.get(record.session) === record) bySession.delete(record.session)
    record.state = state
    record.page = undefined
    record.reviewed = undefined
    record.timeout = setTimeout(() => remove(record), LOGIN_RECEIPT_TTL).unref()
    return { state }
  }
  function expires(record) {
    return (record.state === 'pending' || record.approval !== undefined) && performance.now() >= record.deadline
  }
  function find(id) {
    const record = byId.get(id)
    if (record !== undefined && expires(record)) finish(record, 'unavailable')
    return record
  }
  function view(record) {
    return { id: record.id, origin: record.reviewed.origin, destination: record.reviewed.destination, state: 'pending' }
  }
  async function admit(record, release = false) {
    if (!record.shared) return
    await authorize(record, release)
  }
  async function awaitSharedApproval(record, signal) {
    if (signal.aborted) return false
    const decision = Promise.withResolvers()
    const approval = { challenge: randomBytes(16).toString('hex'), resolve: decision.resolve }
    record.approval = approval
    const cancel = () => decision.resolve(false)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await decision.promise
    } finally {
      signal.removeEventListener('abort', cancel)
      if (record.approval === approval) record.approval = undefined
    }
  }
  return {
    reserved: session => bySession.has(session),
    async control({ bot, ownerSession, sharedSession, session, shared, identity, action, id, challenge }, signal) {
      if (!enabled) return UNAVAILABLE
      if (action === 'request-login') {
        const request = shared ? { bot, ownerSession, shared: true, sharedSession, session } : undefined
        const requestAuthorize = request === undefined ? undefined : () => authorize(request, false)
        const requestRelease = request === undefined ? undefined : () => authorize(request, true)
        return pool.run(session, async page => {
          if (bySession.has(session) || byId.size >= MAX_BOTS) return UNAVAILABLE
          const id = randomBytes(16).toString('hex')
          const reviewed = await page.captureLogin(id)
          signal.throwIfAborted()
          if (!loginDestination(reviewed.origin, reviewed.destination)) return UNAVAILABLE
          const record = {
            id, bot, ownerSession, sharedSession, session, shared, identity, page, reviewed,
            state: 'pending', deadline: performance.now() + LOGIN_TTL,
          }
          record.timeout = setTimeout(() => finish(record, 'unavailable'), LOGIN_TTL).unref()
          bySession.set(session, record)
          byId.set(id, record)
          void page.closed.then(() => {
            if (record.state === 'pending' || record.approval !== undefined) finish(record, 'unavailable')
          })
          return view(record)
        }, signal, undefined, identity, requestAuthorize, requestRelease)
      }
      const record = find(id)
      if (action === 'authorize-login') {
        if (record === undefined || record.session !== session || record.approval?.challenge !== challenge) return UNAVAILABLE
        await admit(record).catch(() => { throw new Error('Browser unavailable') })
        const approval = record.approval
        record.approval = undefined
        approval.resolve(true)
        return { ok: true }
      }
      if (record === undefined || record.session !== session) return { state: 'unavailable' }
      if (action === 'cancel-login' && (record.state === 'pending' || record.state === 'using' || record.approval !== undefined)) {
        return finish(record, 'unavailable')
      }
      if (record.shared) await admit(record).catch(() => { throw new Error('Browser unavailable') })
      if (record.approval !== undefined) return { state: 'approval-pending', challenge: record.approval.challenge }
      return { state: record.state === 'using' ? 'pending' : record.state }
    },
    async vault(body, signal) {
      if (!enabled || !object(body) || typeof body.id !== 'string' || !LOGIN_ID.test(body.id)) return UNAVAILABLE
      const record = find(body.id)
      if (record === undefined) return UNAVAILABLE
      if (fields(body, ['action', 'id'])) {
        if (body.action === 'cancel-login') return finish(record, 'unavailable')
      }
      if (record.state !== 'pending') return UNAVAILABLE
      if (fields(body, ['action', 'id'])) {
        if (body.action === 'inspect-login') return record.shared
          ? { ...view(record), scope: 'shared', bot: record.bot } : view(record)
        if (body.action === 'inspect-login-automatic' && !record.shared) {
          return { ...view(record), bot: record.bot, session: record.session }
        }
        if (body.action === 'inspect-login-bot') return { bot: record.bot }
      }
      const useFields = ['action', 'id', 'origin', 'username', 'password']
      const botAccount = fields(body, [...useFields, 'bot']) && body.bot === record.bot
      const automatic = fields(body, [...useFields, 'bot', 'session']) && !record.shared
        && body.bot === record.bot && body.session === record.session
      if (body.action !== 'use-login' || !(automatic || botAccount || (!record.shared && fields(body, useFields)))
        || body.origin !== record.reviewed.origin || !credential(body.username, 512) || !credential(body.password, 8192)) return UNAVAILABLE
      return pool.run(record.session, async page => {
        if (record.state !== 'pending') return UNAVAILABLE
        if (expires(record) || page !== record.page) return finish(record, 'unavailable')
        record.state = 'using'
        if (record.shared) {
          // The Cloud Host must still admit the shared turn after the owner approves.
          const approved = await awaitSharedApproval(record, signal)
          if (record.state !== 'using') return { state: record.state }
          if (!approved || signal.aborted || performance.now() >= record.deadline) return finish(record, 'unavailable')
          try { await admit(record, true) } catch { return finish(record, 'unavailable') }
        }
        clearTimeout(record.timeout)
        try {
          const result = await page.submitLogin(record.reviewed, body.username, body.password, signal)
          return finish(record, result === 'submitted' ? result : 'needs-owner')
        } catch (error) { void error; return finish(record, 'needs-owner') }
      }, signal, undefined, record.identity,
        record.shared ? () => admit(record, false) : undefined,
        record.shared ? () => admit(record, true) : undefined)
    },
    retire(predicate) {
      for (const record of byId.values()) {
        if (record.shared && record.identity !== undefined && predicate(record.identity)) {
          record.state = 'unavailable'
          remove(record)
        }
      }
    },
    close() {
      for (const record of byId.values()) remove(record)
    },
  }
}

/** Build both listeners without binding any TCP port. */
export function browserServers(options) {
  const pool = browserPool(options)
  const sharing = sharingPolicy(
    options.sharingFile ?? join(options.root, 'shared-grants.json'), options.grants, options.trustedSharing === true,
  )
  let refreshQueue = Promise.resolve()
  async function prepare(request) {
    if (!request.shared) return
    await refreshQueue
    const resolved = await sharing.resolve(request)
    if (!resolved.allowed) throw new Error('Browser unavailable')
    request.session = resolved.profile
    request.identity = resolved.identity
  }
  const authorize = (request, release = false) => request.shared
    ? (release ? sharing.admission(request) : refreshQueue.then(() => sharing.admission(request)))
    : Promise.resolve()
  const logins = browserLogins(pool, options.savedLogins === true, authorize)
  const control = endpoint(async (body, signal) => {
    const request = parseControl(body, options.grants)
    if (request.action === 'sharing-status') {
      await refreshQueue
      return sharing.status(request.bot, request.ownerSession)
    }
    await prepare(request)
    if (request.action === 'status') return { available: true }
    if (request.action === 'restart') return pool.restart(request.session, signal, () => logins.reserved(request.session))
    if (request.action === 'begin-handoff') {
      return pool.begin(request.session, request.lease, async page => {
        if (logins.reserved(request.session)) throw new Error('Browser unavailable')
        const origin = await page.origin()
        if (origin === null || canonicalHttpsOrigin(origin) !== origin) throw new Error('Browser unavailable')
        return { origin }
      }, signal, request.identity, () => authorize(request), () => authorize(request, true))
    }
    if (request.action === 'end-handoff') {
      return pool.end(
        request.session, request.lease, request.outcome, signal, request.identity,
        () => authorize(request), () => authorize(request, true),
      )
    }
    if (request.action === 'request-login' || request.action === 'login-status' || request.action === 'cancel-login'
      || request.action === 'authorize-login') {
      return logins.control(request, signal)
    }
    return pool.run(request.session, async page => {
      if (logins.reserved(request.session)) return UNAVAILABLE
      if (request.action === 'frame') {
        if (request.lease === undefined) return { jpeg: await page.frame(), width: BROWSER_WIDTH, height: BROWSER_HEIGHT }
        const before = await page.origin()
        const jpeg = await page.frame()
        const after = await page.origin()
        return { jpeg, width: BROWSER_WIDTH, height: BROWSER_HEIGHT, origin: before !== null && before === after ? before : null }
      }
      if (request.action === 'input') {
        if (request.lease !== undefined && await page.origin() !== request.origin) throw new Error('Browser unavailable')
        await page.input(request.input)
      } else await page.navigate(request.url)
      return { ok: true }
    }, signal, request.lease, request.identity,
      () => authorize(request), () => authorize(request, true))
  })
  const vault = endpoint(async (body, signal) => {
    if (fields(body, ['action']) && body.action === 'refresh-sharing') {
      let reply
      const operation = refreshQueue.then(async () => {
        const result = await sharing.refresh()
        const affected = sharing.affected(result.previous, result.next)
        const identities = new Set(affected.map(identity => identity.bot + '\0' + identity.ownerSession))
        const isAffected = identity => identities.has(identity.bot + '\0' + identity.ownerSession)
        logins.retire(isAffected)
        await pool.retire(isAffected)
        if (result.next.kind === 'invalid') throw new Error('Invalid shared browser policy')
        reply = { ok: true }
      })
      refreshQueue = operation.catch(() => undefined)
      await operation
      return reply
    }
    return logins.vault(body, signal)
  }, MAX_VAULT_REQUEST)
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

async function trustedSharingFile(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== process.getgid()
      || (info.mode & 0o7777) !== SHARED_POLICY_MODE) {
      throw new Error('Browser installation unavailable')
    }
    return path
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
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
  const sharingFile = join(dirname(grantsFile), 'shared-grants.json')
  await trustedSharingFile(sharingFile)
  const grantInfo = await lstat(grantsFile)
  if (grantInfo.size > 32 * 1024 || typeof values.root !== 'string' || !isAbsolute(values.root)) throw new Error('Browser profile unavailable')
  const root = await lstat(values.root)
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o077) !== 0) throw new Error('Browser profile unavailable')
  const grants = parseGrants(JSON.parse(await readFile(grantsFile, 'utf8')))
  const names = process.env.LISTEN_FDNAMES?.split(':') ?? []
  if (process.env.LISTEN_PID !== String(process.pid) || process.env.LISTEN_FDS !== '2'
    || names.length !== 2 || !names.includes('control') || !names.includes('vault')) throw new Error('Browser sockets unavailable')
  const servers = browserServers({
    executable, root: values.root, grants, sharingFile, trustedSharing: true, savedLogins: values['saved-logins'],
  })
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
