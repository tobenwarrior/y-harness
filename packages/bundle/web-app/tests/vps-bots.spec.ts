import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import { BotId } from '@yharness/bots'
import LlmRuntime, { ToolCallId } from '@yharness/llm'
import { managedBotExecutionFor, SandboxPolicyService } from '@yharness/sandbox-policy'
import SessionStore, { SessionId } from '@yharness/session'
import SessionProjections from '@yharness/session-projection'
import SystemPrompt, { renderPrompt } from '@yharness/system-prompt'
import ToolRuntime, { defineTool } from '@yharness/tools'
import { LocalSubprocessRuntime } from '@yharness/subprocess-local'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { IndexInjection } from '@yharness/host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { VpsBotFileSystem } from '../src/vps-bot-files.ts'
import { mountVpsBots } from '../src/vps-bots.ts'
import { VpsJournal } from '../src/vps-journal.ts'
import { VpsBrowserHandoffs } from '../src/vps-browser-handoffs.ts'
import { VpsBrowserLogin } from '../src/vps-browser-login.ts'
import { VpsIsolatedBrowser } from '../src/vps-isolated-browser.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const BOT_SESSION = SessionId('bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76')
const DESKTOP_SESSION = SessionId('bot-session-5f3ec8e4-4c34-4ec6-a38f-aad6d07cb337')
const LEGACY_SESSION = SessionId('bot-session-37888424-5b3d-4a8c-81f5-751ed2d24f95')
const SHARED_BROWSER_SESSION = SessionId('shared-session-37888424-5b3d-4a8c-81f5-751ed2d24f96')
const GROUP_BROWSER_SESSION = SessionId('shared-session-group-37888424-5b3d-4a8c-81f5-751ed2d24f97')

describe('managed VPS Bot composition', () => {
  it('describes a private Computer without starting it when the owner opens a chat', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const bot = { id: BotId('bot-migrated'), sessionId: BOT_SESSION, state: 'active' }
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { ownerBotForSession: async (id: string) => id === BOT_SESSION ? bot : undefined } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [bot.id], desktopOnlyBots: [bot.id],
      }, []) })
      const status = routes.find(route => route.path === '/api/computer/status')
      if (status === undefined) throw new Error('Computer status was not registered')
      const response = await status.fetch(new Request('http://127.0.0.1/api/computer/status', {
        method: 'POST', body: JSON.stringify({ sessionId: BOT_SESSION }),
      }))
      await expect(response.json()).resolves.toMatchObject({
        available: true, computer: { id: bot.id, location: 'vps', permissionScope: 'bot' },
      })
      expect(ensure).not.toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('assigns unlisted Bots an on-demand private desktop and preserves their working directory and project access', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const managed = BotId('bot-existing-managed')
    const other = { id: BotId('bot-unlisted'), sessionId: LEGACY_SESSION, state: 'active' }
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const desktop = vi.spyOn(VpsRuntime.prototype, 'desktopCommand').mockResolvedValue(screenshot)
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { ownerBotForSession: async (id: string) => id === other.sessionId ? other : undefined } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [managed],
        desktopForUnlistedBots: true, sharedWorkspace: {},
      }, []) })
      const request = async (endpoint: string, sessionId: string) => {
        const path = '/api/computer/' + endpoint
        const route = routes.find(item => item.path === path)
        if (route === undefined) throw new Error('Computer route was not registered')
        return route.fetch(new Request('http://127.0.0.1' + path, {
          method: 'POST', body: JSON.stringify({ sessionId, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        }))
      }
      expect(ctx.botWorkspaces.managed?.(managed)).toBe(true)
      expect(ctx.botWorkspaces.managed?.(other.id)).toBe(false)
      expect(ctx.botWorkspaces.desktopOnly?.(other.id)).toBe(true)
      await expect(ctx.workspaceFileAccess.forSession?.(other.sessionId, new AbortController().signal)).resolves.toBeUndefined()
      await expect(ctx.workspaceFileAccess.forComputer?.(other.sessionId, new AbortController().signal, '/workspace/project.txt'))
        .resolves.toBeUndefined()
      await expect((await request('status', other.sessionId)).json()).resolves.toMatchObject({
        available: true, computer: { id: other.id, permissionScope: 'bot' },
      })
      expect((await request('frame', SHARED_BROWSER_SESSION)).status).toBe(409)
      expect(ensure).not.toHaveBeenCalled()
      await expect((await request('frame', other.sessionId)).json()).resolves.toMatchObject({ jpeg: screenshot.toString('base64') })
      expect(ensure).toHaveBeenCalledExactlyOnceWith(other.sessionId)
      expect(desktop.mock.contexts).toEqual([expect.objectContaining({ internet: false })])
    } finally {
      ensure.mockRestore()
      desktop.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('registers live sharing control for the installed browser worker with no static shared Bots', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        isolatedBrowser: { socketPath: '/run/yharness-browser/control.sock', bots: ['bot-private'] },
      }, []) })
      expect(ctx.get('botSharedBrowser')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists only active exact owner Bots eligible to change shared browser access', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const rows = [
      { id: 'bot-eligible', name: 'Browser Scout', sessionId: BOT_SESSION, state: 'active' },
      { id: 'bot-legacy', name: 'External Browser', sessionId: LEGACY_SESSION, state: 'active' },
      { id: 'bot-stale', name: 'Stale Binding', sessionId: DESKTOP_SESSION, state: 'active' },
      { id: 'bot-unconfigured', name: 'Unconfigured Bot', sessionId: GROUP_BROWSER_SESSION, state: 'active' },
      { id: 'bot-paused', name: 'Pending Bot', sessionId: SHARED_BROWSER_SESSION, state: 'creating' },
    ]
    let enabled = false
    const policy = vi.spyOn(VpsIsolatedBrowser.prototype, 'sharingPolicy').mockImplementation(async bot =>
      bot === 'bot-eligible' ? { managed: true, enabled } : { managed: false, enabled: true })
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', {
        list: async () => ({ bots: rows }),
        ownerBotForSession: async (id: string) => rows.find(row => row.sessionId === id && row.id !== 'bot-stale'),
      } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        isolatedBrowser: { socketPath: '/run/yharness-browser/control.sock',
          bots: rows.filter(row => row.id !== 'bot-unconfigured').map(row => row.id) },
      }, []) })
      const route = routes.find(value => value.path === '/api/bot-browser-access')
      if (route === undefined) throw new Error('Owner browser access route was not mounted')
      expect(route.methods).toEqual(['GET'])
      const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`))
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({
        mode: 'managed', bots: [{ id: 'bot-eligible', name: 'Browser Scout', sessionId: BOT_SESSION, enabled: false }],
      })
      expect(policy.mock.calls.map(call => call.slice(0, 2))).toEqual([['bot-eligible', BOT_SESSION], ['bot-legacy', LEGACY_SESSION]])
      enabled = true
      const current = await route.fetch(new Request(`http://127.0.0.1${route.path}`))
      await expect(current.json()).resolves.toMatchObject({ bots: [{ id: 'bot-eligible', enabled: true }] })
      const bad = await route.fetch(new Request(`http://127.0.0.1${route.path}?bot=unexpected`))
      expect(bad.status).toBe(400)

      policy.mockRejectedValue(new Error('Worker unavailable'))
      const offline = await route.fetch(new Request(`http://127.0.0.1${route.path}`))
      await expect(offline.json()).resolves.toEqual({ mode: 'unavailable', bots: [] })

      policy.mockClear()
      const controller = new AbortController()
      controller.abort()
      const closed = await route.fetch(new Request(`http://127.0.0.1${route.path}`, { signal: controller.signal }))
      await expect(closed.json()).resolves.toEqual({ mode: 'unavailable', bots: [] })
      expect(policy).not.toHaveBeenCalled()
    } finally {
      policy.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { session: SHARED_BROWSER_SESSION, outcome: 'complete' },
    { session: GROUP_BROWSER_SESSION, outcome: 'revoked' },
    { session: SHARED_BROWSER_SESSION, outcome: 'cancel' },
    { session: SHARED_BROWSER_SESSION, outcome: 'worker-unavailable' },
    { session: SHARED_BROWSER_SESSION, outcome: 'shutdown' },
  ])('offers an exact owner sign-in and handles $outcome', async ({ session, outcome }) => {
    const ctx = new Context()
    const botId = BotId('bot-owner')
    const agent = { id: session, session: { id: session } } as never
    const lifetime = new AbortController()
    const begin = vi.spyOn(VpsIsolatedBrowser.prototype, 'beginHandoff').mockResolvedValue('https://example.test')
    const finish = vi.spyOn(VpsIsolatedBrowser.prototype, 'endHandoff').mockResolvedValue(undefined)
    const navigate = vi.spyOn(VpsIsolatedBrowser.prototype, 'navigateHandoff').mockResolvedValue(undefined)
    const routes: ConnectionFetchRoute[] = []
    let active = true
    let pending: Promise<unknown> | undefined
    const authorized = vi.fn(async (_signal: AbortSignal, start?: () => void) => {
      if (active) start?.()
      return active
    })
    try {
      await ctx.plugin(LlmRuntime)
      ctx.provide('attachments', {} as never)
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { ownerBotForSession: async (id: string) => {
        if (id === BOT_SESSION) return { id: botId, sessionId: id, state: 'active' }
        if (id === DESKTOP_SESSION) return { id: 'bot-other', sessionId: id, state: 'active' }
        return undefined
      } } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: [botId, 'bot-other'], sharedBots: [botId] },
      }, []) })
      const tool = ctx.get('botSharedBrowser')?.toolForSession(ctx, agent, botId, authorized, BOT_SESSION)
      if (tool === undefined) throw new Error('No shared browser registered')
      const post = (endpoint: string, body: object) => {
        const route = routes.find(value => value.path === `/api/computer/${endpoint}`)
        if (route === undefined) throw new Error('No Computer route registered')
        return route.fetch(new Request(`http://127.0.0.1${route.path}`, { method: 'POST', body: JSON.stringify(body) }))
      }
      const status = async (id: string) => (await post('sign-in', { action: 'status', sessionId: id })).json()
      pending = tool.execute({ action: 'request_sign_in' }, { agent, signal: lifetime.signal } as never)
      await expect.poll(() => status(BOT_SESSION)).toEqual({
        request: { id: expect.any(String), targetSessionId: expect.stringMatching(/^handoff-/u), canCancel: true, origin: 'https://example.test' },
      })
      const { request }: { request: { id: string; targetSessionId: string } } = await status(BOT_SESSION)
      await expect(status(DESKTOP_SESSION)).resolves.toEqual({ request: null })
      await expect(status(session)).resolves.toEqual({ request: null })
      await expect(tool.execute({ action: 'request_sign_in' }, { agent, signal: lifetime.signal } as never))
        .resolves.toEqual({ message: expect.stringContaining('sign-in wait ended') })
      const binding = { bot: botId, session, lease: expect.stringMatching(/^[a-f0-9]{32}$/u) }
      expect(begin).toHaveBeenCalledExactlyOnceWith(binding, expect.any(AbortSignal))
      expect(authorized.mock.calls.some(([, start]) => start !== undefined)).toBe(true)
      if (outcome === 'complete') {
        const checks = authorized.mock.calls.length
        await expect.poll(() => authorized.mock.calls.length, { timeout: 3_500 }).toBeGreaterThan(checks)
        await expect(status(BOT_SESSION)).resolves.toMatchObject({ request })
      }
      const viewerId = '59354d83-771d-4fb4-a688-bf862afab169'
      const target = { sessionId: request.targetSessionId, requestId: request.id, viewerId }
      expect((await post('sign-in', { ...target, sessionId: BOT_SESSION, action: 'take' })).status).toBe(409)
      expect((await post('take-control', { sessionId: target.sessionId, viewerId })).status).toBe(409)
      const before = await post('frame', { sessionId: target.sessionId, viewerId })
      await expect(before.json()).resolves.toMatchObject({ jpeg: '', mode: 'other' })
      expect((await post('sign-in', { ...target, action: 'take' })).status).toBe(200)
      const unsupported = await post('input', { sessionId: target.sessionId, viewerId, action: { kind: 'text', text: 'example' } })
      expect(unsupported.status).toBe(409)
      const url = 'https://example.test/confirm'
      expect((await post('navigate', { sessionId: target.sessionId, viewerId, url })).status).toBe(200)
      expect(navigate).toHaveBeenCalledExactlyOnceWith(binding, url, expect.any(AbortSignal))
      if (outcome === 'shutdown') {
        await ctx.fiber.dispose()
        await expect(pending).resolves.toEqual({ message: expect.stringContaining('sign-in wait ended') })
        expect(finish).toHaveBeenCalledExactlyOnceWith(binding, 'discard', expect.any(AbortSignal))
        return
      }
      if (outcome === 'revoked') active = false
      if (outcome === 'worker-unavailable') {
        finish.mockRejectedValue(new Error('Worker diagnostics are private.'))
      }
      const reply = await post('sign-in', { ...target, action: outcome === 'cancel' ? 'cancel' : 'complete' })
      expect(reply.status).toBe(outcome === 'complete' || outcome === 'cancel' ? 200 : 409)
      await expect(pending).resolves.toEqual({
        message: expect.stringContaining(outcome === 'complete' ? 'returned the Computer'
          : outcome === 'cancel' ? 'declined the sign-in' : 'sign-in wait ended'),
      })
      expect(finish.mock.calls.map(call => call[1])).toEqual(outcome === 'worker-unavailable' ? ['complete', 'discard']
        : [outcome === 'complete' ? 'complete' : 'discard'])
      expect(finish.mock.calls.every(call => call[0].session === session && call[0].bot === botId)).toBe(true)
      await expect(status(BOT_SESSION)).resolves.toEqual({ request: null })
      expect((await post('frame', { sessionId: target.sessionId, viewerId })).status).toBe(409)
    } finally {
      lifetime.abort()
      await pending?.catch(() => undefined)
      begin.mockRestore()
      finish.mockRestore()
      navigate.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('withdraws the owner view as soon as the shared turn is cancelled', async () => {
    const botId = BotId('bot-owner')
    const browser = new VpsIsolatedBrowser({ socketPath: '/run/yharness-browser.sock', bots: [botId], sharedBots: [botId] })
    vi.spyOn(browser, 'beginHandoff').mockResolvedValue('https://example.test')
    const finish = vi.spyOn(browser, 'endHandoff').mockResolvedValue(undefined)
    const browserHandoffs = new VpsBrowserHandoffs(browser)
    const lifetime = new AbortController()
    const authorize = async (_signal: AbortSignal, start?: () => void): Promise<boolean> => { start?.(); return true }
    const computer = browser.computer(botId, SHARED_BROWSER_SESSION, authorize)
    const pending = browserHandoffs.request(botId, BOT_SESSION, SHARED_BROWSER_SESSION, computer, authorize, lifetime.signal)
    try {
      await expect.poll(() => browserHandoffs.status(botId, BOT_SESSION)).toMatchObject({ origin: 'https://example.test' })
      const request = browserHandoffs.status(botId, BOT_SESSION)
      if (request === undefined) throw new Error('No pending owner view')
      const view = browserHandoffs.target(request.targetSessionId)
      if (view === undefined) throw new Error('No pending owner target')
      lifetime.abort()
      expect(view.status()).toBeUndefined()
      expect(browserHandoffs.target(request.targetSessionId)).toBeUndefined()
      await expect(pending).resolves.toBe('interrupted')
      expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ session: SHARED_BROWSER_SESSION }),
        'discard', expect.any(AbortSignal))
    } finally {
      lifetime.abort()
      await browserHandoffs.dispose()
      await computer.dispose()
    }
  })

  it('rejects desktop-only Bots outside the selected Bot allowlist', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-selected'], desktopOnlyBots: ['bot-other'],
    }, []) }).toThrow('Desktop-only VPS Bots must be selected by botComputers.bots.')
  })

  it('limits browser access to Bots with private Computers', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
      browser: { bots: ['bot-shared-desktop'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
    }, []) }).toThrow('VPS browser access must select private Computer Bots.')
  })

  it('requires isolated browser Bots to have private Computers', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
      isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: ['bot-shared-desktop'] },
    }, []) }).toThrow('VPS isolated browser access must select private Computer Bots.')
  })

  it('requires project participants to have private Computers', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
      sharedWorkspace: { bots: ['bot-shared-desktop'] },
    }, []) }).toThrow('Shared project access must select private Computer Bots.')
  })

  it('limits terminal internet access to Bots with private Computers', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
      network: { bots: ['bot-shared-desktop'] },
    }, []) }).toThrow('VPS internet access must select private Computer Bots.')
  })

  it('only connects the private Computers selected by the explicit internet allowlist', async () => {
    const ctx = new Context()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        browser: { bots: ['bot-browser'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
        network: { bots: ['bot-terminal'] },
      }, []) })
      const workspaces = ctx.get('botWorkspaces')
      if (workspaces === undefined) throw new Error('VPS Bot workspaces were not registered')
      await workspaces.prepare(BOT_SESSION, BotId('bot-browser'))
      await workspaces.prepare(DESKTOP_SESSION, BotId('bot-terminal'))
      await workspaces.prepare(LEGACY_SESSION, BotId('bot-other'))
      expect(ensure.mock.contexts).toEqual([
        expect.objectContaining({ internet: false }),
        expect.objectContaining({ internet: true }),
        expect.objectContaining({ internet: false }),
      ])
    } finally {
      ensure.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('rejects overlapping Podman and isolated browser selections', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-browser'],
      browser: { bots: ['bot-browser'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
      isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: ['bot-browser'] },
    }, []) }).toThrow('VPS browser and isolated browser Bots must not overlap.')
  })

  it('keeps isolated browser Bots on their existing workspace runtime', async () => {
    const ctx = new Context()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: ['bot-isolated'] },
      }, []) })
      const workspaces = ctx.get('botWorkspaces')
      if (workspaces === undefined) throw new Error('VPS Bot workspaces were not registered')
      await workspaces.prepare(BOT_SESSION, BotId('bot-isolated'))
      await workspaces.prepare(DESKTOP_SESSION, BotId('bot-other'))
      expect(ensure.mock.calls).toEqual([[BOT_SESSION], [DESKTOP_SESSION]])
    } finally {
      ensure.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('binds the shared browser to one admitted Agent and rechecks access on each action', async () => {
    const ctx = new Context()
    const navigate = vi.spyOn(VpsIsolatedBrowser.prototype, 'navigate').mockResolvedValue(undefined)
    const login = vi.spyOn(VpsBrowserLogin.prototype, 'request').mockResolvedValue({ state: 'submitted' })
    const botId = BotId('bot-team')
    const agent = { id: SHARED_BROWSER_SESSION, session: { id: SHARED_BROWSER_SESSION } } as never
    const signal = new AbortController().signal
    const authorized = vi.fn(async (_signal: AbortSignal, start?: () => void) => { start?.(); return true })
    const url = 'https://example.test/'
    try {
      await ctx.plugin(LlmRuntime)
      ctx.provide('attachments', {} as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: [botId, 'bot-private'], sharedBots: [botId], savedLogins: true },
      }, []) })
      const browser = ctx.get('botSharedBrowser')
      expect(browser?.toolForSession(ctx, agent, BotId('bot-private'), authorized, BOT_SESSION)).toBeUndefined()
      expect(browser?.toolForSession(ctx, { id: BOT_SESSION } as never, botId, authorized, BOT_SESSION)).toBeUndefined()
      const tool = browser?.toolForSession(ctx, agent, botId, authorized, BOT_SESSION)
      expect(tool?.name).toBe('shared_browser')
      if (tool === undefined) throw new Error('No shared browser registered')
      await expect(tool.execute({ action: 'navigate', url }, { agent, signal } as never)).resolves.toBeDefined()
      expect(navigate).toHaveBeenCalledExactlyOnceWith(botId, SHARED_BROWSER_SESSION, url, expect.any(AbortSignal))
      await expect(tool.execute({ action: 'request_saved_login' }, { agent, signal } as never))
        .resolves.toEqual({ message: expect.stringContaining('sign-in submission') })
      expect(login).toHaveBeenCalledExactlyOnceWith(botId, SHARED_BROWSER_SESSION, expect.any(Function), signal, authorized)
      await expect(tool.execute({ action: 'navigate', url }, { agent: { id: SHARED_BROWSER_SESSION }, signal } as never))
        .rejects.toThrow('unavailable')
      authorized.mockResolvedValue(false)
      await expect(tool.execute({ action: 'navigate', url }, { agent, signal } as never)).rejects.toThrow('unavailable')
      expect(navigate).toHaveBeenCalledOnce()
      expect(JSON.stringify(tool.parameters)).toContain('"request_saved_login"')
      expect(JSON.stringify(tool.parameters)).toContain('"request_sign_in"')

      const inFlight = Promise.withResolvers<undefined>()
      authorized.mockImplementation(async (_signal, start) => { start?.(); return true })
      navigate.mockImplementationOnce(() => inFlight.promise)
      const first = tool.execute({ action: 'navigate', url }, { agent, signal } as never)
      try {
        await expect.poll(() => navigate.mock.calls.length).toBe(2)
        const checksBeforeQueue = authorized.mock.calls.length
        const queued = tool.execute({ action: 'navigate', url }, { agent, signal } as never)
        const denied = expect(queued).rejects.toThrow('unavailable')
        await expect.poll(() => authorized.mock.calls.length).toBeGreaterThan(checksBeforeQueue)
        authorized.mockResolvedValue(false)
        inFlight.resolve(undefined)
        await first
        await denied
        expect(navigate).toHaveBeenCalledTimes(2)
      } finally {
        inFlight.resolve(undefined)
      }
    } finally {
      await ctx.fiber.dispose()
      navigate.mockRestore()
      login.mockRestore()
    }
  })

  it('prepares the browser runtime only for the selected Bot', async () => {
    const ctx = new Context()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        browser: { bots: ['bot-browser'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
      }, []) })
      const workspaces = ctx.get('botWorkspaces')
      if (workspaces === undefined) throw new Error('VPS Bot workspaces were not registered')
      await workspaces.prepare(BOT_SESSION, BotId('bot-browser'))
      await workspaces.prepare(DESKTOP_SESSION, BotId('bot-offline'))
      await workspaces.prepare(BOT_SESSION, BotId('bot-browser'))
      expect(ensure.mock.calls).toEqual([[BOT_SESSION], [DESKTOP_SESSION], [BOT_SESSION]])
      expect(ensure.mock.contexts[0]).toBe(ensure.mock.contexts[2])
      expect(ensure.mock.contexts[0]).not.toBe(ensure.mock.contexts[1])
    } finally {
      ensure.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('binds the real Agent scope and fences host tools without changing ordinary sessions', async () => {
    const ctx = new Context()
    const argv = vi.spyOn(VpsRuntime.prototype, 'execArgv')
      .mockImplementation((_sessionId, command) => ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...command])
    const readJournal = vi.spyOn(VpsJournal.prototype, 'read').mockResolvedValue({
      version: 1, generatedAt: '2026-01-01T00:00:00.000Z', recovery: [], primaryAudit: [],
    })
    const browserStatus = vi.spyOn(VpsIsolatedBrowser.prototype, 'status').mockResolvedValue({ available: true })
    const browserNavigate = vi.spyOn(VpsIsolatedBrowser.prototype, 'navigate').mockResolvedValue(undefined)
    const browserLogin = vi.spyOn(VpsBrowserLogin.prototype, 'request').mockResolvedValue({ state: 'submitted' })
    const routes: ConnectionFetchRoute[] = []
    const bindWorkspace = vi.fn<Context['terminalController']['bindWorkspace']>().mockReturnValue(() => Promise.resolve())
    let directOwnerTurn = true
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjections)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access' })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.provide('attachments', {} as never)
      ctx.provide('terminalController', { bindWorkspace } as never)
      ctx.provide('connection', { fetch: {
        register(route: ConnectionFetchRoute) {
          routes.push(route)
          return () => { routes.splice(routes.indexOf(route), 1) }
        },
      } } as never)
      ctx.provide('bots', {
        ownerBotForSession: async (sessionId: string) => {
          if (sessionId === BOT_SESSION) return { id: 'bot-test', sessionId, state: 'active' }
          if (sessionId === DESKTOP_SESSION) return { id: 'bot-desktop', sessionId, state: 'active' }
          if (sessionId === LEGACY_SESSION) return { id: 'bot-legacy', sessionId, state: 'active' }
          return undefined
        },
        isDirectOwnerTurn: async () => directOwnerTurn,
      } as never)
      await ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-test', 'bot-desktop'],
          desktopOnlyBots: ['bot-desktop'],
          sharedWorkspace: { bots: ['bot-desktop'] },
          isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: ['bot-test', 'bot-desktop'], savedLogins: true },
        }, [], undefined, {
          socketPath: '/run/yharness-test.sock', bots: ['bot-test', 'bot-desktop'],
        })
      })
      const files = await ctx.workspaceFileAccess.forSession(BOT_SESSION, new AbortController().signal)
      expect(files?.workspaceRoot).toBe(`/yharness-test-bots/${BOT_SESSION}`)
      expect(files?.fs).toBeInstanceOf(VpsBotFileSystem)
      await expect(ctx.workspaceFileAccess.forSession(DESKTOP_SESSION, new AbortController().signal)).resolves.toBeUndefined()
      await expect(ctx.workspaceFileAccess.forSession(LEGACY_SESSION, new AbortController().signal)).resolves.toBeUndefined()
      const desktopFiles = await ctx.workspaceFileAccess.forComputer?.(DESKTOP_SESSION, new AbortController().signal)
      expect(desktopFiles?.workspaceRoot).toBe(`/yharness-test-bots/${DESKTOP_SESSION}`)
      expect(desktopFiles?.fs).toBeInstanceOf(VpsBotFileSystem)
      await expect(ctx.workspaceFileAccess.forComputer?.(LEGACY_SESSION, new AbortController().signal)).resolves.toBeUndefined()
      await expect(ctx.workspaceFileAccess.forComputer?.(BOT_SESSION, new AbortController().signal)).resolves.toEqual(files)
      const signal = new AbortController().signal
      const sharedFiles = await ctx.workspaceFileAccess.forComputer?.(DESKTOP_SESSION, signal, '/workspace/notes.txt')
      expect(sharedFiles?.workspaceRoot).toBe('/workspace')
      expect(sharedFiles?.fs).not.toBe(desktopFiles?.fs)
      await expect(ctx.workspaceFileAccess.forComputer?.(BOT_SESSION, signal, '/workspace')).resolves.toBeUndefined()
      await expect(ctx.workspaceFileAccess.forComputer?.(LEGACY_SESSION, signal, '/workspace')).resolves.toBeUndefined()
      const injections: IndexInjection[] = []
      ctx.emit('webserver/index-inject', injections)
      expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_WEBSITE_LOGIN__', value: true })
      expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_COMPUTER_SIGN_IN__', value: true })
      ctx.tools.register(defineTool({
        name: 'host_probe',
        description: 'Fixture tool that models a host-only operation.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'host fixture' },
      }))

      const options = { provider: 'fixture', model: 'fixture' }
      const bot = await ctx.agentLoop.create(BOT_SESSION, options)
      const desktop = await ctx.agentLoop.create(DESKTOP_SESSION, options)
      const legacy = await ctx.agentLoop.create(LEGACY_SESSION, options)
      const regular = await ctx.agentLoop.create(SessionId('regular-session'), options)
      const call = { signal: new AbortController().signal, name: 'host_probe', arguments: {} }
      const execution = managedBotExecutionFor({ agent: bot })
      if (execution === undefined) throw new Error('managed Bot execution was not bound')
      expect(execution.workspaceRoot).toBe('/yharness-test-bots/' + BOT_SESSION)
      expect(execution.sandboxPolicy.resolve().mode).toBe('workspace-write')
      const shell = await execution.shell.execute(execution.shell.resolve({ command: 'printf managed-shell' }))
      await expect(shell.result()).resolves.toMatchObject({ exitCode: 0, stdout: { text: 'managed-shell' } })
      expect(argv).toHaveBeenCalledWith(BOT_SESSION, ['bash', '-c', 'printf managed-shell'], {
        workdir: execution.workspaceRoot, stdin: false,
      })
      expect(managedBotExecutionFor({ agent: regular })).toBeUndefined()
      expect(managedBotExecutionFor({ agent: legacy })).toBeUndefined()
      expect(managedBotExecutionFor({ agent: desktop })).toBeUndefined()
      expect(bindWorkspace).toHaveBeenCalledOnce()
      expect(bindWorkspace).toHaveBeenCalledWith(desktop, expect.objectContaining({ cwd: '/yharness-test-bots/' + DESKTOP_SESSION }))
      const desktopPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: desktop }))
      expect(desktopPrompt).toContain('Bash and file tools use your existing Session workspace and permissions.')
      expect(desktopPrompt).not.toContain('managed runtime workspace')
      expect(ctx.tools.get('vps_computer', bot)).toBeDefined()
      expect(ctx.tools.get('vps_computer', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_computer', regular)).toBeUndefined()
      const handoff = routes.find(route => route.path === '/api/computer/sign-in')
      if (handoff === undefined) throw new Error('Owner handoff route is unavailable')
      const send = (body: object): Promise<Response> => handoff.fetch(new Request('http://127.0.0.1/api/computer/sign-in', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      for (const agent of [bot, desktop]) {
        expect(ctx.tools.get('vps_computer', agent)?.parameters).toMatchObject({
          properties: { action: { enum: expect.arrayContaining(['navigate', 'request_saved_login', 'request_sign_in']) as object } },
        })
        const sessionId = agent.session.id
        const controller = new AbortController()
        const waiting = ctx.tools.execute({
          ...call, signal: controller.signal, name: 'vps_computer', callId: ToolCallId('manual-sign-in-' + sessionId),
          arguments: { action: 'request_sign_in' }, agent,
        })
        try {
          const status = { action: 'status', sessionId }
          const readStatus = async () => (await (await send(status)).json()) as { request: { id: string } | null }
          await expect.poll(async () => (await readStatus()).request?.id ?? '').not.toBe('')
          const { request } = await readStatus()
          if (request === null) throw new Error('Owner handoff request expired')
          await expect((await send({ ...status, sessionId: LEGACY_SESSION })).json()).resolves.toEqual({ request: null })
          const answer = { sessionId, requestId: request.id, viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
          expect((await send({ ...answer, action: 'take', sessionId: LEGACY_SESSION })).status).toBe(409)
          await expect((await send({ ...answer, action: 'take' })).json()).resolves.toEqual({ mode: 'controlling' })
          expect((await send({ ...answer, action: 'complete' })).status).toBe(200)
          await expect(waiting).resolves.toMatchObject({ isError: false })
        } finally {
          controller.abort()
          await waiting
        }
      }
      await expect(ctx.tools.execute({
        ...call,
        name: 'vps_computer',
        callId: ToolCallId('bot-navigate-call'),
        arguments: { action: 'navigate', url: 'https://example.test/path' },
        agent: bot,
      })).resolves.toMatchObject({ isError: false })
      expect(browserStatus).toHaveBeenCalledWith('bot-test', BOT_SESSION, expect.any(AbortSignal))
      expect(browserNavigate).toHaveBeenCalledWith(
        'bot-test', BOT_SESSION, 'https://example.test/path', expect.any(AbortSignal),
      )
      await expect(ctx.tools.execute({
        ...call,
        name: 'vps_computer',
        callId: ToolCallId('bot-login-call'),
        arguments: { action: 'request_saved_login' },
        agent: bot,
      })).resolves.toMatchObject({ isError: false })
      expect(browserLogin).toHaveBeenCalledWith('bot-test', BOT_SESSION, expect.any(Function), expect.any(AbortSignal))
      browserLogin.mockResolvedValueOnce({ state: 'needs-owner' })
      const fallback = await ctx.tools.execute({
        ...call, name: 'vps_computer', callId: ToolCallId('saved-login-needs-owner'),
        arguments: { action: 'request_saved_login' }, agent: bot,
      })
      expect(JSON.stringify(fallback)).toContain('Use request_sign_in to ask the owner to take over.')
      const pending = vi.spyOn(VpsBrowserLogin.prototype, 'hasPending').mockImplementation(session => session === BOT_SESSION)
      try {
        await expect(ctx.tools.execute({
          ...call, name: 'vps_computer', callId: ToolCallId('manual-sign-in-overlap'),
          arguments: { action: 'request_sign_in' }, agent: bot,
        })).resolves.toMatchObject({ isError: true })
        await expect((await send({ action: 'status', sessionId: BOT_SESSION })).json()).resolves.toEqual({ request: null })
      } finally {
        pending.mockRestore()
      }
      const loginCalls = browserLogin.mock.calls.length
      directOwnerTurn = false
      await expect(ctx.tools.execute({
        ...call,
        name: 'vps_computer',
        callId: ToolCallId('bot-login-not-owner-call'),
        arguments: { action: 'request_saved_login' },
        agent: bot,
      })).resolves.toMatchObject({ isError: true })
      expect(browserLogin).toHaveBeenCalledTimes(loginCalls)
      await expect(ctx.tools.execute({
        ...call, name: 'vps_computer', callId: ToolCallId('manual-sign-in-not-owner'),
        arguments: { action: 'request_sign_in' }, agent: bot,
      })).resolves.toMatchObject({ isError: true })
      await expect((await send({ action: 'status', sessionId: BOT_SESSION })).json()).resolves.toEqual({ request: null })
      expect(ctx.tools.get('vps_service_journal', bot)).toBeDefined()
      expect(ctx.tools.get('vps_service_journal', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_service_journal', legacy)).toBeUndefined()
      expect(ctx.tools.get('vps_service_journal', regular)).toBeUndefined()

      await expect(ctx.tools.execute({ ...call, name: 'vps_service_journal', callId: ToolCallId('journal-call'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
      expect(readJournal).toHaveBeenCalledExactlyOnceWith('bot-test', call.signal)
      await expect(ctx.tools.execute({ ...call, name: 'vps_service_journal', callId: ToolCallId('desktop-journal-call'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      expect(readJournal).toHaveBeenNthCalledWith(2, 'bot-desktop', call.signal)
      const journal = ctx.get('botVpsJournal')
      if (journal === undefined) throw new Error('native Bot journal reader was not mounted')
      expect(journal.forBot(BotId('bot-legacy'))).toBeUndefined()
      const readDesktopJournal = journal.forBot(BotId('bot-desktop'))
      if (readDesktopJournal === undefined) throw new Error('desktop-only Bot journal grant was not mounted')
      await expect(readDesktopJournal(call.signal)).resolves.toMatchObject({ version: 1 })
      expect(readJournal).toHaveBeenNthCalledWith(3, 'bot-desktop', call.signal)
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('bot-call'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('desktop-call'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('regular-call'), agent: regular }))
        .resolves.toMatchObject({ isError: false })
    } finally {
      argv.mockRestore()
      readJournal.mockRestore()
      browserStatus.mockRestore()
      browserNavigate.mockRestore()
      browserLogin.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})
