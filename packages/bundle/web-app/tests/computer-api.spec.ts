import { writeFile } from 'node:fs/promises'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import { describe, expect, it, vi } from 'vitest'
import { botComputerRoutes, botComputerRoutesWithLegacy, computerRoutes, computerSignInRoute } from '../src/computer-api.ts'
import { ComputerHost } from '../src/computer.ts'

const viewerId = '11111111-1111-4111-8111-111111111111'

function sender(routes: readonly ConnectionFetchRoute[]) {
  return async (endpoint: string, payload: unknown): Promise<Response> => {
    const route = routes.find(candidate => candidate.path === `/api/computer/${endpoint}`)
    if (route === undefined) throw new Error('Missing Computer endpoint')
    return route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }))
  }
}

function harness() {
  const computer = {
    frame: vi.fn(async () => ({ jpeg: 'fixture', width: 1280, height: 800, mode: 'watching' as const, botActive: false })),
    takeControl: vi.fn(async () => ({ mode: 'controlling' as const })),
    releaseControl: vi.fn(async () => ({ mode: 'watching' as const })),
    input: vi.fn(async () => ({ mode: 'controlling' as const })),
  }
  const routes = computerRoutes(computer)
  return { computer, routes, send: sender(routes) }
}

describe('Computer HTTP routes', () => {
  it('scopes sign-in metadata and answers to the exact Bot and rejects extra values', async () => {
    const computer = new ComputerHost({ display: ':fixture', authorityPath: '/private/fixture' }, { run: async () => {} })
    const send = sender([computerSignInRoute(async sessionId => sessionId === 'bot-session' ? {
      status: () => computer.signInRequest(), answer: (...args) => computer.answerSignIn(...args),
    } : undefined)])
    try {
      const waiting = computer.requestSignIn(new AbortController().signal)
      await expect.poll(() => computer.signInRequest()).toBeDefined()
      const request = computer.signInRequest()!
      const status = { action: 'status', sessionId: 'bot-session' }
      const claim = { action: 'take', sessionId: 'bot-session', requestId: request.id, viewerId }
      const initial = await send('sign-in', status)
      expect(initial.headers.get('cache-control')).toBe('no-store')
      await expect(initial.json()).resolves.toEqual({ request })
      await expect((await send('sign-in', { ...status, sessionId: 'another-session' })).json()).resolves.toEqual({ request: null })
      expect((await send('sign-in', { ...claim, sessionId: 'another-session' })).status).toBe(409)
      expect((await send('sign-in', { ...claim, secret: 'a value the endpoint must reject' })).status).toBe(400)
      expect((await send('sign-in', { ...claim, viewerId: 'invalid' })).status).toBe(400)
      expect((await send('sign-in', { ...claim, action: 'complete' })).status).toBe(409)
      await expect((await send('sign-in', claim)).json()).resolves.toEqual({ mode: 'controlling' })
      expect((await send('sign-in', { ...claim, action: 'complete' })).status).toBe(200)
      await expect(waiting).resolves.toBe('completed')
      expect((await send('sign-in', claim)).status).toBe(409)
    } finally {
      await computer.dispose()
    }
  })

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
    expect(await response.json()).toEqual({
      available: true,
      kind: 'vps',
      computer: { id: 'shared-vps', location: 'vps', permissionScope: 'workspace' },
    })
  })

  it('rejects invalid viewer identifiers and oversized input before dispatch', async () => {
    const { computer, send } = harness()
    expect((await send('frame', { viewerId: 'not-a-viewer' })).status).toBe(400)
    expect((await send('input', { viewerId, action: { kind: 'text', text: 'x'.repeat(17000) } })).status).toBe(400)
    expect(computer.frame).not.toHaveBeenCalled()
    expect(computer.input).not.toHaveBeenCalled()
  })

  it('advertises and admits browser navigation only for a controlling viewer of the selected Bot', async () => {
    const computer = new ComputerHost({ display: ':browser', authorityPath: '/dev/null' })
    const navigate = vi.fn(async (_url: string, _signal: AbortSignal) => {})
    const send = sender(botComputerRoutesWithLegacy(async session => session === 'browser-session' ? {
      computer, id: 'bot-browser', permissionScope: 'bot', navigate,
    } : undefined))
    const target = { sessionId: 'browser-session', viewerId }
    try {
      expect(await (await send('status', { sessionId: target.sessionId })).json()).toMatchObject({ computer: { browser: true } })
      expect((await send('navigate', { ...target, url: 'https://example.test/' })).status).toBe(409)
      await send('take-control', target)
      expect((await send('navigate', { ...target, url: 'file:///etc/hosts' })).status).toBe(400)
      expect((await send('navigate', { ...target, url: 'https://example.test/', extra: true })).status).toBe(400)
      expect((await send('navigate', { ...target, sessionId: 'different', url: 'https://example.test/' })).status).toBe(409)
      expect(navigate).not.toHaveBeenCalled()
      expect(await (await send('navigate', { ...target, url: 'https://example.test/' })).json()).toEqual({ mode: 'controlling' })
      expect(navigate).toHaveBeenCalledExactlyOnceWith('https://example.test/', expect.any(AbortSignal))
    } finally {
      await computer.dispose()
    }
  })

  it('returns a frame and routes input through the current viewer identity', async () => {
    const { computer, send } = harness()
    expect(await (await send('frame', { viewerId })).json()).toMatchObject({ mode: 'watching', width: 1280 })
    const action = { kind: 'click', x: 42, y: 30, button: 1 }
    expect(await (await send('input', { viewerId, sessionId: 'bot-session', action })).json()).toEqual({ mode: 'controlling' })
    expect(computer.input).toHaveBeenCalledWith(viewerId, action, expect.any(AbortSignal))
  })

  it('does not forward runtime paths or diagnostics to the browser', async () => {
    const { computer, send } = harness()
    computer.frame.mockRejectedValueOnce(new Error('fixture internal diagnostic'))
    const response = await send('frame', { viewerId })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'computer-unavailable' })
  })

  it('requires a Bot session and routes status and frames to that Bot Computer', async () => {
    const computer = new ComputerHost({ display: ':private', authorityPath: '/private/xauthority' }, {
      run: async (command, args) => {
        if (command === 'scrot') {
          const output = args.at(-1)
          if (output === undefined) throw new Error('missing frame path')
          await writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        }
      },
    })
    const resolveComputer = vi.fn(async (sessionId: string) => sessionId === 'bot-session' ? computer : undefined)
    const send = sender(botComputerRoutes(resolveComputer))
    try {
      expect((await send('status', {})).status).toBe(400)
      expect(await (await send('status', { sessionId: 'bot-session' })).json()).toEqual({
        available: true,
        kind: 'vps',
        computer: { id: 'bot-session', location: 'vps', permissionScope: 'bot' },
      })
      expect(await (await send('frame', { viewerId, sessionId: 'bot-session' })).json()).toMatchObject({
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'),
        width: 1280,
        mode: 'watching',
      })
      expect(resolveComputer).toHaveBeenCalledWith('bot-session')
    } finally {
      await computer.dispose()
    }
  })

  it('reports the server-selected Bot or legacy scope without trusting the session id as a fallback', async () => {
    const managed = new ComputerHost({ display: ':managed', authorityPath: '/private/managed-xauthority' }, { run: async () => {} })
    const legacy = new ComputerHost({ display: ':legacy', authorityPath: '/private/legacy-xauthority' }, { run: async () => {} })
    const resolveTarget = vi.fn(async (sessionId: string) => {
      if (sessionId === 'managed-session') return { computer: managed, id: 'bot-research', permissionScope: 'bot' as const }
      if (sessionId === 'legacy-session' || sessionId === '') return { computer: legacy, id: 'shared-vps', permissionScope: 'workspace' as const }
      return undefined
    })
    const managedRoutes = botComputerRoutesWithLegacy(resolveTarget)
    const managedStatus = managedRoutes.find(candidate => candidate.path === '/api/computer/status')
    if (managedStatus === undefined) throw new Error('Missing managed Computer status endpoint')
    const missingSession = await managedStatus.fetch(new Request('http://127.0.0.1/api/computer/status', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    expect(missingSession.status).toBe(400)
    const send = sender(botComputerRoutesWithLegacy(resolveTarget, { allowMissingSession: true }))
    try {
      await expect((await send('status', { sessionId: 'managed-session' })).json()).resolves.toEqual({
        available: true,
        kind: 'vps',
        computer: { id: 'bot-research', location: 'vps', permissionScope: 'bot' },
      })
      await expect((await send('status', { sessionId: 'legacy-session' })).json()).resolves.toEqual({
        available: true,
        kind: 'vps',
        computer: { id: 'shared-vps', location: 'vps', permissionScope: 'workspace' },
      })
      await expect((await send('status', {})).json()).resolves.toEqual({
        available: true,
        kind: 'vps',
        computer: { id: 'shared-vps', location: 'vps', permissionScope: 'workspace' },
      })
      await expect((await send('take-control', { viewerId, sessionId: 'managed-session' })).json()).resolves.toEqual({
        mode: 'controlling',
      })
      expect((await send('status', { sessionId: 'unknown-session' })).status).toBe(200)
      expect(resolveTarget).toHaveBeenCalledWith('managed-session')
      expect(resolveTarget).toHaveBeenCalledWith('legacy-session')
      expect(resolveTarget).toHaveBeenCalledWith('')
    } finally {
      await managed.dispose()
      await legacy.dispose()
    }
  })
})
