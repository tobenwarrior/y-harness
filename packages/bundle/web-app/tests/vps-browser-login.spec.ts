import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brokerFixture } from './vps-broker-fixture.ts'
import { VpsIsolatedBrowser as BrowserUnderTest, type VpsIsolatedBrowserConfig, type VpsIsolatedBrowserInternals } from '../src/vps-isolated-browser.ts'
import { VpsBrowserLogin, type VpsBrowserLoginLease, vpsBrowserLoginRoute } from '../src/vps-browser-login.ts'

const BOT = 'bot-login'
const SESSION = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const SHARED_SESSION = 'shared-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf77'
const LOGIN_ID = '0123456789abcdef0123456789abcdef'
const INSTALLED_CONTROL = '/run/yharness-browser/control.sock'

const fixture = brokerFixture()

class VpsIsolatedBrowser extends BrowserUnderTest {
  constructor(config: VpsIsolatedBrowserConfig, internals: VpsIsolatedBrowserInternals = {}) {
    super(config, { ...internals, connect: internals.connect ?? fixture.connect })
  }
}

const roots: string[] = []
const servers: Server[] = []

function fixtureSocketPath(root: string, prefix: string): string {
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\yharness-${prefix}-${randomUUID()}`
    : join(root, 'broker.sock')
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => { resolve() })
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  fixture.clear()
})

async function listen(handler: (request: Record<string, unknown>) => unknown): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-login-'))
  roots.push(root)
  const path = fixtureSocketPath(root, 'browser-login')
  const server = createServer((socket) => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      socket.end(JSON.stringify(handler(request)))
    })
  })
  servers.push(server)
  await fixture.listen(server, path)
  return path
}

describe('isolated browser saved-login registry', () => {
  it('reads a live exact browser selection and preserves old static selections', async () => {
    let sharing: unknown = { managed: true, legacy: true, override: null }
    const requests: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      requests.push(request)
      if (request.action === 'sharing-status' && request.session === SESSION) return sharing
      return request.action === 'status' && request.session === SHARED_SESSION
        ? { available: true } : { error: 'unavailable' }
    })
    const open = vi.fn(() => fixture.connect({ path: socketPath }))
    const browser = new VpsIsolatedBrowser({ socketPath: INSTALLED_CONTROL, bots: [BOT] }, { connect: open })
    const legacy = new VpsIsolatedBrowser({ socketPath: INSTALLED_CONTROL, bots: [BOT], sharedBots: [BOT] }, { connect: open })
    const signal = new AbortController().signal
    await expect(browser.sharingPolicy(BOT, SESSION, signal)).resolves.toEqual({ managed: true, enabled: false })
    await expect(legacy.sharingPolicy(BOT, SESSION, signal)).resolves.toEqual({ managed: true, enabled: true })
    sharing = { managed: true, legacy: false, override: true }
    await expect(browser.availableInSharedSession(BOT, SHARED_SESSION, SESSION, signal)).resolves.toBe(true)
    sharing = { managed: true, legacy: true, override: false }
    await expect(legacy.availableInSharedSession(BOT, SHARED_SESSION, SESSION, signal)).resolves.toBe(false)
    sharing = { managed: false, legacy: true, override: true }
    await expect(browser.availableInSharedSession(BOT, SHARED_SESSION, SESSION, signal)).resolves.toBe(false)
    sharing = { error: 'unavailable' }
    await expect(legacy.availableInSharedSession(BOT, SHARED_SESSION, SESSION, signal)).resolves.toBe(true)
    expect(requests.at(-1)).toEqual({ action: 'status', bot: BOT, session: SHARED_SESSION })
    expect(requests.filter(request => request.action === 'sharing-status').every(
      request => request.bot === BOT && request.session === SESSION,
    )).toBe(true)
    expect(open).toHaveBeenCalledWith({ path: INSTALLED_CONTROL })
  })

  it('leases only creation, publishes owner metadata, polls status, and hides metadata from the result', async () => {
    const requests: Record<string, unknown>[] = []
    let statuses = 0
    const socketPath = await listen((request) => {
      requests.push(request)
      switch (request.action) {
        case 'request-login':
          return { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' }
        case 'login-status':
          statuses++
          return { state: statuses === 1 ? 'pending' : 'submitted' }
        default:
          throw new Error('unexpected action')
      }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], savedLogins: true })
    const sleep = vi.fn(async () => {})
    const logins = new VpsBrowserLogin(browser, { sleep })
    let leaseCalls = 0
    const lease: VpsBrowserLoginLease = async (operation) => {
      leaseCalls++
      return operation()
    }

    const result = await logins.request(BOT, SESSION, lease, new AbortController().signal)

    expect(result).toEqual({ state: 'submitted' })
    expect(leaseCalls).toBe(1)
    expect(sleep).toHaveBeenCalledOnce()
    expect(logins.current(SESSION)).toBeUndefined()
    expect(requests).toEqual([
      { action: 'request-login', bot: BOT, session: SESSION },
      { action: 'login-status', bot: BOT, session: SESSION, id: LOGIN_ID },
      { action: 'login-status', bot: BOT, session: SESSION, id: LOGIN_ID },
    ])
  })

  it.each(['signup', 'verification'] as const)('reserves a %s form for the direct owner chat', async (purpose) => {
    const origin = 'https://example.test'
    const destination = `${origin}/${purpose}`
    const actions: unknown[] = []
    let polls = 0
    const socketPath = await listen((request) => {
      actions.push(request.action)
      if (request.action === 'request-login') return { id: LOGIN_ID, origin, destination, purpose, state: 'pending' }
      if (request.action === 'login-status') return { state: polls++ === 0 ? 'pending' : 'submitted' }
      if (request.action === 'cancel-login') return { state: 'unavailable' }
      throw new Error('Unexpected browser request')
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], savedLogins: true })
    const automaticLogin = vi.fn(async () => 'submitted' as const)
    const lease: VpsBrowserLoginLease = operation => operation()
    const signal = new AbortController().signal
    const logins = new VpsBrowserLogin(browser, {
      automaticLogin,
      sleep: async () => {
        expect(logins.currentForOwner(BOT, SESSION)).toEqual({ id: LOGIN_ID, origin, destination, purpose })
      },
    })
    try {
      await expect(logins.requestForRoutine(BOT, SESSION, lease, signal))
        .resolves.toEqual({ state: 'approval-required', purpose })
      expect(logins.current(SESSION)).toBeUndefined()
      await expect(logins.request(BOT, SESSION, lease, signal)).resolves.toEqual({ state: 'submitted', purpose })
      expect(automaticLogin).not.toHaveBeenCalled()
      expect(actions).toEqual(['request-login', 'cancel-login', 'request-login', 'login-status', 'login-status'])
    } finally {
      await logins.dispose()
    }
  })

  it('uses the automatic grant during a private routine while the Bot holds the browser', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: INSTALLED_CONTROL, bots: [BOT], savedLogins: true })
    const pending = { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' as const }
    const open = vi.spyOn(browser, 'requestLogin').mockResolvedValue(pending)
    const status = vi.spyOn(browser, 'loginStatus').mockResolvedValue('unavailable')
    let held = false
    const lease: VpsBrowserLoginLease = async (operation) => {
      held = true
      try { return await operation() } finally { held = false }
    }
    const automaticLogin = vi.fn(async () => {
      expect(held).toBe(true)
      return 'submitted' as const
    })
    const logins = new VpsBrowserLogin(browser, { automaticLogin })
    try {
      const result = await logins.requestForRoutine(BOT, SESSION, lease, new AbortController().signal)
      expect(result).toEqual({ state: 'submitted' })
      expect(open).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, expect.any(AbortSignal))
      expect(automaticLogin).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, LOGIN_ID, expect.any(AbortSignal))
      expect(status).not.toHaveBeenCalled()
      expect(logins.current(SESSION)).toBeUndefined()
    } finally {
      await logins.dispose()
    }
  })

  it('releases an unapproved routine login and still offers manual approval in a direct owner chat', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: INSTALLED_CONTROL, bots: [BOT], savedLogins: true })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const status = vi.spyOn(browser, 'loginStatus').mockResolvedValue('submitted')
    const logins = new VpsBrowserLogin(browser, { automaticLogin: async () => 'approval-required' })
    const lease: VpsBrowserLoginLease = async operation => operation()
    const signal = new AbortController().signal
    try {
      await expect(logins.requestForRoutine(BOT, SESSION, lease, signal)).resolves.toEqual({ state: 'approval-required' })
      expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, LOGIN_ID, expect.any(AbortSignal))
      expect(status).not.toHaveBeenCalled()
      expect(logins.current(SESSION)).toBeUndefined()
      await expect(logins.request(BOT, SESSION, lease, signal)).resolves.toEqual({ state: 'submitted' })
      expect(status).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, LOGIN_ID, expect.any(AbortSignal))
    } finally {
      await logins.dispose()
    }
  })

  it('keeps one pending request per Session and withdraws it on abort', async () => {
    let releaseSleep: (() => void) | undefined
    const socketPath = await listen((request) => {
      switch (request.action) {
        case 'request-login':
          return { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' }
        case 'login-status':
          return { state: 'pending' }
        case 'cancel-login':
          return { state: 'unexpected' }
        default:
          throw new Error('unexpected action')
      }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], savedLogins: true })
    const logins = new VpsBrowserLogin(browser, {
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve }),
    })
    const firstController = new AbortController()
    const first = logins.request(BOT, SESSION, async operation => operation(), firstController.signal)
    const opening = { pending: logins.hasPending(SESSION), visible: logins.current(SESSION) }
    await expect.poll(() => logins.current(SESSION)).toMatchObject({ id: LOGIN_ID })
    await expect(logins.request(BOT, SESSION, async operation => operation(), new AbortController().signal))
      .rejects.toThrow('already pending')

    firstController.abort()
    releaseSleep?.()
    await expect(first).resolves.toEqual({ state: 'unavailable' })
    expect(logins.current(SESSION)).toBeUndefined()
    expect(opening).toEqual({ pending: true, visible: undefined })
    expect(logins.hasPending(SESSION)).toBe(false)
  })

  it('keeps authorization and broker failures state-only', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/missing-browser-login.sock', bots: [BOT] })
    const logins = new VpsBrowserLogin(browser)
    const lease = async <T>(operation: () => Promise<T>) => operation()

    await expect(logins.request('bot-other', SESSION, lease, new AbortController().signal))
      .rejects.toThrow('not authorized')
    await expect(logins.request(BOT, '', lease, new AbortController().signal))
      .rejects.toThrow('unavailable')
    const aborted = new AbortController()
    aborted.abort()
    await expect(logins.request(BOT, SESSION, lease, aborted.signal))
      .resolves.toEqual({ state: 'unavailable' })
    await expect(logins.request(BOT, SESSION, lease, new AbortController().signal))
      .resolves.toEqual({ state: 'unavailable' })
  })

  it('rejects unsupported shared and routine admissions before starting a login', async () => {
    const browser = new VpsIsolatedBrowser({
      socketPath: '/run/browser-login-fixture.sock', bots: [BOT], sharedBots: [BOT], savedLogins: true,
    })
    const requestLogin = vi.spyOn(browser, 'requestLogin')
    const logins = new VpsBrowserLogin(browser)
    const lease: VpsBrowserLoginLease = operation => operation()
    try {
      await expect(logins.request(BOT, SHARED_SESSION, lease, new AbortController().signal))
        .rejects.toThrow('not authorized')
      await expect(logins.requestForRoutine(BOT, SHARED_SESSION, lease, new AbortController().signal))
        .rejects.toThrow('not authorized')
      await expect(logins.requestForRoutine(BOT, SESSION, lease, new AbortController().signal))
        .resolves.toEqual({ state: 'approval-required' })
      expect(requestLogin).not.toHaveBeenCalled()
    } finally {
      await logins.dispose()
    }
  })

  it('requires the Cloud allowlist before opening a shared browser', async () => {
    const socket = vi.fn(() => { throw new Error('unexpected connection') })
    const socketPath = '/run/browser-fixture.sock'
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] }, { connect: socket })
    await expect(browser.status(BOT, SHARED_SESSION, new AbortController().signal)).rejects.toThrow('not authorized')
    expect(socket).not.toHaveBeenCalled()
    expect(() => new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: ['bot-other'] }))
      .toThrow('select')
    expect(() => new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT, BOT] }))
      .toThrow('unique')
  })

  it('offers a shared request in the exact owner Bot chat and withdraws it when the turn ends', async () => {
    const commands: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      commands.push(request)
      return request.action === 'request-login'
        ? { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' }
        : request.action === 'login-status' ? { state: 'pending' } : { state: 'unavailable' }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT, 'bot-other'], sharedBots: [BOT], savedLogins: true })
    const automaticLogin = vi.fn(async () => 'submitted' as const)
    const logins = new VpsBrowserLogin(browser, { automaticLogin })
    const controller = new AbortController()
    const pending = logins.request(BOT, SHARED_SESSION, async operation => operation(), controller.signal,
      async (_signal, start) => { start?.(); return true })
    try {
      await expect.poll(() => logins.current(SHARED_SESSION)).toMatchObject({ id: LOGIN_ID })
      const ctx = new Context()
      ctx.provide('bots', {
        ownerBotForSession: async (session: string) => {
          if (session === SESSION) return { id: BOT, sessionId: session, state: 'active' }
          if (session === 'other-owner') return { id: 'bot-other', sessionId: session, state: 'active' }
        },
      } as never)
      const route = vpsBrowserLoginRoute(ctx, logins)
      const fetch = (session: string) => route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=${session}`))
      await expect((await fetch(SESSION)).json()).resolves.toEqual({
        request: { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', scope: 'shared' },
      })
      await expect((await fetch(SHARED_SESSION)).json()).resolves.toEqual({ request: null })
      await expect((await fetch('other-owner')).json()).resolves.toEqual({ request: null })
      controller.abort()
      await expect(pending).resolves.toEqual({ state: 'unavailable' })
      expect(automaticLogin).not.toHaveBeenCalled()
      expect(commands).toContainEqual({ action: 'cancel-login', bot: BOT, session: SHARED_SESSION, id: LOGIN_ID })
      await expect((await fetch(SESSION)).json()).resolves.toEqual({ request: null })
    } finally {
      controller.abort()
      await logins.dispose()
    }
  })

  it('withdraws expired shared metadata from the owner lookup', async () => {
    const browser = new VpsIsolatedBrowser({
      socketPath: '/run/browser-login-fixture.sock', bots: [BOT], sharedBots: [BOT], savedLogins: true,
    })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    vi.spyOn(browser, 'loginStatus').mockResolvedValue('pending')
    vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    let now = 0
    let releaseSleep: (() => void) | undefined
    const logins = new VpsBrowserLogin(browser, {
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve }), now: () => now,
    })
    const controller = new AbortController()
    const admit = async (_signal: AbortSignal, start?: () => void): Promise<boolean> => {
      start?.()
      return true
    }
    const pending = logins.request(BOT, SHARED_SESSION, operation => operation(), controller.signal, admit)
    await expect.poll(() => logins.current(SHARED_SESSION)).toMatchObject({ id: LOGIN_ID, scope: 'shared' })
    expect(logins.currentForOwner(BOT, SESSION)).toMatchObject({ id: LOGIN_ID, scope: 'shared' })
    now = Number.MAX_SAFE_INTEGER
    expect(logins.currentForOwner(BOT, SESSION)).toBeUndefined()
    controller.abort()
    releaseSleep?.()
    await expect(pending).resolves.toEqual({ state: 'unavailable' })
    expect(logins.hasPending(SHARED_SESSION)).toBe(false)
  })

  it('returns a purpose when a shared form cannot be submitted and cancels it', async () => {
    const browser = new VpsIsolatedBrowser({
      socketPath: '/run/browser-login-fixture.sock', bots: [BOT], sharedBots: [BOT], savedLogins: true,
    })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/signup',
      purpose: 'signup', state: 'pending',
    })
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const logins = new VpsBrowserLogin(browser)
    const admit = async (_signal: AbortSignal, start?: () => void): Promise<boolean> => {
      start?.()
      return true
    }
    try {
      await expect(logins.request(BOT, SHARED_SESSION, operation => operation(), new AbortController().signal, admit))
        .resolves.toEqual({ state: 'unavailable', purpose: 'signup' })
      expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, SHARED_SESSION, LOGIN_ID, expect.any(AbortSignal))
      expect(logins.hasPending(SHARED_SESSION)).toBe(false)
    } finally {
      await logins.dispose()
    }
  })

  it('cleans the pending marker when a lease does not start the broker request', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT] })
    const requestLogin = vi.spyOn(browser, 'requestLogin')
    const logins = new VpsBrowserLogin(browser)
    const lease: VpsBrowserLoginLease = async <T>(_operation: () => Promise<T>): Promise<T> => undefined as T
    try {
      await expect(logins.request(BOT, SESSION, lease, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable' })
      expect(requestLogin).not.toHaveBeenCalled()
      expect(logins.hasPending(SESSION)).toBe(false)
    } finally {
      await logins.dispose()
    }
  })

  it('maps automatic owner outcomes for direct and routine requests', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT], savedLogins: true })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const lease: VpsBrowserLoginLease = operation => operation()
    const direct = new VpsBrowserLogin(browser, { automaticLogin: async () => 'needs-owner' })
    await expect(direct.request(BOT, 'private-session', lease, new AbortController().signal))
      .resolves.toEqual({ state: 'needs-owner' })
    await direct.dispose()

    const admittedDirect = new VpsBrowserLogin(browser, { automaticLogin: async () => 'needs-owner' })
    const admitPrivate = async (_signal: AbortSignal, start?: () => void): Promise<boolean> => {
      start?.()
      return true
    }
    await expect(admittedDirect.request(BOT, 'private-session', lease, new AbortController().signal, admitPrivate))
      .resolves.toEqual({ state: 'needs-owner' })
    await admittedDirect.dispose()

    const routineNeedsOwner = new VpsBrowserLogin(browser, { automaticLogin: async () => 'needs-owner' })
    await expect(routineNeedsOwner.requestForRoutine(BOT, 'private-session', lease, new AbortController().signal))
      .resolves.toEqual({ state: 'approval-required' })
    await routineNeedsOwner.dispose()

    const routine = new VpsBrowserLogin(browser, { automaticLogin: async () => 'unavailable' })
    try {
      await expect(routine.requestForRoutine(BOT, 'private-session', lease, new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable' })
      expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, 'private-session', LOGIN_ID, expect.any(AbortSignal))
    } finally {
      await routine.dispose()
    }
  })

  it('returns a purpose when a private broker sends a shared approval challenge', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT], savedLogins: true })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/verify',
      purpose: 'verification', state: 'pending',
    })
    vi.spyOn(browser, 'loginStatus').mockResolvedValue({ state: 'approval-pending', challenge: LOGIN_ID })
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const logins = new VpsBrowserLogin(browser)
    try {
      await expect(logins.request(BOT, SESSION, operation => operation(), new AbortController().signal))
        .resolves.toEqual({ state: 'unavailable', purpose: 'verification' })
      expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, LOGIN_ID, expect.any(AbortSignal))
    } finally {
      await logins.dispose()
    }
  })

  it('cancels a shared login when access is revoked before polling', async () => {
    const browser = new VpsIsolatedBrowser({
      socketPath: '/run/browser-login-fixture.sock', bots: [BOT], sharedBots: [BOT], savedLogins: true,
    })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    const status = vi.spyOn(browser, 'loginStatus')
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const access = vi.fn(async (_signal: AbortSignal, start?: () => void): Promise<boolean> => {
      if (start !== undefined) {
        start()
        return true
      }
      return false
    })
    const logins = new VpsBrowserLogin(browser, { sleep: async () => {} })
    try {
      await expect(logins.request(BOT, SHARED_SESSION, operation => operation(), new AbortController().signal, access))
        .resolves.toEqual({ state: 'unavailable' })
      expect(access).toHaveBeenCalledTimes(2)
      expect(status).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, SHARED_SESSION, LOGIN_ID, expect.any(AbortSignal))
    } finally {
      await logins.dispose()
    }
  })

  it('starts shared login submission under current access and withholds the result after revocation', async () => {
    const commands: string[] = []
    const challenge = 'b'.repeat(32)
    let accessible = true
    let started = false
    let allowBrowserSubmit = true
    const socketPath = await listen((request) => {
      commands.push(String(request.action))
      if (request.action === 'request-login') {
        return { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' }
      }
      if (request.action === 'authorize-login') {
        expect(request).toMatchObject({ session: SHARED_SESSION, bot: BOT, id: LOGIN_ID, challenge })
        started = true
        return { ok: true }
      }
      if (request.action === 'cancel-login') return { state: 'unavailable' }
      if (started || !allowBrowserSubmit) accessible = false
      return started ? { state: 'submitted' } : { state: 'approval-pending', challenge }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT], savedLogins: true })
    const logins = new VpsBrowserLogin(browser, { sleep: async () => {} })
    const authorized = async (_signal: AbortSignal, start?: () => void): Promise<boolean> => {
      if (!accessible) return false
      start?.()
      return true
    }
    const run = (): Promise<import('../src/vps-browser-login.ts').VpsBrowserLoginResult> => logins.request(
      BOT, SHARED_SESSION, async operation => operation(), new AbortController().signal, authorized,
    )
    try {
      await expect(run()).resolves.toEqual({ state: 'unavailable' })
      expect(commands).toEqual(['request-login', 'login-status', 'authorize-login', 'login-status', 'cancel-login'])
      commands.length = 0
      accessible = true
      started = false
      allowBrowserSubmit = false
      await expect(run()).resolves.toEqual({ state: 'unavailable' })
      expect(commands).toEqual(['request-login', 'login-status', 'cancel-login'])
    } finally {
      await logins.dispose()
    }
  })

  it('uses the bounded default poll delay', async () => {
    vi.useFakeTimers()
    try {
      const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT] })
      vi.spyOn(browser, 'requestLogin').mockResolvedValue({
        id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
      })
      let polls = 0
      vi.spyOn(browser, 'loginStatus').mockImplementation(async () => polls++ === 0 ? 'pending' : 'submitted')
      const logins = new VpsBrowserLogin(browser)
      const lease = async <T>(operation: () => Promise<T>) => operation()
      const result = logins.request(BOT, SESSION, lease, new AbortController().signal)
      for (let index = 0; index < 5; index++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(result).resolves.toEqual({ state: 'submitted' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a broker that stays pending', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT] })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    const status = vi.spyOn(browser, 'loginStatus').mockResolvedValue('pending')
    const cancel = vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const logins = new VpsBrowserLogin(browser, { sleep: async () => {} })
    const lease = async <T>(operation: () => Promise<T>) => operation()

    await expect(logins.request(BOT, SESSION, lease, new AbortController().signal))
      .resolves.toEqual({ state: 'unavailable' })
    expect(status).toHaveBeenCalledTimes(150)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(BOT, SESSION, LOGIN_ID, expect.any(AbortSignal))
  })

  it('caps simultaneous pending Sessions', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/browser-login-fixture.sock', bots: [BOT] })
    vi.spyOn(browser, 'requestLogin').mockResolvedValue({
      id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending',
    })
    vi.spyOn(browser, 'loginStatus').mockResolvedValue('pending')
    vi.spyOn(browser, 'cancelLogin').mockResolvedValue('unavailable')
    const logins = new VpsBrowserLogin(browser, {
      sleep: (_milliseconds, signal) => new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          signal.removeEventListener('abort', onAbort)
          reject(new Error('aborted'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        void resolve
      }),
    })
    const lease = async <T>(operation: () => Promise<T>) => operation()
    const running = Array.from({ length: 64 }, (_, index) => logins.request(
      BOT, `bot-session-${String(index)}`, lease, new AbortController().signal,
    ))
    await expect(logins.request(BOT, 'bot-session-overflow', lease, new AbortController().signal))
      .resolves.toEqual({ state: 'unavailable' })
    await logins.dispose()
    await Promise.all(running)
  })

  it('returns metadata only to an active owner Session', async () => {
    let releaseSleep: (() => void) | undefined
    let now = 0
    const socketPath = await listen(request => request.action === 'request-login'
      ? { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login', state: 'pending' }
      : request.action === 'login-status' ? { state: 'pending' } : { state: 'unavailable' })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], savedLogins: true })
    const logins = new VpsBrowserLogin(browser, {
      sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve }),
      now: () => now,
    })
    const lease = async <T>(operation: () => Promise<T>) => operation()
    const controller = new AbortController()
    const pending = logins.request(BOT, SESSION, lease, controller.signal)
    await expect.poll(() => logins.current(SESSION)).toMatchObject({ id: LOGIN_ID })

    const ctx = new Context()
    ctx.provide('bots', {
      ownerBotForSession: async (session: string) => {
        if (session === SESSION || session === 'empty-session') return { id: BOT, sessionId: session, state: 'active' }
        if (session === 'unauthorized-session') return { id: 'bot-other', sessionId: session, state: 'active' }
      },
    } as never)
    const route = vpsBrowserLoginRoute(ctx, logins)
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=${encodeURIComponent(SESSION)}`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      request: { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login' },
    })
    const other = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=other`))
    await expect(other.json()).resolves.toEqual({ request: null })
    const extra = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=${encodeURIComponent(SESSION)}&extra=1`))
    await expect(extra.json()).resolves.toEqual({ request: null })
    const invalid = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=%00`))
    await expect(invalid.json()).resolves.toEqual({ request: null })
    const empty = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=empty-session`))
    await expect(empty.json()).resolves.toEqual({ request: null })
    const unauthorized = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=unauthorized-session`))
    await expect(unauthorized.json()).resolves.toEqual({ request: null })

    now = Number.MAX_SAFE_INTEGER
    expect(logins.current(SESSION)).toBeUndefined()
    releaseSleep?.()
    await expect(pending).resolves.toEqual({ state: 'unavailable' })
  })
})
