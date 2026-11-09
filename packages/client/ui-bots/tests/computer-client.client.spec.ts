import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComputerClient } from '../src/client/computer-client.ts'

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

  it('sends the viewer lease and input action to their exact routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
      .mockResolvedValueOnce(response({ mode: 'controlling' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createComputerClient()

    await expect(client.takeControl('viewer-id')).resolves.toEqual({ mode: 'controlling' })
    await expect(client.input('viewer-id', { kind: 'key', key: 'Ctrl+a' })).resolves.toEqual({ mode: 'controlling' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'api/computer/take-control', 'api/computer/input',
    ])
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      body: JSON.stringify({ viewerId: 'viewer-id', action: { kind: 'key', key: 'Ctrl+a' } }),
    }))
  })

  it('preserves HTTP conflict status for lease feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'busy' }, 409)))
    const client = createComputerClient()

    await expect(client.takeControl('viewer-id')).rejects.toMatchObject({ status: 409 })
  })
})
