import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompoundUpdateController, isUpdateStatus, UPDATE_ROUTE, type UpdateStatus } from '../src/client/controller.ts'

afterEach(() => { vi.unstubAllGlobals() })

const RELEASED: UpdateStatus = {
  vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true,
  repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null,
}

/**
 * Stub the Host route with one response.
 * @param response - response the route answers with, or a rejection to throw.
 * @returns the recorded request URLs.
 */
function stubRoute(response: Response | Error): string[] {
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    requested.push(url)
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
  })
  return requested
}

describe('update status validation', () => {
  it('accepts a complete status and refuses incomplete values', () => {
    expect(isUpdateStatus(RELEASED)).toBe(true)
    for (const value of [
      null, 'text', 42, {},
      { ...RELEASED, vendored: 1 },
      { ...RELEASED, upstream: 2 },
      { ...RELEASED, updateAvailable: 'yes' },
      { ...RELEASED, repository: null },
      { ...RELEASED, checkedAt: 'now' },
      { ...RELEASED, error: 5 },
    ]) expect(isUpdateStatus(value)).toBe(false)
  })
})

describe('compound update controller', () => {
  it('publishes the reading the Host route answers with', async () => {
    const requested = stubRoute(Response.json(RELEASED))
    const controller = new CompoundUpdateController()
    await controller.refresh()
    expect(requested).toEqual([UPDATE_ROUTE])
    expect(controller.face().hooks.update.getSnapshot()).toMatchObject({ phase: 'ready', status: { upstream: '0.12.0' } })
  })

  it('reports a failed request without discarding the last reading', async () => {
    stubRoute(Response.json(RELEASED))
    const controller = new CompoundUpdateController()
    await controller.refresh()
    stubRoute(new Response('gone', { status: 503 }))
    await controller.refresh()
    const state = controller.face().hooks.update.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.status).toMatchObject({ vendored: '0.11.0', upstream: null, updateAvailable: false, error: 'HTTP 503' })
  })

  it('reports a body the Host did not send as a status', async () => {
    stubRoute(Response.json({ unexpected: true }))
    const controller = new CompoundUpdateController()
    await controller.refresh()
    expect(controller.face().hooks.update.getSnapshot().status?.error).toBe('the Host answered with an unrecognized status')
  })

  it('reports a transport failure', async () => {
    stubRoute(new TypeError('Failed to fetch'))
    const controller = new CompoundUpdateController()
    await controller.refresh()
    const status = controller.face().hooks.update.getSnapshot().status
    expect(status).toMatchObject({ vendored: '', upstream: null, updateAvailable: false, error: 'Failed to fetch' })
  })

  it('reports a thrown value that is not an Error', async () => {
    const reason: unknown = 'socket closed'
    vi.stubGlobal('fetch', () => { throw reason })
    const controller = new CompoundUpdateController()
    await controller.refresh()
    expect(controller.face().hooks.update.getSnapshot().status?.error).toBe('socket closed')
  })

  it('opens the panel with a fresh reading and closes without one', async () => {
    const requested = stubRoute(Response.json(RELEASED))
    const controller = new CompoundUpdateController()
    const face = controller.face()
    face.show()
    expect(face.hooks.update.getSnapshot().open).toBe(true)
    await vi.waitFor(() => { expect(requested).toHaveLength(1) })
    face.refresh()
    await vi.waitFor(() => { expect(requested).toHaveLength(2) })
    face.hide()
    expect(face.hooks.update.getSnapshot().open).toBe(false)
  })

  it('ignores a superseded reading', async () => {
    let releaseFirst: (response: Response) => void = () => {}
    let calls = 0
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => {
      calls += 1
      if (calls > 1) return Promise.resolve(Response.json(RELEASED))
      return new Promise<Response>((resolve, reject) => {
        releaseFirst = resolve
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      })
    })
    const controller = new CompoundUpdateController()
    const first = controller.refresh()
    const second = controller.refresh()
    await second
    releaseFirst(Response.json({ ...RELEASED, upstream: '9.9.9' }))
    await first
    expect(controller.face().hooks.update.getSnapshot().status?.upstream).toBe('0.12.0')
  })

  it('stops publishing once the controller is disposed', async () => {
    const controller = new CompoundUpdateController()
    let release: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', (_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
      release = resolve
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const pending = controller.refresh()
    controller.dispose()
    release(Response.json(RELEASED))
    await pending
    expect(controller.face().hooks.update.getSnapshot()).toMatchObject({ phase: 'loading', status: null })
  })
})
