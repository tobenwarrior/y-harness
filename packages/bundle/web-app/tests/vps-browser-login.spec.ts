import { createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsIsolatedBrowser } from '../src/vps-isolated-browser.ts'
import { VpsBrowserLogin, type VpsBrowserLoginLease, vpsBrowserLoginRoute } from '../src/vps-browser-login.ts'

const BOT = 'bot-login'
const SESSION = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const LOGIN_ID = '0123456789abcdef0123456789abcdef'

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function listen(handler: (request: Record<string, unknown>) => unknown): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-browser-login-'))
  roots.push(root)
  const path = join(root, 'broker.sock')
  const server = createServer((socket) => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      socket.end(JSON.stringify(handler(request)))
    })
  })
  servers.push(server)
  server.listen(path)
  await once(server, 'listening')
  return path
}

describe('isolated browser saved-login registry', () => {
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
    await expect.poll(() => logins.current(SESSION)).toMatchObject({ id: LOGIN_ID })
    await expect(logins.request(BOT, SESSION, async operation => operation(), new AbortController().signal))
      .rejects.toThrow('already pending')

    firstController.abort()
    releaseSleep?.()
    await expect(first).resolves.toEqual({ state: 'unavailable' })
    expect(logins.current(SESSION)).toBeUndefined()
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
      ownerBotForSession: async (session: string) => session === SESSION
        ? { id: BOT, sessionId: SESSION, state: 'active' }
        : undefined,
    } as never)
    const route = vpsBrowserLoginRoute(ctx, logins)
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=${encodeURIComponent(SESSION)}`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      request: { id: LOGIN_ID, origin: 'https://example.test', destination: 'https://example.test/login' },
    })
    const other = await route.fetch(new Request(`http://127.0.0.1${route.path}?sessionId=other`))
    await expect(other.json()).resolves.toEqual({ request: null })

    now = Number.MAX_SAFE_INTEGER
    expect(logins.current(SESSION)).toBeUndefined()
    releaseSleep?.()
    await expect(pending).resolves.toEqual({ state: 'unavailable' })
  })
})
