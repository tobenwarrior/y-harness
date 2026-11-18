import { describe, expect, it, vi } from 'vitest'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import { SessionId } from '@yharness/session/types'
import {
  botComputerRoutes,
  botComputerRoutesWithLegacy,
  computerRoutes,
  computerFileDownloadRoute,
  computerFileHandoffRoutes,
  computerFileUploadRoute,
  computerRestartRoute,
  computerSettingRoute,
  computerSignInRoute,
  type BotComputerRouteTarget,
} from '../src/computer-api.ts'
import { ComputerHost } from '../src/computer.ts'

const VIEWER = '11111111-1111-4111-8111-111111111111'
const SESSION = 'bot-session-fixture'

function route(routes: readonly ConnectionFetchRoute[], path: string): ConnectionFetchRoute {
  const found = routes.find(candidate => candidate.path === path)
  if (found === undefined) throw new Error(`Missing fixture route ${path}`)
  return found
}

function post(path: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  })
}

describe('Computer file HTTP routes', () => {
  it('validates and safely maps private file downloads', async () => {
    const download = vi.fn<(sessionId: string, path: string, signal: AbortSignal) => Promise<Response>>()
      .mockResolvedValue(new Response('fixture bytes', { status: 200 }))
    const endpoint = computerFileDownloadRoute(download)
    expect(endpoint.methods).toEqual(['GET'])
    const invalid = [
      'http://127.0.0.1/api/computer/files/download',
      `http://127.0.0.1/api/computer/files/download?sessionId=${encodeURIComponent(SESSION)}&path=`,
      'http://127.0.0.1/api/computer/files/download?sessionId=\u0000&path=notes.txt',
      `http://127.0.0.1/api/computer/files/download?sessionId=${encodeURIComponent(SESSION)}&path=${'x'.repeat(4097)}`,
      `http://127.0.0.1/api/computer/files/download?sessionId=${encodeURIComponent(SESSION)}&path=${encodeURIComponent('notes\u0000.txt')}`,
    ]
    for (const url of invalid) expect((await endpoint.fetch(new Request(url, { method: 'GET' }))).status).toBe(400)
    expect(download).not.toHaveBeenCalled()

    const response = await endpoint.fetch(new Request(
      `http://127.0.0.1/api/computer/files/download?sessionId=${encodeURIComponent(SESSION)}&path=${encodeURIComponent('notes.txt')}`,
      { method: 'GET' },
    ))
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('fixture bytes')
    expect(download).toHaveBeenCalledExactlyOnceWith(SESSION, 'notes.txt', expect.any(AbortSignal))

    download.mockRejectedValueOnce(new Error('private provider detail'))
    expect((await endpoint.fetch(new Request(
      `http://127.0.0.1/api/computer/files/download?sessionId=${SESSION}&path=missing.txt`, { method: 'GET' },
    ))).status).toBe(404)
    const controller = new AbortController()
    download.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('cancelled')
    })
    await expect(endpoint.fetch(new Request(
      `http://127.0.0.1/api/computer/files/download?sessionId=${SESSION}&path=cancelled.txt`, { method: 'GET', signal: controller.signal },
    ))).rejects.toThrow()
  })

  it('validates upload metadata, shared directories, outcomes, and cancellation', async () => {
    const upload = vi.fn<(sessionId: string, file: { readonly directory: string; readonly name: string; readonly bytes: number; readonly body: ReadableStream<Uint8Array> | null }, signal: AbortSignal) => Promise<'stored' | 'exists' | 'folder-unavailable' | 'no-space' | 'incomplete' | 'unavailable' | undefined>>()
      .mockResolvedValue('stored')
    const endpoint = computerFileUploadRoute(upload, 20)
    const call = (directory: string, name = 'source.bin', bytes = '3', media = 'application/octet-stream', body: BodyInit | null = Uint8Array.of(7, 8, 9), extraHeaders: Record<string, string> = {}) => {
      const query = new URLSearchParams({ sessionId: SESSION, directory, name, bytes })
      return endpoint.fetch(new Request(`http://127.0.0.1${endpoint.path}?${query}`, {
        method: 'POST', body, headers: { 'content-type': media, ...extraHeaders },
      }))
    }
    expect((await call('reports', 'source.bin', '3', 'text/plain')).status).toBe(415)
    expect((await call('reports', 'source.bin', '21')).status).toBe(413)
    const invalid = [
      call('reports', '.', '3'), call('reports', '..', '3'), call('reports', 'part/source.bin', '3'),
      call('reports', 'bad\u0000name', '3'), call('reports', 'x'.repeat(256), '3'), call('/reports', 'source.bin', '3'),
      call('reports/..', 'source.bin', '3'), call('reports/', 'source.bin', '3'), call('reports', 'source.bin', '-1'),
      call('reports', 'source.bin', '03'), call('reports', 'source.bin', 'x'), call('reports', 'source.bin', '3', 'application/octet-stream', Uint8Array.of(1), { 'content-length': '4' }),
    ]
    for (const response of await Promise.all(invalid)) expect(response.status).toBe(400)
    expect((await call('.', 'source.bin')).status).toBe(201)
    expect((await call('/workspace', 'source.bin')).status).toBe(201)
    expect((await call('/workspace/project', 'source.bin')).status).toBe(201)
    expect((await call('reports/sub', 'source.bin')).status).toBe(201)
    expect(upload).toHaveBeenCalledWith(SESSION, expect.objectContaining({ directory: 'reports/sub', name: 'source.bin', bytes: 3 }), expect.any(AbortSignal))

    for (const outcome of ['exists', 'folder-unavailable', 'no-space', 'incomplete', 'unavailable'] as const) {
      upload.mockResolvedValueOnce(outcome)
      const response = await call('reports')
      expect(response.status).toBe({ exists: 409, 'folder-unavailable': 404, 'no-space': 507, incomplete: 400, unavailable: 503 }[outcome])
      await expect(response.json()).resolves.toEqual({ error: outcome })
    }
    upload.mockResolvedValueOnce(undefined)
    expect((await call('reports')).status).toBe(404)
    upload.mockRejectedValueOnce(new Error('workspace provider detail'))
    expect((await call('reports')).status).toBe(503)
    const controller = new AbortController()
    upload.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('cancelled')
    })
    await expect(call('reports', 'source.bin', '3', 'application/octet-stream', Uint8Array.of(1), {})).resolves.toMatchObject({ status: 503 })
  })

  it('maps recipient and private copy routes without exposing operation errors', async () => {
    const recipients = vi.fn<(sessionId: SessionId, signal: AbortSignal) => Promise<readonly { id: string; name: string }[] | undefined>>()
      .mockResolvedValue([{ id: 'target', name: 'Target' }])
    const copy = vi.fn<(request: { readonly sessionId: SessionId; readonly targetBotId: string; readonly path: string; readonly version?: string }, signal: AbortSignal) => Promise<{ readonly status: 'copied' | 'source-unavailable' | 'source-changed' | 'target-unavailable' | 'exists' | 'too-large' | 'no-space' | 'unavailable' }>>()
      .mockResolvedValue({ status: 'copied' })
    const endpoints = computerFileHandoffRoutes({ recipients, copy })
    const recipientsRoute = route(endpoints, '/api/computer/files/recipients')
    const copyRoute = route(endpoints, '/api/computer/files/copy')
    expect((await recipientsRoute.fetch(new Request('http://127.0.0.1/api/computer/files/recipients', { method: 'GET' }))).status).toBe(400)
    expect((await recipientsRoute.fetch(new Request('http://127.0.0.1/api/computer/files/recipients?sessionId=', { method: 'GET' }))).status).toBe(400)
    await expect((await recipientsRoute.fetch(new Request(`http://127.0.0.1/api/computer/files/recipients?sessionId=${SESSION}`, { method: 'GET' }))).json())
      .resolves.toEqual({ recipients: [{ id: 'target', name: 'Target' }] })
    recipients.mockResolvedValueOnce(undefined)
    expect((await recipientsRoute.fetch(new Request(`http://127.0.0.1/api/computer/files/recipients?sessionId=${SESSION}`, { method: 'GET' }))).status).toBe(404)
    recipients.mockRejectedValueOnce(new Error('private handoff detail'))
    expect((await recipientsRoute.fetch(new Request(`http://127.0.0.1/api/computer/files/recipients?sessionId=${SESSION}`, { method: 'GET' }))).status).toBe(503)
    const recipientsAbort = new AbortController()
    recipients.mockImplementationOnce(async () => {
      recipientsAbort.abort()
      throw new Error('cancelled')
    })
    await expect(recipientsRoute.fetch(new Request(`http://127.0.0.1/api/computer/files/recipients?sessionId=${SESSION}`, { method: 'GET', signal: recipientsAbort.signal }))).rejects.toThrow()

    const invalidCopies: Array<BodyInit | null> = [null, '{', JSON.stringify({}), JSON.stringify({ sessionId: '\u0000', targetBotId: 'target', path: 'x' }),
      JSON.stringify({ sessionId: SESSION, targetBotId: '\u0000', path: 'x' }), JSON.stringify({ sessionId: SESSION, targetBotId: 'target', path: '' }),
      JSON.stringify({ sessionId: SESSION, targetBotId: 'target', path: 'x', version: '' }), JSON.stringify({ sessionId: SESSION, targetBotId: 'target', path: 'x', version: 'bad\u0000' }),
    ]
    for (const body of invalidCopies) {
      const response = await copyRoute.fetch(new Request('http://127.0.0.1/api/computer/files/copy', { method: 'POST', body }))
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    for (const status of ['copied', 'source-unavailable', 'source-changed', 'target-unavailable', 'exists', 'too-large', 'no-space', 'unavailable'] as const) {
      copy.mockResolvedValueOnce({ status })
      const response = await copyRoute.fetch(post('/api/computer/files/copy', { sessionId: SESSION, targetBotId: 'target', path: 'x', version: 'v1' }))
      expect(response.status).toBe({ copied: 201, 'source-unavailable': 404, 'source-changed': 409, 'target-unavailable': 404, exists: 409, 'too-large': 413, 'no-space': 507, unavailable: 503 }[status])
      expect(copy).toHaveBeenLastCalledWith({ sessionId: SessionId(SESSION), targetBotId: 'target', path: 'x', version: 'v1' }, expect.any(AbortSignal))
    }
    copy.mockRejectedValueOnce(new Error('private copy detail'))
    expect((await copyRoute.fetch(post('/api/computer/files/copy', { sessionId: SESSION, targetBotId: 'target', path: 'x' }))).status).toBe(503)
  })
})

describe('Computer owner route lifecycle', () => {
  it('covers lazy targets, desktop metadata, origin forwarding, and unavailable providers', async () => {
    const primary = new ComputerHost({ display: ':api-primary', authorityPath: '/dev/null' }, { run: async () => {} })
    const desktop = new ComputerHost({ display: ':api-desktop', authorityPath: '/dev/null' }, { run: async () => {} })
    const restart = vi.fn(async () => true)
    const navigate = vi.fn(async () => ({ mode: 'controlling' as const }))
    const resolve = vi.fn(async (id: string): Promise<BotComputerRouteTarget | undefined> => id === SESSION ? {
      computer: async () => primary,
      desktop: async () => desktop,
      id: 'bot-owner', permissionScope: 'bot', terminal: true, terminalInternet: true, networkControl: true,
      restart, files: true, sharedFiles: true, sharedWorkspaceControl: true, navigate,
    } : undefined)
    const routes = botComputerRoutesWithLegacy(resolve)
    const send = (endpoint: string, body: unknown) => route(routes, `/api/computer/${endpoint}`).fetch(post(`/api/computer/${endpoint}`, body))
    expect((await route(routes, '/api/computer/status').fetch(new Request('http://127.0.0.1/api/computer/status', { method: 'POST' }))).status).toBe(400)
    expect((await route(routes, '/api/computer/status').fetch(new Request('http://127.0.0.1/api/computer/status', { method: 'POST', body: '{' }))).status).toBe(400)
    await expect((await send('status', { sessionId: SESSION })).json()).resolves.toEqual({
      available: true, kind: 'vps', computer: {
        id: 'bot-owner', location: 'vps', permissionScope: 'bot', browser: true, desktop: true, terminal: true,
        terminalInternet: true, networkControl: true, restart: true, files: true, sharedFiles: true, sharedWorkspaceControl: true,
      },
    })
    await expect((await send('status', { sessionId: SESSION, surface: 'desktop' })).json()).resolves.toMatchObject({ computer: { desktop: true } })
    await send('take-control', { sessionId: SESSION, viewerId: VIEWER })
    await expect((await send('input', { sessionId: SESSION, viewerId: VIEWER, origin: 'https://example.test', action: { kind: 'move', x: 1, y: 2 } })).json())
      .resolves.toEqual({ mode: 'controlling' })
    expect((await send('frame', { sessionId: 'missing', viewerId: VIEWER })).status).toBe(409)
    const navigation = route(routes, '/api/computer/navigate')
    expect((await navigation.fetch(post('/api/computer/navigate', { sessionId: SESSION, viewerId: VIEWER, url: 'https://example.test' }))).status).toBe(200)
    expect((await navigation.fetch(post('/api/computer/navigate', { sessionId: SESSION, viewerId: 'invalid', url: 'https://example.test' }))).status).toBe(400)
    await primary.dispose()
    await desktop.dispose()
    restart.mockClear()

    const noDesktop = botComputerRoutesWithLegacy(async () => ({ computer: primary, id: 'no-desktop', permissionScope: 'bot' as const }))
    expect((await route(noDesktop, '/api/computer/status').fetch(post('/api/computer/status', { sessionId: SESSION, surface: 'desktop' }))).status).toBe(200)
    const unavailable = botComputerRoutesWithLegacy(async () => { throw new Error('private resolver detail') })
    await expect((await route(unavailable, '/api/computer/status').fetch(post('/api/computer/status', { sessionId: SESSION }))).json())
      .resolves.toMatchObject({ available: false })

    const legacy = computerRoutes({
      frame: async () => ({ mode: 'watching' }), takeControl: async () => ({ mode: 'controlling' }),
      releaseControl: async () => ({ mode: 'watching' }), input: async () => ({ mode: 'controlling' }),
      status: () => ({ available: false }),
    })
    await expect((await route(legacy, '/api/computer/status').fetch(post('/api/computer/status', {}))).json())
      .resolves.toMatchObject({ available: false, computer: { permissionScope: 'workspace' } })
    const missingComputer = botComputerRoutes(async () => undefined)
    await expect((await route(missingComputer, '/api/computer/status').fetch(post('/api/computer/status', { sessionId: SESSION }))).json())
      .resolves.toMatchObject({ available: false, computer: { id: SESSION, permissionScope: 'bot' } })
  })

  it('maps setting and restart outcomes, including malformed and aborted requests', async () => {
    const apply = vi.fn(async (_session: SessionId, enabled: boolean) => enabled ? 'applied' as const : 'busy' as const)
    const setting = computerSettingRoute('network', apply)
    expect((await setting.fetch(post(setting.path, {}))).status).toBe(400)
    expect((await setting.fetch(new Request(`http://127.0.0.1${setting.path}`, { method: 'POST', body: '{' }))).status).toBe(400)
    expect((await setting.fetch(post(setting.path, { sessionId: SESSION }))).status).toBe(400)
    expect((await setting.fetch(post(setting.path, { sessionId: '\u0000', enabled: true }))).status).toBe(400)
    expect((await setting.fetch(post(setting.path, { sessionId: SESSION, enabled: true }))).status).toBe(200)
    expect((await setting.fetch(post(setting.path, { sessionId: SESSION, enabled: false }))).status).toBe(409)
    apply.mockResolvedValueOnce(undefined)
    expect((await setting.fetch(post(setting.path, { sessionId: SESSION, enabled: true }))).status).toBe(404)
    apply.mockRejectedValueOnce(new Error('private setting detail'))
    expect((await setting.fetch(post(setting.path, { sessionId: SESSION, enabled: true }))).status).toBe(503)

    const restart = vi.fn(async (_session: SessionId, surface: 'primary' | 'desktop') => surface === 'desktop' ? 'busy' as const : 'restarted' as const)
    const restartRoute = computerRestartRoute(restart)
    expect((await restartRoute.fetch(post(restartRoute.path, {}))).status).toBe(400)
    expect((await restartRoute.fetch(post(restartRoute.path, 'not-an-object'))).status).toBe(400)
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION, surface: 'desktop', extra: true }))).status).toBe(400)
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION }))).status).toBe(200)
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION, surface: 'desktop' }))).status).toBe(409)
    restart.mockResolvedValueOnce(undefined)
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION }))).status).toBe(404)
    restart.mockRejectedValueOnce(new Error('private restart detail'))
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION }))).status).toBe(503)
    const malformed = new Request(`http://127.0.0.1${restartRoute.path}`, { method: 'POST', body: '{' })
    expect((await restartRoute.fetch(malformed)).status).toBe(400)
    const controller = new AbortController()
    controller.abort()
    expect((await restartRoute.fetch(post(restartRoute.path, { sessionId: SESSION }, controller.signal))).status).toBe(503)

    const noSession = post(setting.path, { enabled: true })
    expect((await setting.fetch(noSession)).status).toBe(400)
  })

  it('rejects malformed and provider-failing sign-in requests', async () => {
    const answer = vi.fn(async () => ({ mode: 'controlling' as const }))
    const resolve = vi.fn(async (sessionId: string) => sessionId === SESSION ? {
      status: () => ({ id: 'request-id', canCancel: true }), answer,
    } : undefined)
    const endpoint = computerSignInRoute(resolve)
    expect((await endpoint.fetch(new Request(`http://127.0.0.1${endpoint.path}`, { method: 'POST', body: '{' }))).status).toBe(400)
    expect((await endpoint.fetch(post(endpoint.path, {}))).status).toBe(400)
    expect((await endpoint.fetch(post(endpoint.path, { action: 'status' }))).status).toBe(400)
    await expect((await endpoint.fetch(post(endpoint.path, { action: 'status', sessionId: SESSION }))).json()).resolves.toEqual({
      request: { id: 'request-id', canCancel: true },
    })
    resolve.mockRejectedValueOnce(new Error('private status detail'))
    expect((await endpoint.fetch(post(endpoint.path, { action: 'status', sessionId: SESSION }))).status).toBe(409)
    expect((await endpoint.fetch(post(endpoint.path, { action: 'take', sessionId: SESSION, requestId: 'bad', viewerId: VIEWER }))).status).toBe(400)
    expect((await endpoint.fetch(post(endpoint.path, { action: 'cancel', sessionId: SESSION, requestId: VIEWER }))).status).toBe(200)
    answer.mockRejectedValueOnce(new Error('private answer detail'))
    expect((await endpoint.fetch(post(endpoint.path, { action: 'cancel', sessionId: SESSION, requestId: VIEWER }))).status).toBe(409)
    const noSession = await endpoint.fetch(post(endpoint.path, { action: 'cancel', requestId: VIEWER }))
    expect(noSession.status).toBe(400)
  })
})
