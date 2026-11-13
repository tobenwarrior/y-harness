import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComputerClient, createMacComputerClient } from '../src/client/computer-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Computer HTTP client', () => {
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
      computer: { id: 'bot-session', location: 'vps', permissionScope: 'bot' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status(undefined, 'bot-session')).resolves.toEqual({
      available: true,
      kind: 'vps',
      computer: { id: 'bot-session', location: 'vps', permissionScope: 'bot' },
    })
    expect(fetchMock).toHaveBeenCalledWith('api/computer/status', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session' }),
    }))
  })

  it('drops malformed Computer metadata while retaining safe fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        available: true,
        kind: 'linux',
        computer: { id: 'bad\u0000id', location: 'vps', permissionScope: 'bot' },
      }))
      .mockResolvedValueOnce(response({
        available: true,
        computer: { location: 'linux', permissionScope: 'workspace' },
      }))
      .mockResolvedValueOnce(response({
        available: true,
        computer: { location: 'vps', permissionScope: 'workspace' },
      }))
      .mockResolvedValueOnce(response({
        available: true,
        computer: { location: 'vps', permissionScope: 'admin' },
      }))
      .mockResolvedValueOnce(response({
        available: true,
        computer: { id: 'x'.repeat(257), location: 'vps', permissionScope: 'bot' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.status()).resolves.toEqual({
      available: true,
      computer: { location: 'vps', permissionScope: 'bot' },
    })
    await expect(client.status()).resolves.toEqual({ available: true })
    await expect(client.status()).resolves.toEqual({
      available: true,
      computer: { location: 'vps', permissionScope: 'workspace' },
    })
    await expect(client.status()).resolves.toEqual({ available: true })
    await expect(client.status()).resolves.toEqual({
      available: true,
      computer: { location: 'vps', permissionScope: 'bot' },
    })
  })

  it('passes cancellation and keepalive options through to fetch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response({ mode: 'other' }))
    vi.stubGlobal('fetch', fetchMock)
    const signal = new AbortController().signal
    const client = createComputerClient()

    await client.status(signal)
    await client.releaseControl('viewer-id', { keepalive: false })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/status', expect.objectContaining({ signal }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/release-control', expect.objectContaining({ keepalive: false }))
  })

  it.each([
    ['a status without availability', { kind: 'vps' }],
    ['a non-object status', null],
  ])('rejects %s', async (_description, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body)))

    await expect(createComputerClient().status()).rejects.toMatchObject({
      name: 'ComputerApiError', status: 200, message: 'Computer returned an invalid response',
    })
  })

  it.each([
    ['a nonpositive width', { width: 0 }],
    ['missing screenshot data', { jpeg: null }],
    ['an unknown lease mode', { mode: 'unknown' }],
    ['a missing Bot activity flag', { botActive: undefined }],
  ])('rejects a frame with %s', async (_description, override) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      jpeg: 'image', width: 10, height: 8, mode: 'watching', botActive: false, ...override,
    })))

    await expect(createComputerClient().frame('viewer-id')).rejects.toMatchObject({
      name: 'ComputerApiError', status: 200, message: 'Computer returned an invalid response',
    })
  })

  it.each([null, { mode: 'busy' }])('rejects an invalid lease response %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body)))

    await expect(createComputerClient().takeControl('viewer-id')).rejects.toMatchObject({
      name: 'ComputerApiError', status: 200, message: 'Computer returned an invalid response',
    })
  })

  it('rejects a successful response without a JSON body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('service proxy returned HTML')))

    await expect(createComputerClient().status()).rejects.toMatchObject({
      name: 'ComputerApiError', status: 200, message: 'Computer returned an invalid response',
    })
  })

  it('forwards the selected Bot session to frame, take, release and input routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ jpeg: 'image', width: 1, height: 1, mode: 'watching', botActive: true }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ mode: 'watching' }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await client.frame('viewer-id', undefined, 'bot-session')
    await client.takeControl('viewer-id', undefined, 'bot-session')
    await client.releaseControl('viewer-id', { keepalive: true }, 'bot-session')
    await client.input('viewer-id', { kind: 'text', text: 'hello' }, undefined, 'bot-session')

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/frame', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', sessionId: 'bot-session' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/take-control', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', sessionId: 'bot-session' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'api/computer/release-control', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', sessionId: 'bot-session' }),
      keepalive: true,
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'api/computer/input', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', action: { kind: 'text', text: 'hello' }, sessionId: 'bot-session' }),
    }))
  })

  it('keeps legacy route payloads unchanged when the Bot session is omitted or empty', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ jpeg: 'image', width: 1, height: 1, mode: 'watching', botActive: false }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ mode: 'watching' }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ available: false }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await client.frame('viewer-id')
    await client.takeControl('viewer-id')
    await client.releaseControl('viewer-id')
    await client.input('viewer-id', { kind: 'key', key: 'Escape' })
    await client.status(undefined, '')

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/frame', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/take-control', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'api/computer/release-control', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'api/computer/input', expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', action: { kind: 'key', key: 'Escape' } }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(5, 'api/computer/status', expect.objectContaining({ body: '{}' }))
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

  it('forwards native status, frame, and release routes to the mounted Bot', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ available: true, kind: 'mac' }))
      .mockResolvedValueOnce(response({ jpeg: 'image', width: 10, height: 8, mode: 'watching', botActive: false }))
      .mockResolvedValueOnce(response({ mode: 'watching' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createMacComputerClient('bot-session', 'mac-panel')

    await expect(client.computer.status(undefined, 'ignored-session')).resolves.toEqual({ available: true, kind: 'mac' })
    await expect(client.computer.frame('ignored-viewer', undefined, 'ignored-session')).resolves.toEqual({
      jpeg: 'image', width: 10, height: 8, mode: 'watching', botActive: false,
    })
    await expect(client.computer.releaseControl('ignored-viewer', { keepalive: true }, 'ignored-session'))
      .resolves.toEqual({ mode: 'watching' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'api/computer/status', expect.objectContaining({ body: '{}' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'api/computer/mac/frame', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session', viewerId: 'mac-panel' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'api/computer/mac/release-control', expect.objectContaining({
      body: JSON.stringify({ sessionId: 'bot-session', viewerId: 'mac-panel' }), keepalive: true,
    }))
  })

  it('requires native sharing status and directs input to the physical Mac', async () => {
    const fetchMock = vi.fn(async () => response({ screenRecording: true, accessibility: true }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createMacComputerClient('bot-session', 'mac-panel')

    await expect(client.setup('setup')).rejects.toMatchObject({
      name: 'ComputerApiError', status: 200, message: 'Computer returned an invalid response',
    })
    await expect(client.computer.input('mac-panel', { kind: 'key', key: 'Return' }))
      .rejects.toThrow('Use your Mac keyboard and mouse to control the local display.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves HTTP conflict status for lease feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'busy' }, 409)))
    const client = createComputerClient()

    await expect(client.takeControl('viewer-id')).rejects.toMatchObject({ status: 409 })
  })
})
