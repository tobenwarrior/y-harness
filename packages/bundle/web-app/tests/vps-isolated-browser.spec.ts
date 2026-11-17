import { createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_HEIGHT, COMPUTER_WIDTH, type ComputerAction } from '../src/computer.ts'
import {
  isSharedBrowserSession,
  runAuthorizedBrowserOperation,
  validateIsolatedBrowserUrl,
  type VpsBrowserHandoff,
  VpsIsolatedBrowser,
} from '../src/vps-isolated-browser.ts'

const BOT = 'bot-isolated'
const SESSION = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

const roots: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => { resolve() })
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function listen(handler: (request: Record<string, unknown>) => unknown): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-isolated-browser-'))
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

async function listenRaw(response: string | Buffer, onRequest?: (request: Record<string, unknown>) => void): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-isolated-browser-'))
  roots.push(root)
  const path = join(root, 'broker.sock')
  const server = createServer((socket) => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('end', () => {
      if (onRequest !== undefined) onRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      socket.end(response)
    })
  })
  servers.push(server)
  server.listen(path)
  await once(server, 'listening')
  return path
}

describe('isolated browser broker client', () => {
  it('probes and restarts only the configured owner browser', async () => {
    const requests: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      requests.push(request)
      if (request.action === 'status') return { available: true }
      return { status: 'restarted' }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    const signal = new AbortController().signal
    await expect(browser.restartAvailable(BOT, SESSION, signal)).resolves.toBe(true)
    await expect(browser.restart(BOT, SESSION, signal)).resolves.toBe('restarted')
    await expect(browser.restart(BOT, 'shared-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76', signal)).rejects.toThrow()
    await expect(browser.restartAvailable(BOT, 'shared-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76', signal)).resolves.toBe(false)
    const invalidRestartPath = await listen(() => ({ status: 'invalid' }))
    const invalidRestartBrowser = new VpsIsolatedBrowser({ socketPath: invalidRestartPath, bots: [BOT] })
    await expect(invalidRestartBrowser.restartAvailable(BOT, SESSION, signal)).resolves.toBe(false)
    await expect(invalidRestartBrowser.restart(BOT, SESSION, signal)).rejects.toThrow('The isolated browser response was invalid.')
    expect(requests).toEqual([
      { action: 'status', bot: BOT, session: SESSION, capability: 'restart' },
      { action: 'restart', bot: BOT, session: SESSION },
    ])
  })

  it('sends one request with the Bot and canonical Session and decodes each operation', async () => {
    const requests: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      requests.push(request)
      switch (request.action) {
        case 'status': return { available: true }
        case 'frame': return { jpeg: JPEG.toString('base64'), width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }
        case 'input': return { ok: true }
        case 'navigate': return { ok: true }
        default: throw new Error('unexpected action')
      }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })
    const action: ComputerAction = { kind: 'click', x: 4, y: 5, button: 1 }

    await expect(browser.status(BOT, SESSION, new AbortController().signal)).resolves.toEqual({ available: true })
    await expect(browser.frame(BOT, SESSION, new AbortController().signal)).resolves.toEqual(JPEG)
    await expect(browser.input(BOT, SESSION, action, new AbortController().signal)).resolves.toBeUndefined()
    await expect(browser.navigate(BOT, SESSION, 'https://example.test/path', new AbortController().signal)).resolves.toBeUndefined()
    const computer = browser.computer(BOT, SESSION)
    await expect(computer.observe()).resolves.toMatchObject({
      jpeg: JPEG.toString('base64'), width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT,
    })
    await expect(computer.botAction(action)).resolves.toBeUndefined()
    await computer.dispose()
    expect(requests).toEqual([
      { action: 'status', bot: BOT, session: SESSION },
      { action: 'frame', bot: BOT, session: SESSION },
      { action: 'input', bot: BOT, session: SESSION, input: action },
      { action: 'navigate', bot: BOT, session: SESSION, url: 'https://example.test/path' },
      { action: 'frame', bot: BOT, session: SESSION },
      { action: 'input', bot: BOT, session: SESSION, input: action },
    ])
  })

  it('exchanges saved-login requests using the Bot and canonical Session', async () => {
    const requests: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      requests.push(request)
      switch (request.action) {
        case 'request-login': return { id: '0123456789abcdef0123456789abcdef', origin: 'https://example.test', destination: 'https://example.test/login-123', state: 'pending' }
        case 'login-status': return { state: 'submitted' }
        case 'cancel-login': return { state: 'unavailable' }
        default: throw new Error('unexpected action')
      }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })
    const signal = new AbortController().signal

    await expect(browser.requestLogin(BOT, SESSION, signal)).resolves.toEqual({
      id: '0123456789abcdef0123456789abcdef', origin: 'https://example.test', destination: 'https://example.test/login-123', state: 'pending',
    })
    await expect(browser.loginStatus(BOT, SESSION, '0123456789abcdef0123456789abcdef', signal)).resolves.toBe('submitted')
    await expect(browser.cancelLogin(BOT, SESSION, '0123456789abcdef0123456789abcdef', signal)).resolves.toBe('unavailable')
    expect(requests).toEqual([
      { action: 'request-login', bot: BOT, session: SESSION },
      { action: 'login-status', bot: BOT, session: SESSION, id: '0123456789abcdef0123456789abcdef' },
      { action: 'cancel-login', bot: BOT, session: SESSION, id: '0123456789abcdef0123456789abcdef' },
    ])
  })

  it('rejects malformed saved-login broker responses', async () => {
    const socketPath = await listen(request => request.action === 'request-login'
      ? { id: '0123456789abcdef0123456789abcdef', origin: 'https://example.test', destination: 'https://example.test/login-123', state: 'submitted' }
      : { state: 'unknown' })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })

    await expect(browser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    await expect(browser.loginStatus(BOT, SESSION, '0123456789abcdef0123456789abcdef', new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    await expect(browser.loginStatus(BOT, SESSION, 'invalid-id', new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    await expect(browser.cancelLogin(BOT, SESSION, 'invalid-id', new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const invalidPurposePath = await listen(() => ({
      id: '0123456789abcdef0123456789abcdef', origin: 'https://example.test', destination: 'https://example.test/login',
      state: 'pending', purpose: 'unknown',
    }))
    const invalidPurposeBrowser = new VpsIsolatedBrowser({ socketPath: invalidPurposePath, bots: [BOT] })
    await expect(invalidPurposeBrowser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const crossOriginPath = await listen(() => ({
      id: '0123456789abcdef0123456789abcdef', origin: 'https://example.test', destination: 'https://other.test/login', state: 'pending',
    }))
    const crossOriginBrowser = new VpsIsolatedBrowser({ socketPath: crossOriginPath, bots: [BOT] })
    await expect(crossOriginBrowser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const missingOriginPath = await listen(() => ({
      id: '0123456789abcdef0123456789abcdef', origin: null, destination: 'https://example.test/login', state: 'pending',
    }))
    const missingOriginBrowser = new VpsIsolatedBrowser({ socketPath: missingOriginPath, bots: [BOT] })
    await expect(missingOriginBrowser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const malformedUrlPath = await listen(() => ({
      id: '0123456789abcdef0123456789abcdef', origin: 'https://[::1', destination: 'https://[::1/login', state: 'pending',
    }))
    const malformedUrlBrowser = new VpsIsolatedBrowser({ socketPath: malformedUrlPath, bots: [BOT] })
    await expect(malformedUrlBrowser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const nullResponsePath = await listen(() => null)
    const nullResponseBrowser = new VpsIsolatedBrowser({ socketPath: nullResponsePath, bots: [BOT] })
    await expect(nullResponseBrowser.requestLogin(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
  })

  it('validates trusted configuration and model navigation URLs', () => {
    expect(() => new VpsIsolatedBrowser({ socketPath: 'relative.sock', bots: [BOT] })).toThrow('socketPath must be absolute')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser\u0000.sock', bots: [BOT] })).toThrow('socketPath must be absolute')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [] })).toThrow('at least one valid Bot')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [''] })).toThrow('at least one valid Bot')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: ['bot\u0000'] })).toThrow('at least one valid Bot')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT, BOT] })).toThrow('must be unique')
    expect(validateIsolatedBrowserUrl('https://example.test/path')).toBe('https://example.test/path')
    expect(validateIsolatedBrowserUrl('HTTPS://EXAMPLE.TEST/path')).toBe('https://example.test/path')
    expect(() => validateIsolatedBrowserUrl('not a URL')).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('https://[::1')).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('https://example.test/a b')).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('file:///tmp/private')).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('https://user:password@example.test')).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('https://example.test/' + 'a'.repeat(4_096))).toThrow('URL is invalid')
    expect(() => validateIsolatedBrowserUrl('https://example.test/\u0000')).toThrow('URL is invalid')
  })

  it('rejects an unauthorized Bot before opening the broker socket', async () => {
    const socketPath = await listen(() => ({ available: true }))
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })

    await expect(browser.status('bot-other', SESSION, new AbortController().signal))
      .rejects.toThrow('This Bot is not authorized for the isolated browser.')
  })

  it('rejects invalid frames and navigation URLs without exposing broker diagnostics', async () => {
    const socketPath = await listen(request => request.action === 'frame'
      ? { jpeg: 'not-base64', width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }
      : { ok: true })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })

    await expect(browser.frame(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    const wrongDimensionsPath = await listen(() => ({ jpeg: JPEG.toString('base64'), width: 1, height: COMPUTER_HEIGHT }))
    const wrongDimensionsBrowser = new VpsIsolatedBrowser({ socketPath: wrongDimensionsPath, bots: [BOT] })
    await expect(wrongDimensionsBrowser.frame(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    await expect(browser.navigate(BOT, SESSION, 'file:///tmp/private', new AbortController().signal))
      .rejects.toThrow('The isolated browser URL is invalid.')
    await expect(browser.navigate(BOT, SESSION, 'https://user:password@example.test', new AbortController().signal))
      .rejects.toThrow('The isolated browser URL is invalid.')
  })

  it('rejects invalid status and input acknowledgements', async () => {
    const statusPath = await listen(() => ({ available: false }))
    const statusBrowser = new VpsIsolatedBrowser({ socketPath: statusPath, bots: [BOT] })
    await expect(statusBrowser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const ackPath = await listen(() => ({ ok: false }))
    const ackBrowser = new VpsIsolatedBrowser({ socketPath: ackPath, bots: [BOT] })
    await expect(ackBrowser.input(BOT, SESSION, { kind: 'move', x: 1, y: 2 }, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
  })

  it('rejects oversized and malformed broker responses with fixed errors', async () => {
    const oversizedPath = await listenRaw(Buffer.alloc(3 * 1024 * 1024 + 1, 0x20))
    const oversizedBrowser = new VpsIsolatedBrowser({ socketPath: oversizedPath, bots: [BOT] })
    await expect(oversizedBrowser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const malformedPath = await listenRaw(Buffer.from([0xff, 0xfe]))
    const malformedBrowser = new VpsIsolatedBrowser({ socketPath: malformedPath, bots: [BOT] })
    await expect(malformedBrowser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const emptyPath = await listenRaw(Buffer.alloc(0))
    const emptyBrowser = new VpsIsolatedBrowser({ socketPath: emptyPath, bots: [BOT] })
    await expect(emptyBrowser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser is unavailable.')
  })

  it('enforces the JPEG size and signature limits', async () => {
    const oversizedJpeg = Buffer.alloc(2 * 1024 * 1024 + 1)
    oversizedJpeg[0] = 0xff
    oversizedJpeg[1] = 0xd8
    const path = await listen(() => ({ jpeg: oversizedJpeg.toString('base64'), width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }))
    const browser = new VpsIsolatedBrowser({ socketPath: path, bots: [BOT] })
    await expect(browser.frame(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const noJpegPath = await listen(() => ({ jpeg: 'AP8=', width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }))
    const noJpegBrowser = new VpsIsolatedBrowser({ socketPath: noJpegPath, bots: [BOT] })
    await expect(noJpegBrowser.frame(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
  })

  it('returns fixed failures for missing sockets, invalid sessions, and pre-aborted signals', async () => {
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/does-not-exist-yharness-browser.sock', bots: [BOT] })
    await expect(browser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser is unavailable.')
    await expect(browser.status(BOT, '', new AbortController().signal))
      .rejects.toThrow('The isolated browser is unavailable.')
    const controller = new AbortController()
    controller.abort()
    await expect(browser.status(BOT, SESSION, controller.signal))
      .rejects.toThrow('The isolated browser request was cancelled.')
    const hugeBot = 'b'.repeat(20_000)
    const hugeBrowser = new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [hugeBot] })
    await expect(hugeBrowser.status(hugeBot, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')
    expect(() => hugeBrowser.computer('not-authorized', SESSION)).toThrow('not authorized')
    const throwingBrowser = new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT] }, {
      connect: () => { throw new Error('private connect failure') },
    })
    await expect(throwingBrowser.status(BOT, SESSION, new AbortController().signal))
      .rejects.toThrow('The isolated browser is unavailable.')
  })

  it('aborts a broker request and closes the socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-isolated-browser-abort-'))
    roots.push(root)
    const path = join(root, 'broker.sock')
    const server = createServer((socket) => {
      socket.on('end', () => { /* Keep the response open until the client aborts. */ })
    })
    servers.push(server)
    server.listen(path)
    await once(server, 'listening')
    const browser = new VpsIsolatedBrowser({ socketPath: path, bots: [BOT] })
    const controller = new AbortController()
    const pending = browser.status(BOT, SESSION, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow('The isolated browser request was cancelled.')
  })

  it('times out a broker that keeps the response open', async () => {
    vi.useFakeTimers()
    try {
      const root = mkdtempSync(join(tmpdir(), 'dsh-isolated-browser-timeout-'))
      roots.push(root)
      const path = join(root, 'broker.sock')
      const server = createServer(() => {})
      servers.push(server)
      server.listen(path)
      await once(server, 'listening')
      const browser = new VpsIsolatedBrowser({ socketPath: path, bots: [BOT] })
      const pending = browser.status(BOT, SESSION, new AbortController().signal).then(
        () => new Error('expected timeout'),
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(pending).resolves.toMatchObject({ message: 'The isolated browser request timed out.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('validates owner rosters, shared selections, and authorization namespaces', () => {
    expect(isSharedBrowserSession('shared-session-fixture')).toBe(true)
    expect(isSharedBrowserSession(SESSION)).toBe(false)
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT], ownerRosterPath: 'relative' })).toThrow('ownerRosterPath must be absolute')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT], ownerRosterPath: '/run/roster\u0000' })).toThrow('ownerRosterPath must be absolute')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT], sharedBots: [BOT, BOT] })).toThrow('must be unique')
    expect(() => new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT], sharedBots: ['bot-other'] })).toThrow('already isolated')

    const managed = new VpsIsolatedBrowser({ socketPath: '/run/yharness-browser/control.sock', bots: [], ownerRosterPath: '/run/roster', sharedBots: [] })
    expect(managed.usesManagedSharing()).toBe(true)
    expect(managed.authorized(BOT, SESSION)).toBe(true)
    expect(managed.authorized(BOT, 'shared-session-fixture')).toBe(true)
    expect(managed.authorized('bot-other', 'shared-session-fixture')).toBe(true)
    const fixed = new VpsIsolatedBrowser({ socketPath: '/run/browser.sock', bots: [BOT], sharedBots: [BOT] })
    expect(fixed.usesManagedSharing()).toBe(false)
    expect(fixed.authorized(BOT, 'shared-session-fixture')).toBe(true)
    expect(fixed.authorized('bot-other', 'shared-session-fixture')).toBe(false)
  })

  it('gates shared admission through the managed browser policy and legacy status probe', async () => {
    let sharing: unknown = { managed: true, legacy: true, override: null }
    const socketPath = await listen(request => request.action === 'sharing-status' ? sharing : { available: true })
    const managed = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    vi.spyOn(managed, 'usesManagedSharing').mockReturnValue(true)
    expect(await managed.sharingPolicy(BOT, SESSION, new AbortController().signal)).toEqual({ managed: true, enabled: true })
    sharing = { managed: true, legacy: true, override: false }
    expect(await managed.sharingPolicy(BOT, SESSION, new AbortController().signal)).toEqual({ managed: true, enabled: false })
    sharing = { managed: true, legacy: false, override: true }
    expect(await managed.sharingPolicy(BOT, SESSION, new AbortController().signal)).toEqual({ managed: true, enabled: true })
    sharing = { managed: false, legacy: true, override: true }
    await expect(managed.sharingPolicy(BOT, SESSION, new AbortController().signal)).rejects.toThrow('response was invalid')
    sharing = { managed: true, legacy: false, override: 'invalid' }
    await expect(managed.sharingPolicy(BOT, SESSION, new AbortController().signal)).rejects.toThrow('response was invalid')
    await expect(managed.sharingPolicy(BOT, 'shared-session-fixture', new AbortController().signal)).rejects.toThrow('not authorized')
    sharing = { managed: true, legacy: true, override: null }
    await expect(managed.availableInSharedSession(BOT, 'shared-session-fixture', undefined, new AbortController().signal)).resolves.toBe(true)

    const fixed = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    expect(await fixed.availableInSharedSession(BOT, 'shared-session-fixture', undefined, new AbortController().signal)).toBe(true)
    expect(await fixed.availableInSharedSession('bot-other', 'shared-session-fixture', undefined, new AbortController().signal)).toBe(false)
    expect(await fixed.availableInSharedSession(BOT, SESSION, undefined, new AbortController().signal)).toBe(false)
    const aborted = new AbortController()
    aborted.abort()
    expect(await fixed.availableInSharedSession(BOT, 'shared-session-fixture', undefined, aborted.signal)).toBe(false)
  })

  it('falls back to the legacy shared status probe after owner-policy failure', async () => {
    let sharing: unknown = { managed: true, legacy: false, override: 'bad' }
    let statusAvailable = true
    const socketPath = await listen(request => request.action === 'sharing-status' ? sharing : statusAvailable ? { available: true } : { available: false })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    vi.spyOn(browser, 'usesManagedSharing').mockReturnValue(true)
    expect(await browser.availableInSharedSession(BOT, 'shared-session-fixture', SESSION, new AbortController().signal)).toBe(true)
    statusAvailable = false
    expect(await browser.availableInSharedSession(BOT, 'shared-session-fixture', SESSION, new AbortController().signal)).toBe(false)
    const noShared = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [] })
    expect(await noShared.availableInSharedSession(BOT, 'shared-session-fixture', SESSION, new AbortController().signal)).toBe(false)
    const managedNoShared = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [] })
    vi.spyOn(managedNoShared, 'usesManagedSharing').mockReturnValue(true)
    expect(await managedNoShared.availableInSharedSession(BOT, 'shared-session-fixture', undefined, new AbortController().signal)).toBe(false)
    sharing = { managed: true, legacy: true, override: false }
    expect(await browser.availableInSharedSession(BOT, 'shared-session-fixture', SESSION, new AbortController().signal)).toBe(false)
  })

  it('starts admitted browser work only after the current authority check', async () => {
    const signal = new AbortController().signal
    const started: string[] = []
    await expect(runAuthorizedBrowserOperation(async (_signal, start) => {
      start?.()
      return true
    }, async () => {
      started.push('operation')
      return 'done'
    }, signal)).resolves.toBe('done')
    expect(started).toEqual(['operation'])
    await expect(runAuthorizedBrowserOperation(async () => false, async () => 'unused', signal)).rejects.toThrow('unavailable')
    await expect(runAuthorizedBrowserOperation(async () => true, async () => 'unused', signal)).rejects.toThrow('unavailable')

    const operationError = new Error('fixture operation')
    await expect(runAuthorizedBrowserOperation(async (_signal, start) => {
      start?.()
      return true
    }, async () => { throw operationError }, signal)).rejects.toBe(operationError)
    const abortController = new AbortController()
    await expect(runAuthorizedBrowserOperation(async (_signal, start) => {
      abortController.abort()
      start?.()
      return true
    }, async () => 'never', abortController.signal)).rejects.toThrow('This operation was aborted')
    await expect(runAuthorizedBrowserOperation(async () => { throw new Error('authority failed') }, async () => 'unused', signal)).rejects.toThrow('authority failed')
  })

  it('handles owner-approved login purpose and shared handoff operations', async () => {
    const id = '0123456789abcdef0123456789abcdef'
    const lease = { bot: BOT, session: 'shared-session-fixture', lease: 'fixture-lease' as never } satisfies VpsBrowserHandoff
    const requests: Record<string, unknown>[] = []
    const socketPath = await listen((request) => {
      requests.push(request)
      switch (request.action) {
        case 'request-login': return { id, origin: 'https://example.test', destination: 'https://example.test/signup', state: 'pending', purpose: 'signup' }
        case 'login-status': return { state: 'approval-pending', challenge: id }
        case 'authorize-login':
        case 'cancel-login':
        case 'end-handoff':
        case 'navigate': return { ok: true }
        case 'begin-handoff': return { origin: 'https://example.test' }
        default: return { available: true }
      }
    })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    const signal = new AbortController().signal
    await expect(browser.requestLogin(BOT, SESSION, signal)).resolves.toMatchObject({ purpose: 'signup' })
    await expect(browser.loginStatus(BOT, SESSION, id, signal)).resolves.toEqual({ state: 'approval-pending', challenge: id })
    await expect(browser.authorizeLogin(BOT, lease.session, id, id, signal)).resolves.toBeUndefined()
    await expect(browser.authorizeLogin(BOT, SESSION, 'bad', id, signal)).rejects.toThrow('response was invalid')
    await expect(browser.beginHandoff(lease, signal)).resolves.toBe('https://example.test')
    await expect(browser.beginHandoff({ ...lease, session: SESSION }, signal)).rejects.toThrow('not authorized')
    await expect(browser.endHandoff(lease, 'complete', signal)).resolves.toBeUndefined()
    await expect(browser.navigateHandoff(lease, 'https://example.test/path', signal)).resolves.toBeUndefined()
    await expect(browser.navigateHandoff(lease, 'http://example.test/path', signal)).rejects.toThrow('URL is invalid')
    expect(requests.map(request => request.action)).toEqual([
      'request-login', 'login-status', 'authorize-login', 'begin-handoff', 'end-handoff', 'navigate',
    ])
  })

  it('uses the handoff Computer capture and origin-checked input seams', async () => {
    const lease = { bot: BOT, session: 'shared-session-fixture', lease: 'fixture-lease' as never } satisfies VpsBrowserHandoff
    let nullOrigin = false
    const socketPath = await listen(request => request.action === 'frame'
      ? { width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT, jpeg: JPEG.toString('base64'), origin: nullOrigin ? null : 'https://example.test' }
      : { ok: true })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT], sharedBots: [BOT] })
    const computer = browser.handoffComputer(lease, async (_signal, start) => {
      start?.()
      return true
    }, new AbortController().signal)
    await expect(computer.observe()).resolves.toMatchObject({ jpeg: JPEG.toString('base64'), browserOrigin: 'https://example.test' })
    nullOrigin = true
    await expect(computer.observe()).resolves.toMatchObject({ jpeg: JPEG.toString('base64'), browserOrigin: null })
    const viewer = '01234567-89ab-4cde-8fab-0123456789ab'
    await expect(computer.takeControl(viewer)).resolves.toEqual({ mode: 'controlling' })
    await expect(computer.input(viewer, { kind: 'click', x: 1, y: 2, button: 1 }, undefined, 'https://example.test')).resolves.toEqual({ mode: 'controlling' })
    await computer.dispose()
  })

  it('rejects malformed handoff origins and frames', async () => {
    const lease = { bot: BOT, session: 'shared-session-fixture', lease: 'fixture-lease' as never } satisfies VpsBrowserHandoff
    const invalidOriginPath = await listen(request => request.action === 'begin-handoff' ? { origin: null } : { ok: true })
    const invalidOriginBrowser = new VpsIsolatedBrowser({ socketPath: invalidOriginPath, bots: [BOT], sharedBots: [BOT] })
    await expect(invalidOriginBrowser.beginHandoff(lease, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const httpOriginPath = await listen(request => request.action === 'begin-handoff' ? { origin: 'http://example.test' } : { ok: true })
    const httpOriginBrowser = new VpsIsolatedBrowser({ socketPath: httpOriginPath, bots: [BOT], sharedBots: [BOT] })
    await expect(httpOriginBrowser.beginHandoff(lease, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const extraOriginPath = await listen(request => request.action === 'begin-handoff'
      ? { origin: 'https://example.test', extra: true } : { ok: true })
    const extraOriginBrowser = new VpsIsolatedBrowser({ socketPath: extraOriginPath, bots: [BOT], sharedBots: [BOT] })
    await expect(extraOriginBrowser.beginHandoff(lease, new AbortController().signal))
      .rejects.toThrow('The isolated browser response was invalid.')

    const invalidFramePath = await listen(request => request.action === 'frame'
      ? { width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT, jpeg: JPEG.toString('base64') } : { ok: true })
    const invalidFrameBrowser = new VpsIsolatedBrowser({ socketPath: invalidFramePath, bots: [BOT], sharedBots: [BOT] })
    const computer = invalidFrameBrowser.handoffComputer(lease, async (_signal, start) => {
      start?.()
      return true
    }, new AbortController().signal)
    await expect(computer.observe()).rejects.toThrow('computer frame capture failed')
    await computer.dispose()
  })

  it('rechecks authority for the ordinary Computer controller', async () => {
    const socketPath = await listen(request => request.action === 'frame'
      ? { width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT, jpeg: JPEG.toString('base64') }
      : { ok: true })
    const browser = new VpsIsolatedBrowser({ socketPath, bots: [BOT] })
    const computer = browser.computer(BOT, SESSION, async (_signal, start) => {
      start?.()
      return true
    })
    await expect(computer.observe()).resolves.toMatchObject({ jpeg: JPEG.toString('base64') })
    await computer.dispose()
  })
})
