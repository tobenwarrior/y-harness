import { describe, expect, it, vi } from 'vitest'
import { computerRoutes } from '../src/computer-api.ts'

const viewerId = '11111111-1111-4111-8111-111111111111'

function harness() {
  const computer = {
    frame: vi.fn(async () => ({ jpeg: 'fixture', width: 1280, height: 800, mode: 'watching' as const, botActive: false })),
    takeControl: vi.fn(async () => ({ mode: 'controlling' as const })),
    releaseControl: vi.fn(async () => ({ mode: 'watching' as const })),
    input: vi.fn(async () => ({ mode: 'controlling' as const })),
  }
  const routes = computerRoutes(computer)
  const send = async (endpoint: string, payload: unknown): Promise<Response> => {
    const route = routes.find(candidate => candidate.path === `/api/computer/${endpoint}`)
    if (route === undefined) throw new Error('Missing Computer endpoint')
    return route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }
  return { computer, routes, send }
}

describe('Computer HTTP routes', () => {
  it('reserves only exact operator API routes and marks desktop data private', async () => {
    const { routes, send } = harness()
    expect(routes.map(route => route.path).sort()).toEqual([
      '/api/computer/frame',
      '/api/computer/input',
      '/api/computer/release-control',
      '/api/computer/status',
      '/api/computer/take-control',
    ])
    expect(routes.every(route => route.methods.length === 1 && route.methods[0] === 'POST')).toBe(true)
    const response = await send('status', {})
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ available: true })
  })

  it('rejects invalid viewer identifiers and oversized input before dispatch', async () => {
    const { computer, send } = harness()
    expect((await send('frame', { viewerId: 'not-a-viewer' })).status).toBe(400)
    expect((await send('input', { viewerId, action: { kind: 'text', text: 'x'.repeat(17000) } })).status).toBe(400)
    expect(computer.frame).not.toHaveBeenCalled()
    expect(computer.input).not.toHaveBeenCalled()
  })

  it('returns a frame and routes input through the current viewer identity', async () => {
    const { computer, send } = harness()
    expect(await (await send('frame', { viewerId })).json()).toMatchObject({ mode: 'watching', width: 1280 })
    const action = { kind: 'click', x: 42, y: 30, button: 1 }
    expect(await (await send('input', { viewerId, action })).json()).toEqual({ mode: 'controlling' })
    expect(computer.input).toHaveBeenCalledWith(viewerId, action, expect.any(AbortSignal))
  })

  it('does not forward runtime paths or diagnostics to the browser', async () => {
    const { computer, send } = harness()
    computer.frame.mockRejectedValueOnce(new Error('fixture internal diagnostic'))
    const response = await send('frame', { viewerId })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'computer-unavailable' })
  })
})
