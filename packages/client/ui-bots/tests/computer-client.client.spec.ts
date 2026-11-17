import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComputerClient, createMacComputerClient, type ComputerClient } from '../src/client/computer-client.ts'
import { createComputerAvailability } from '../src/client/computer-availability.ts'

afterEach(() => { vi.unstubAllGlobals() })

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function parsedBody(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('body' in value) || typeof value.body !== 'string') return undefined
  return JSON.parse(value.body)
}

describe('Computer HTTP client', () => {
  it('starts checking, maps Mac/VPS/unavailable results, and keeps identity metadata', async () => {
    const status = vi.fn<ComputerClient['status']>()
      .mockResolvedValueOnce({ available: true, kind: 'mac', computer: { location: 'mac', permissionScope: 'workspace' } })
      .mockResolvedValueOnce({ available: true, kind: 'vps', computer: { location: 'vps', permissionScope: 'bot', id: 'bot-id' } })
      .mockResolvedValueOnce({ available: false })
    const base = createComputerClient()
    const availability = createComputerAvailability({ ...base, status })

    expect(availability.source.getSnapshot()).toBe('checking')
    expect(availability.identity.getSnapshot()).toBeUndefined()
    availability.refresh('mac-session')
    await Promise.resolve()
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('mac')
    expect(availability.identity.getSnapshot()).toEqual({ location: 'mac', permissionScope: 'workspace' })
    expect(status).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'mac-session')

    availability.refresh('vps-session')
    await Promise.resolve()
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('available')
    expect(availability.identity.getSnapshot()).toEqual({ location: 'vps', permissionScope: 'bot', id: 'bot-id' })

    availability.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('unavailable')
    expect(availability.identity.getSnapshot()).toBeUndefined()
    availability.dispose()
  })

  it('ignores aborted and stale failures, reports current failures, and stops after disposal', async () => {
    let rejectStale: ((reason: unknown) => void) | undefined
    let resolveStaleSuccess: ((value: { readonly available: boolean; readonly kind?: 'mac' | 'vps' }) => void) | undefined
    let rejectDisposed: ((reason: unknown) => void) | undefined
    const status = vi.fn<ComputerClient['status']>((_signal, sessionId) => {
      if (sessionId === 'abort') return Promise.reject(new DOMException('aborted', 'AbortError'))
      if (sessionId === 'stale') return new Promise((_resolve, reject) => { rejectStale = reject })
      if (sessionId === 'stale-success') return new Promise((resolve) => { resolveStaleSuccess = resolve })
      if (sessionId === 'disposed') return new Promise((_resolve, reject) => { rejectDisposed = reject })
      return Promise.reject(new Error('synthetic status failure'))
    })
    const base = createComputerClient()
    const availability = createComputerAvailability({ ...base, status })

    availability.refresh('abort')
    await Promise.resolve()
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('checking')

    availability.refresh('current-error')
    await Promise.resolve()
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('unavailable')

    availability.refresh('stale')
    availability.refresh('current-error-2')
    await Promise.resolve()
    await Promise.resolve()
    rejectStale?.(new Error('synthetic stale failure'))
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('unavailable')

    availability.refresh('stale-success')
    availability.refresh('current-error-3')
    await Promise.resolve()
    await Promise.resolve()
    resolveStaleSuccess?.({ available: true, kind: 'mac' })
    await Promise.resolve()
    expect(availability.source.getSnapshot()).toBe('unavailable')

    availability.refresh('disposed')
    availability.dispose()
    availability.dispose()
    rejectDisposed?.(new Error('synthetic disposed failure'))
    availability.refresh('ignored')
    await Promise.resolve()
    await Promise.resolve()
    expect(status).not.toHaveBeenLastCalledWith(expect.any(AbortSignal), 'ignored')
  })

  it('posts status to a relative API route and parses availability', async () => {
    const fetchMock = vi.fn(async () => response({ available: true }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status()).resolves.toEqual({ available: true })
    expect(fetchMock).toHaveBeenCalledWith('api/computer/status', expect.objectContaining({
      method: 'POST',
      body: '{}',
    }))
  })

  it('includes the selected Bot session and keeps its Computer scope metadata', async () => {
    const fetchMock = vi.fn(async () => response({
      available: true,
      kind: 'vps',
      computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot', files: true, sharedFiles: true },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status(undefined, 'bot-session-owner')).resolves.toEqual({
      available: true,
      kind: 'vps',
      computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot', files: true, sharedFiles: true },
    })
    expect(fetchMock).toHaveBeenCalledWith('api/computer/status', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session-owner' }),
    }))
  })

  it('does not expose shared files without the private Files capability', async () => {
    const fetchMock = vi.fn(async () => response({
      available: true,
      kind: 'vps',
      computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot', sharedFiles: true },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status(undefined, 'bot-session-owner')).resolves.toEqual({
      available: true,
      kind: 'vps',
      computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot' },
    })
  })

  it('reads internet policy only for an advertised private VPS terminal', async () => {
    const fetchMock = vi.fn()
    const base = { available: true, kind: 'vps' }
    const bot = { id: 'bot-internet', location: 'vps', permissionScope: 'bot', terminal: true }
    fetchMock
      .mockResolvedValueOnce(response({ ...base, computer: { ...bot, terminalInternet: false, networkControl: true } }))
      .mockResolvedValueOnce(response({ ...base, computer: { ...bot, terminalInternet: true } }))
      .mockResolvedValueOnce(response({ ...base, computer: { ...bot, terminal: undefined, terminalInternet: true } }))
      .mockResolvedValueOnce(response({ ...base, computer: { ...bot, permissionScope: 'workspace', terminalInternet: true } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status()).resolves.toMatchObject({ computer: { terminal: true, terminalInternet: false, networkControl: true } })
    await expect(client.status()).resolves.toMatchObject({ computer: { terminal: true, terminalInternet: true } })
    await expect(client.status()).resolves.toEqual({ ...base, computer: { id: bot.id, location: 'vps', permissionScope: 'bot' } })
    await expect(client.status()).resolves.toEqual({ ...base, computer: { id: bot.id, location: 'vps', permissionScope: 'workspace' } })
  })

  it('reads the private Bot restart capability and posts the selected Session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ available: true, kind: 'vps',
        computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot', restart: true } }))
      .mockResolvedValueOnce(response({ status: 'restarted' }))
      .mockResolvedValueOnce(response({ status: 'busy' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status(undefined, 'bot-session-owner')).resolves.toMatchObject({
      computer: { id: 'bot-id-owner', restart: true },
    })
    const restart = client.restart
    expect(restart).toBeTypeOf('function')
    if (restart === undefined) return
    await expect(restart('bot-session-owner')).resolves.toEqual({ status: 'restarted' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/restart', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'bot-session-owner' }),
    }))
    await expect(restart('bot-session-owner')).rejects.toMatchObject({ status: 409 })
  })

  it('reads shared workspace capability and posts the selected Session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ available: true, kind: 'vps',
        computer: { id: 'bot-id-owner', location: 'vps', permissionScope: 'bot', sharedWorkspaceControl: true } }))
      .mockResolvedValueOnce(response({ status: 'applied', enabled: true }))
      .mockResolvedValueOnce(response({ status: 'busy' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status(undefined, 'bot-session-owner')).resolves.toMatchObject({
      computer: { id: 'bot-id-owner', sharedWorkspaceControl: true },
    })
    const sharedWorkspace = client.sharedWorkspace
    expect(sharedWorkspace).toBeTypeOf('function')
    if (sharedWorkspace === undefined) return
    await expect(sharedWorkspace('bot-session-owner', true)).resolves.toEqual({ status: 'applied', enabled: true })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/shared-workspace', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'bot-session-owner', enabled: true }),
    }))
    await expect(sharedWorkspace('bot-session-owner', false)).rejects.toMatchObject({ status: 409 })
  })

  it('posts the exact private-session Internet toggle and preserves the busy response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ status: 'applied', enabled: true }))
      .mockResolvedValueOnce(response({ status: 'busy' }, 409))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()
    const network = (client as ComputerClient & {
      readonly network?: (sessionId: string, enabled: boolean, signal?: AbortSignal) => Promise<{
        readonly status: 'applied'
        readonly enabled: boolean
      }>
    }).network
    expect(network).toBeTypeOf('function')
    if (network === undefined) return

    await expect(network('bot-session', true)).resolves.toEqual({ status: 'applied', enabled: true })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/network', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sessionId: 'bot-session', enabled: true }),
    }))
    await expect(network('bot-session', false)).rejects.toMatchObject({ status: 409 })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/network', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session', enabled: false }),
    }))
  })

  it('sends the viewer lease and input action to their exact routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.takeControl('viewer-id')).resolves.toEqual({ mode: 'controlling' })
    await expect(client.input('viewer-id', { kind: 'key', key: 'Ctrl+a' })).resolves.toEqual({ mode: 'controlling' })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('api/computer/take-control')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('api/computer/input')
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', action: { kind: 'key', key: 'Ctrl+a' } }),
    }))
  })

  it('decodes only the exact shared sign-in target and canonical origin', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const targetSessionId = 'handoff-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const origin = 'https://example.test'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ request: { id, canCancel: true, targetSessionId, origin } }))
      .mockResolvedValueOnce(response({ request: { id, canCancel: true, targetSessionId: 'handoff-invalid', origin } }))
      .mockResolvedValueOnce(response({ request: { id, canCancel: true, targetSessionId, origin: 'https://example.test/' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()
    if (client.signIn === undefined) throw new Error('Computer sign-in client is unavailable')

    await expect(client.signIn.status('owner-session', new AbortController().signal)).resolves.toEqual({
      request: { id, canCancel: true, targetSessionId, origin },
    })
    await expect(client.signIn.status('owner-session', new AbortController().signal)).rejects.toMatchObject({ status: 200 })
    await expect(client.signIn.status('owner-session', new AbortController().signal)).rejects.toMatchObject({ status: 200 })
  })

  it('decodes current browser origins and sends shared target origin with input', async () => {
    const targetSessionId = 'handoff-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const origin = 'https://example.test'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ jpeg: 'frame', width: 1280, height: 800, mode: 'controlling', botActive: false, browserOrigin: origin }))
      .mockResolvedValueOnce(response({ jpeg: '', width: 1280, height: 800, mode: 'controlling', botActive: false, browserOrigin: null }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()
    if (client.signIn === undefined) throw new Error('Computer sign-in client is unavailable')

    await expect(client.frame('viewer-id', undefined, targetSessionId)).resolves.toMatchObject({ browserOrigin: origin })
    await expect(client.frame('viewer-id', undefined, targetSessionId)).resolves.toMatchObject({ browserOrigin: null })
    await client.signIn.take(targetSessionId, requestId, 'viewer-id')
    await client.input('viewer-id', { kind: 'key', key: 'a' }, undefined, targetSessionId, origin)
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'api/computer/sign-in', expect.objectContaining({
      body: JSON.stringify({ action: 'take', sessionId: targetSessionId, requestId, viewerId: 'viewer-id' }),
    }))
    expect(fetchMock.mock.calls[3]?.[0]).toBe('api/computer/input')
    expect(parsedBody(fetchMock.mock.calls[3]?.[1])).toEqual({
      viewerId: 'viewer-id', action: { kind: 'key', key: 'a' }, sessionId: targetSessionId, origin,
    })
  })

  it('reads the isolated browser capability and sends a website to that viewer lease', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ available: true, computer: { location: 'vps', permissionScope: 'bot', browser: true } }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()
    await expect(client.status(undefined, 'bot-session')).resolves.toMatchObject({ computer: { browser: true } })
    await expect(client.navigate?.('viewer-id', 'https://example.test/', 'bot-session')).resolves.toEqual({ mode: 'controlling' })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/navigate', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', url: 'https://example.test/', sessionId: 'bot-session' }),
    }))
  })

  it('binds native setup and control to the Bot and its mounted panel', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ screenRecording: true, accessibility: false, deviceControlLabel: true, shared: false }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ screenRecording: true, accessibility: true, shared: false }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createMacComputerClient('bot-session', 'mac-panel')
    await expect(client.setup('settings', 'accessibility')).resolves.toMatchObject({ deviceControlLabel: true, shared: false })
    await client.computer.takeControl('unused')
    await client.setup('stop')
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/mac/settings', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session', viewerId: 'mac-panel', permission: 'accessibility' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/mac/take-control', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session', viewerId: 'mac-panel' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'api/computer/mac/stop', expect.objectContaining({ keepalive: true }))
  })

  it('preserves HTTP conflict status for lease feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'busy' }, 409)))
    const client = createComputerClient()

    await expect(client.takeControl('viewer-id')).rejects.toMatchObject({ status: 409 })
  })
})
