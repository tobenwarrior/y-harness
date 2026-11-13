import { createServer, type Server } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPUTER_HEIGHT, COMPUTER_WIDTH, type ComputerAction } from '../src/computer.ts'
import { validateIsolatedBrowserUrl, VpsIsolatedBrowser } from '../src/vps-isolated-browser.ts'

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
    server.close(() => resolve())
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
    await expect(browser.status(BOT, '' as never, new AbortController().signal))
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
        error => error,
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(pending).resolves.toMatchObject({ message: 'The isolated browser request timed out.' })
    } finally {
      vi.useRealTimers()
    }
  })
})
