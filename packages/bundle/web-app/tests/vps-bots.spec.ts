import { setImmediate } from 'node:timers/promises'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import { BotId } from '@yharness/bots'
import LlmRuntime, { ToolCallId } from '@yharness/llm'
import { managedBotExecutionFor, SandboxPolicyService, setSandboxMode } from '@yharness/sandbox-policy'
import SessionStore, { SessionId } from '@yharness/session'
import SessionProjections from '@yharness/session-projection'
import SystemPrompt, { renderPrompt } from '@yharness/system-prompt'
import ToolRuntime, { defineTool, type ToolDefinition } from '@yharness/tools'
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
import { ComputerLeaseError, VpsComputer } from '../src/computer.ts'
import * as VpsUpload from '../src/vps-bot-upload.ts'

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

  it('opens the isolated Browser and Linux Desktop of the same owner Bot with separate leases', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const bot = { id: BotId('bot-with-browser'), sessionId: BOT_SESSION, state: 'active' }
    const other = { id: BotId('bot-without-browser'), sessionId: DESKTOP_SESSION, state: 'active' }
    const browserImage = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0xff, 0xd9])
    const desktopImage = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    const desktop = vi.spyOn(VpsRuntime.prototype, 'desktopCommand').mockResolvedValue(desktopImage)
    const status = vi.spyOn(VpsIsolatedBrowser.prototype, 'status').mockResolvedValue({ available: true })
    const browser = vi.spyOn(VpsIsolatedBrowser.prototype, 'frame').mockResolvedValue(browserImage)
    const browserInput = vi.spyOn(VpsIsolatedBrowser.prototype, 'input').mockResolvedValue(undefined)
    const browserRestart = vi.spyOn(VpsIsolatedBrowser.prototype, 'restart').mockResolvedValue('restarted')
    const desktopRestart = vi.spyOn(VpsRuntime.prototype, 'restart').mockResolvedValue('restarted')
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', {
        ownerBotForSession: async (id: string) => [bot, other].find(candidate => candidate.sessionId === id),
      } as never)
      await ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test',
          isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: [bot.id] },
        }, [])
      })
      const request = (endpoint: string, body: object): Promise<Response> => {
        const path = '/api/computer/' + endpoint
        const route = routes.find(item => item.path === path)
        if (route === undefined) throw new Error('Computer route was not registered')
        return Promise.resolve(route.fetch(new Request('http://127.0.0.1' + path, {
          method: 'POST', body: JSON.stringify(body),
        })))
      }
      const owner = { sessionId: bot.sessionId, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
      const onDesktop = { ...owner, surface: 'desktop' }
      const click = { kind: 'click', x: 12, y: 20, button: 1 }
      await expect((await request('status', owner)).json()).resolves.toMatchObject({
        available: true, computer: { id: bot.id, browser: true, desktop: true },
      })
      expect(ensure).not.toHaveBeenCalled()
      expect(browser).not.toHaveBeenCalled()
      const denied = await request('status', { ...onDesktop, sessionId: other.sessionId })
      await expect(denied.json()).resolves.toMatchObject({ available: false })
      expect((await request('frame', { ...onDesktop, sessionId: SHARED_BROWSER_SESSION })).status).toBe(409)
      expect((await request('frame', { ...onDesktop, surface: 'other' })).status).toBe(400)

      await expect((await request('frame', owner)).json()).resolves.toMatchObject({ jpeg: browserImage.toString('base64') })
      await expect((await request('frame', onDesktop)).json()).resolves.toMatchObject({ jpeg: desktopImage.toString('base64') })
      expect(ensure).toHaveBeenCalledWith(bot.sessionId)

      expect((await request('take-control', onDesktop)).status).toBe(200)
      expect((await request('input', { ...owner, action: click })).status).toBe(409)
      expect((await request('input', { ...onDesktop, action: click })).status).toBe(200)
      expect(browserInput).not.toHaveBeenCalled()
      expect(desktop).toHaveBeenCalledWith(bot.sessionId, expect.arrayContaining(['click', '1']), expect.any(AbortSignal), undefined)
      expect((await request('restart', { sessionId: bot.sessionId, surface: 'desktop' })).status).toBe(409)
      expect((await request('release-control', onDesktop)).status).toBe(200)
      expect((await request('restart', { sessionId: bot.sessionId, surface: 'desktop' })).status).toBe(200)
      expect(desktopRestart).toHaveBeenCalledExactlyOnceWith(bot.sessionId, expect.any(AbortSignal))
      expect(browserRestart).not.toHaveBeenCalled()
      expect((await request('restart', { sessionId: bot.sessionId })).status).toBe(200)
      expect(browserRestart).toHaveBeenCalledExactlyOnceWith(bot.id, bot.sessionId, expect.any(AbortSignal))
    } finally {
      ensure.mockRestore()
      desktop.mockRestore()
      status.mockRestore()
      browser.mockRestore()
      browserInput.mockRestore()
      browserRestart.mockRestore()
      desktopRestart.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it.each(['desktop', 'browser'] as const)('finishes pending %s startup before disposing its controllers', async (surface) => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const bot = { id: BotId('bot-managed'), sessionId: BOT_SESSION, state: 'active' }
    const entered = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const prepare = async (): Promise<void> => {
      entered.resolve(undefined)
      await proceed.promise
    }
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockImplementation(prepare)
    const status = vi.spyOn(VpsIsolatedBrowser.prototype, 'status').mockImplementation(async () => {
      await prepare()
      return { available: true }
    })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    const desktop = vi.spyOn(VpsRuntime.prototype, 'desktopCommand').mockResolvedValue(jpeg)
    const browser = vi.spyOn(VpsIsolatedBrowser.prototype, 'frame').mockResolvedValue(jpeg)
    let disposal: Promise<void> | undefined
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { ownerBotForSession: async (id: string) => id === BOT_SESSION ? bot : undefined } as never)
      const isolatedBrowser = surface === 'browser' ? { bots: [bot.id], socketPath: '/run/yharness-browser.sock' } : undefined
      await ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test',
          ...(isolatedBrowser === undefined ? {} : { isolatedBrowser }),
        }, [])
      })
      const route = routes.find(item => item.path === '/api/computer/frame')
      if (route === undefined) throw new Error('Computer frame route was not registered')
      const frame = route.fetch(new Request('http://127.0.0.1/api/computer/frame', {
        method: 'POST',
        body: JSON.stringify({ sessionId: BOT_SESSION, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      }))
      await entered.promise
      let disposed = false
      disposal = ctx.fiber.dispose().then(() => { disposed = true })
      await setImmediate()
      expect(disposed).toBe(false)
      proceed.resolve(undefined)
      expect((await frame).status).toBe(409)
      expect(desktop).not.toHaveBeenCalled()
      expect(browser).not.toHaveBeenCalled()
    } finally {
      proceed.resolve(undefined)
      await (disposal ?? ctx.fiber.dispose())
      ensure.mockRestore()
      status.mockRestore()
      desktop.mockRestore()
      browser.mockRestore()
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
      const status = async (id: string) => {
        const response = await post('sign-in', { action: 'status', sessionId: id })
        return response.json() as Promise<{ request: { id: string; targetSessionId: string } | null }>
      }
      pending = tool.execute({ action: 'request_sign_in' }, { agent, signal: lifetime.signal } as never)
      const requestIdMatcher: unknown = expect.any(String)
      const targetIdMatcher: unknown = expect.stringMatching(/^handoff-/u)
      await expect.poll(() => status(BOT_SESSION)).toEqual({
        request: { id: requestIdMatcher, targetSessionId: targetIdMatcher, canCancel: true, origin: 'https://example.test' },
      })
      const { request } = await status(BOT_SESSION)
      if (request === null) throw new Error('No owner sign-in request')
      await expect(status(DESKTOP_SESSION)).resolves.toEqual({ request: null })
      await expect(status(session)).resolves.toEqual({ request: null })
      const waitEnded: unknown = expect.stringContaining('sign-in wait ended')
      await expect(tool.execute({ action: 'request_sign_in' }, { agent, signal: lifetime.signal } as never))
        .resolves.toEqual({ message: waitEnded })
      const lease = begin.mock.calls[0]?.[0].lease
      expect(lease).toMatch(/^[a-f0-9]{32}$/u)
      const binding = { bot: botId, session, lease }
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
      const targetMethod = Reflect.get(VpsBrowserHandoffs.prototype, 'target')
      let targetLookups = 0
      const staleTarget = vi.spyOn(VpsBrowserHandoffs.prototype, 'target').mockImplementation(function (
        this: VpsBrowserHandoffs, targetId: string,
      ) {
        const view = Reflect.apply(targetMethod, this, [targetId])
        targetLookups += 1
        return view === undefined || targetLookups !== 2 ? view : { ...view }
      })
      expect((await post('take-control', { sessionId: target.sessionId, viewerId })).status).toBe(409)
      expect(targetLookups).toBe(2)
      staleTarget.mockRestore()
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
        await expect(pending).resolves.toEqual({ message: waitEnded })
        expect(finish).toHaveBeenCalledExactlyOnceWith(binding, 'discard', expect.any(AbortSignal))
        return
      }
      if (outcome === 'revoked') active = false
      if (outcome === 'worker-unavailable') {
        finish.mockRejectedValue(new Error('Worker diagnostics are private.'))
      }
      const reply = await post('sign-in', { ...target, action: outcome === 'cancel' ? 'cancel' : 'complete' })
      expect(reply.status).toBe(outcome === 'complete' || outcome === 'cancel' ? 200 : 409)
      const resultMessage: unknown = expect.stringContaining(outcome === 'complete' ? 'returned the Computer'
        : outcome === 'cancel' ? 'declined the sign-in' : 'sign-in wait ended')
      await expect(pending).resolves.toEqual({ message: resultMessage })
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

  it('requires journal grants to select private Computer Bots', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
    }, [], undefined, { socketPath: '/run/yharness-journal.sock', bots: ['bot-unselected'] }) }).toThrow(
      'VPS journal grants must select Computer Bots.',
    )
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
    const login = vi.spyOn(VpsBrowserLogin.prototype, 'request').mockImplementation(async (_bot, _session, lease, signal) => {
      await lease(async () => undefined, signal)
      return { state: 'submitted' }
    })
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
      const submitted: unknown = expect.stringContaining('sign-in submission')
      await expect(tool.execute({ action: 'request_saved_login' }, { agent, signal } as never))
        .resolves.toEqual({ message: submitted })
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

  it('publishes the exact owner roster and refuses a stale browser assignment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yh-vps-bots-roster-'))
    const rosterPath = join(directory, 'owners.json')
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const bot = { id: BotId('bot-roster'), sessionId: BOT_SESSION, state: 'active' as const }
    const creating = { id: BotId('bot-creating'), sessionId: DESKTOP_SESSION, state: 'creating' as const }
    const stale = { id: BotId('bot-stale'), sessionId: LEGACY_SESSION, state: 'active' as const }
    const rows = [bot, creating, stale]
    const list = vi.fn(async () => ({ bots: rows }))
    const ownerBotForSession = vi.fn(async (sessionId: string) => {
      if (sessionId === BOT_SESSION) return bot
      if (sessionId === LEGACY_SESSION) return { ...stale, id: BotId('bot-other') }
      return undefined
    })
    const socketPath = join(directory, 'browser.sock')
    const server: Server = createServer((socket) => {
      const chunks: Buffer[] = []
      socket.on('data', chunk => chunks.push(chunk))
      socket.once('end', () => {
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action?: string }
        socket.end(JSON.stringify(request.action === 'status'
          ? { available: true }
          : request.action === 'frame'
            ? { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), width: 1280, height: 800 }
            : { ok: true }))
      })
    })
    const automaticLogin = vi.fn(async () => 'unavailable' as const)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      await chmod(directory, 0o2750)
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { list, ownerBotForSession } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [bot.id], sharedWorkspace: null,
        isolatedBrowser: {
          socketPath, bots: [bot.id], sharedBots: [bot.id], savedLogins: true,
          ownerRosterPath: rosterPath,
        },
      }, [], undefined, undefined, automaticLogin) })
      await expect.poll(() => list).toHaveBeenCalledOnce()
      const injections: IndexInjection[] = []
      ctx.emit('webserver/index-inject', injections)
      expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_SHARED_BROWSER__', value: true })
      expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_COMPUTER_SIGN_IN__', value: true })
      expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_WEBSITE_LOGIN__', value: true })
      const shared = ctx.get('botSharedBrowser')
      if (shared === undefined) throw new Error('shared browser provider was not mounted')
      await expect(shared.available(BotId('bot-not-isolated'), SHARED_BROWSER_SESSION, BOT_SESSION,
        new AbortController().signal)).resolves.toBe(false)
      await expect(shared.available(bot.id, SHARED_BROWSER_SESSION, BOT_SESSION,
        new AbortController().signal)).resolves.toBe(true)
      const frameRoute = routes.find(route => route.path === '/api/computer/frame')
      if (frameRoute === undefined) throw new Error('owner frame route was not mounted')
      await expect(frameRoute.fetch(new Request('http://127.0.0.1/api/computer/frame', {
        method: 'POST', body: JSON.stringify({ sessionId: BOT_SESSION,
          viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      }))).resolves.toHaveProperty('status', 200)
      const takeControl = routes.find(route => route.path === '/api/computer/take-control')
      const navigate = routes.find(route => route.path === '/api/computer/navigate')
      if (takeControl === undefined || navigate === undefined) throw new Error('browser routes were not mounted')
      await expect(takeControl.fetch(new Request('http://127.0.0.1/api/computer/take-control', {
        method: 'POST', body: JSON.stringify({ sessionId: BOT_SESSION,
          viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      }))).resolves.toHaveProperty('status', 200)
      await expect(navigate.fetch(new Request('http://127.0.0.1/api/computer/navigate', {
        method: 'POST', body: JSON.stringify({ sessionId: BOT_SESSION,
          viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', url: 'https://example.test/' }),
      }))).resolves.toHaveProperty('status', 200)
      expect(() => shared.toolForSession(ctx, { id: SHARED_BROWSER_SESSION } as never, bot.id,
        async () => true, BOT_SESSION)).toThrow('attachment and model services')

      await rm(directory, { recursive: true, force: true })
      rows[0] = { ...bot, id: BotId('bot-roster-new') }
      ctx.emit('bots/changed')
      await expect.poll(() => list).toHaveBeenCalledTimes(2)
      await expect(frameRoute.fetch(new Request('http://127.0.0.1/api/computer/frame', {
        method: 'POST', body: JSON.stringify({ sessionId: BOT_SESSION,
          viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      }))).resolves.toHaveProperty('status', 409)
      expect(routes.some(route => route.path === '/api/computer/sign-in')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
      await new Promise<void>((resolve) => {
        if (!server.listening) { resolve(); return }
        server.close(() => { resolve() })
      })
    }

    const unavailable = new Context()
    try {
      await unavailable.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [bot.id], isolatedBrowser: {
          socketPath: '/run/yharness-browser/control.sock', bots: [bot.id], sharedBots: [bot.id], ownerRosterPath: rosterPath,
        },
      }, []) })
      const provider = unavailable.get('botSharedBrowser')
      if (provider === undefined) throw new Error('shared browser provider was not mounted')
      await expect(provider.available(bot.id, SHARED_BROWSER_SESSION, BOT_SESSION,
        new AbortController().signal)).resolves.toBe(false)
    } finally {
      await unavailable.fiber.dispose()
    }
  })

  it('keeps owner setting, file, and restart routes scoped to an active desktop Bot', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const selected = { id: BotId('bot-route'), sessionId: BOT_SESSION, state: 'active' as const }
    const stale = { id: BotId('bot-stale-route'), sessionId: DESKTOP_SESSION, state: 'creating' as const }
    const unselected = { id: BotId('bot-unselected-route'), sessionId: LEGACY_SESSION, state: 'active' as const }
    const ownerBotForSession = vi.fn(async (sessionId: string) => [selected, stale, unselected]
      .find(bot => bot.sessionId === sessionId))
    const terminalList = vi.fn(() => [] as never[])
    const downloadComputer = vi.fn(async () => new Response('fixture-download'))
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    const internetFor = vi.spyOn(VpsRuntime.prototype, 'internetFor').mockResolvedValue(true)
    const sharedWorkspaceFor = vi.spyOn(VpsRuntime.prototype, 'sharedWorkspaceFor').mockResolvedValue('/workspace')
    const supportsNetworkControl = vi.spyOn(VpsRuntime.prototype, 'supportsNetworkControl').mockReturnValue(true)
    const supportsSharedWorkspaceControl = vi.spyOn(VpsRuntime.prototype, 'supportsSharedWorkspaceControl').mockReturnValue(true)
    const setInternetAccess = vi.spyOn(VpsRuntime.prototype, 'setInternetAccess').mockResolvedValue('applied')
    const setSharedWorkspaceAccess = vi.spyOn(VpsRuntime.prototype, 'setSharedWorkspaceAccess').mockResolvedValue('applied')
    const restart = vi.spyOn(VpsRuntime.prototype, 'restart').mockResolvedValue('restarted')
    const desktopCommand = vi.spyOn(VpsRuntime.prototype, 'desktopCommand').mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const runWhileBotControls = vi.spyOn(VpsComputer.prototype, 'runWhileBotControls')
      .mockRejectedValue(new ComputerLeaseError('fixture lease'))
    const dispose = vi.spyOn(VpsRuntime.prototype, 'dispose').mockResolvedValue(undefined)
    const uploadComputerFile = vi.spyOn(VpsUpload, 'uploadComputerFile').mockResolvedValue('stored')
    try {
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('bots', { ownerBotForSession } as never)
      ctx.provide('terminalController', { list: terminalList } as never)
      ctx.provide('workspaceFiles', {
        downloadComputer, list: vi.fn(async () => ({ entries: [], truncated: false })),
        read: vi.fn(async () => ({ text: '', version: 'fixture-version', offset: 1, lines: 0, eof: true })),
      } as never)
      await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [selected.id, stale.id],
        sharedWorkspace: { bots: [selected.id] }, network: { bots: [selected.id] },
      }, []) })
      const request = async (path: string, body: object): Promise<Response> => {
        const route = routes.find(candidate => candidate.path === path)
        if (route === undefined) throw new Error(`Route ${path} was not mounted`)
        return route.fetch(new Request('http://127.0.0.1' + path, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        }))
      }
      const status = await request('/api/computer/status', { sessionId: BOT_SESSION })
      await expect(status.json()).resolves.toMatchObject({
        available: true,
        computer: {
          id: selected.id, location: 'vps', permissionScope: 'bot', terminal: true, terminalInternet: true,
          networkControl: true, restart: true, files: true, sharedFiles: true, sharedWorkspaceControl: true,
        },
      })
      await expect((await request('/api/computer/status', {})).json()).resolves.toMatchObject({ available: false })
      await expect((await request('/api/computer/status', { sessionId: LEGACY_SESSION })).json())
        .resolves.toMatchObject({ available: false })
      expect(ctx.botWorkspaces.workspace(BOT_SESSION)).toBe(`/yharness-test-bots/${BOT_SESSION}`)
      await ctx.botWorkspaces.prepare(BOT_SESSION, selected.id)
      expect(ensure).toHaveBeenCalledWith(BOT_SESSION)

      const invalid = await request('/api/computer/network', { sessionId: BOT_SESSION, enabled: true, extra: false })
      expect(invalid.status).toBe(400)
      await expect((await request('/api/computer/network', { sessionId: BOT_SESSION, enabled: true })).json())
        .resolves.toEqual({ status: 'applied', enabled: true })
      supportsSharedWorkspaceControl.mockReturnValueOnce(false)
      await expect((await request('/api/computer/shared-workspace', { sessionId: BOT_SESSION, enabled: true })).json())
        .resolves.toEqual({ status: 'unavailable' })
      await expect((await request('/api/computer/shared-workspace', { sessionId: BOT_SESSION, enabled: true })).json())
        .resolves.toEqual({ status: 'applied', enabled: true })
      expect(setInternetAccess).toHaveBeenCalledWith(BOT_SESSION, true, expect.any(AbortSignal))
      expect(setSharedWorkspaceAccess).toHaveBeenCalledWith(BOT_SESSION, true, expect.any(AbortSignal))
      await expect((await request('/api/computer/network', { sessionId: LEGACY_SESSION, enabled: true })).json())
        .resolves.toEqual({ status: 'unavailable' })
      await expect((await request('/api/computer/shared-workspace', { sessionId: DESKTOP_SESSION, enabled: true })).json())
        .resolves.toEqual({ status: 'unavailable' })

      await expect((await request('/api/computer/restart', { sessionId: BOT_SESSION })).json())
        .resolves.toEqual({ status: 'restarted' })
      await expect((await request('/api/computer/restart', { sessionId: BOT_SESSION, surface: 'desktop' })).json())
        .resolves.toEqual({ status: 'unavailable' })
      await expect((await request('/api/computer/restart', { sessionId: LEGACY_SESSION })).json())
        .resolves.toEqual({ status: 'unavailable' })
      expect(restart).toHaveBeenCalledWith(BOT_SESSION, expect.any(AbortSignal))

      const download = routes.find(route => route.path === '/api/computer/files/download')
      if (download === undefined) throw new Error('download route was not mounted')
      const downloaded = await download.fetch(new Request(
        'http://127.0.0.1/api/computer/files/download?sessionId=' + BOT_SESSION + '&path=notes.txt',
      ))
      expect(await downloaded.text()).toBe('fixture-download')
      expect(downloadComputer).toHaveBeenCalledWith(BOT_SESSION, 'notes.txt', expect.any(AbortSignal))
      const upload = routes.find(route => route.path === '/api/computer/files/upload')
      if (upload === undefined) throw new Error('upload route was not mounted')
      const unavailableUpload = await upload.fetch(new Request(
        'http://127.0.0.1/api/computer/files/upload?sessionId=' + DESKTOP_SESSION + '&directory=.&name=notes.txt&bytes=0',
        { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': '0' }, body: '' },
      ))
      expect(unavailableUpload.status).toBe(404)
      const storedUpload = await upload.fetch(new Request(
        'http://127.0.0.1/api/computer/files/upload?sessionId=' + BOT_SESSION + '&directory=.&name=notes.txt&bytes=0',
        { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': '0' }, body: '' },
      ))
      expect(storedUpload.status).toBe(201)
      expect(uploadComputerFile).toHaveBeenCalledWith(expect.any(VpsRuntime), BOT_SESSION,
        expect.objectContaining({ directory: '.', name: 'notes.txt', bytes: 0 }), expect.any(Object), expect.any(AbortSignal))

      const privateFiles = await ctx.workspaceFileAccess.forComputer?.(BOT_SESSION, new AbortController().signal, 'notes.txt')
      const privateFilesAgain = await ctx.workspaceFileAccess.forComputer?.(BOT_SESSION, new AbortController().signal, 'notes.txt')
      expect(privateFilesAgain?.fs === privateFiles?.fs).toBe(true)
      const sharedFiles = await ctx.workspaceFileAccess.forComputer?.(BOT_SESSION, new AbortController().signal, '/workspace/notes.txt')
      expect(sharedFiles?.workspaceRoot).toBe('/workspace')
      await expect(ctx.workspaceFileAccess.forComputer?.(DESKTOP_SESSION, new AbortController().signal))
        .rejects.toThrow('workspace is not ready')

      terminalList.mockReturnValue([{ state: 'running' }] as never[])
      await expect((await request('/api/computer/network', { sessionId: BOT_SESSION, enabled: false })).json())
        .resolves.toEqual({ status: 'busy' })
      terminalList.mockReturnValue([])
      const frame = await request('/api/computer/frame', {
        sessionId: BOT_SESSION, viewerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      })
      expect(frame.status).toBe(200)
      await expect((await request('/api/computer/network', { sessionId: BOT_SESSION, enabled: false })).json())
        .resolves.toEqual({ status: 'busy' })
      expect(runWhileBotControls).toHaveBeenCalled()
      runWhileBotControls.mockRejectedValueOnce(new Error('fixture control failure'))
      await expect((await request('/api/computer/network', { sessionId: BOT_SESSION, enabled: false })).json())
        .resolves.toEqual({ status: 'unavailable' })
      expect(internetFor).toHaveBeenCalledWith(BOT_SESSION)
      expect(sharedWorkspaceFor).toHaveBeenCalledWith(BOT_SESSION)
      expect(supportsNetworkControl).toHaveBeenCalled()
      expect(supportsSharedWorkspaceControl).toHaveBeenCalled()
      expect(desktopCommand).toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
      ensure.mockRestore()
      internetFor.mockRestore()
      sharedWorkspaceFor.mockRestore()
      supportsNetworkControl.mockRestore()
      supportsSharedWorkspaceControl.mockRestore()
      setInternetAccess.mockRestore()
      setSharedWorkspaceAccess.mockRestore()
      restart.mockRestore()
      desktopCommand.mockRestore()
      runWhileBotControls.mockRestore()
      dispose.mockRestore()
      uploadComputerFile.mockRestore()
    }
  })

  it('reports runtime failures after all VPS Bot resources have been asked to stop', async () => {
    const ctx = new Context()
    const dispose = vi.spyOn(VpsRuntime.prototype, 'dispose').mockRejectedValue(new Error('fixture runtime close'))
    try {
      const mounted = await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-close'],
      }, []) })
      await mounted.dispose()
      expect(dispose).toHaveBeenCalled()
    } finally {
      dispose.mockRestore()
    }
  })

  it('keeps a Bot binding failure local to its admission attempt', async () => {
    const ctx = new Context()
    const session = SessionId('bot-session-47888424-5b3d-4a8c-81f5-751ed2d24f95')
    const bot = { id: BotId('bot-rebind'), sessionId: session, state: 'active' as const }
    const bindWorkspace = vi.fn<Context['terminalController']['bindWorkspace']>(() => () => undefined)
    const sharedWorkspaceFor = vi.spyOn(VpsRuntime.prototype, 'sharedWorkspaceFor')
      .mockRejectedValue(new Error('fixture rebind failure'))
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
      ctx.provide('workspaceFiles', {
        downloadComputer: vi.fn(async () => new Response('fixture-download')),
        list: vi.fn(async () => ({ entries: [], truncated: false })),
        read: vi.fn(async () => ({ text: '', version: 'fixture-version', offset: 1, lines: 0, eof: true })),
      } as never)
      ctx.provide('terminalController', { bindWorkspace } as never)
      ctx.provide('bots', { ownerBotForSession: async (id: string) => id === session ? bot : undefined } as never)
      const mounted = await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: [bot.id],
        sharedWorkspace: { bots: [bot.id] },
      }, []) })
      await expect(ctx.agentLoop.create(session, { provider: 'fixture', model: 'fixture' }))
        .rejects.toThrow('fixture rebind failure')
      await mounted.dispose()
    } finally {
      sharedWorkspaceFor.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('binds the opted-in legacy Computer only for supported Agent presets', async () => {
    const ctx = new Context()
    const routes: ConnectionFetchRoute[] = []
    const legacy = new VpsComputer({ display: ':0', authorityPath: '/tmp/yharness-test.Xauthority' })
    const computer = { observe: vi.fn(async () => ({ jpeg: '', width: 1280, height: 800 })), actAsBot: vi.fn(async () => undefined) }
    let preset = 'standard'
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.provide('attachments', {} as never)
      ctx.provide('connection', { fetch: { register: (route: ConnectionFetchRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      } } } as never)
      ctx.provide('vpsComputer', computer as never)
      ctx.provide('agentPresets', { composedPreset: () => preset } as never)
      ctx.provide('bots', { ownerBotForSession: async (sessionId: string) => sessionId === 'unowned-session'
        ? { id: 'bot-legacy-route', sessionId, state: 'active' } : undefined } as never)
      const mounted = await ctx.plugin((scope) => { mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-managed'],
      }, [], legacy) })
      const agent = { id: LEGACY_SESSION, ctx, session: { id: LEGACY_SESSION } } as never
      await ctx.serial('agent/created', { agent, source: 'resume' })
      const status = routes.find(route => route.path === '/api/computer/status')
      if (status === undefined) throw new Error('Legacy Computer route was not registered')
      await expect((await status.fetch(new Request('http://127.0.0.1/api/computer/status', {
        method: 'POST', body: JSON.stringify({ sessionId: 'unowned-session' }),
      }))).json()).resolves.toMatchObject({ available: true, computer: { id: 'shared-vps' } })
      expect(ctx.tools.get('vps_computer', agent)).toBeDefined()
      await expect(ctx.tools.execute({
        name: 'vps_computer', callId: ToolCallId('legacy-computer'), arguments: { action: 'key', key: 'Escape' }, agent,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ isError: false })
      expect(computer.actAsBot).toHaveBeenCalled()
      preset = 'minimal'
      const unsupported = { id: LEGACY_SESSION, ctx, session: { id: LEGACY_SESSION } } as never
      await ctx.serial('agent/created', { agent: unsupported, source: 'resume' })
      await expect(ctx.tools.execute({
        name: 'vps_computer', callId: ToolCallId('legacy-computer-denied'), arguments: { action: 'key', key: 'Escape' }, agent: unsupported,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ isError: true })
      await mounted.dispose()
    } finally {
      await ctx.fiber.dispose()
      await legacy.dispose()
    }
  })

  // The managed shell fixture executes /usr/bin/env and bash on the test host.
  it.skipIf(process.platform === 'win32')('binds the real Agent scope and fences host tools without changing ordinary sessions', async () => {
    const ctx = new Context()
    const argv = vi.spyOn(VpsRuntime.prototype, 'execArgv')
      .mockImplementation((_sessionId, command) => ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', ...command])
    const readJournal = vi.spyOn(VpsJournal.prototype, 'read').mockResolvedValue({
      version: 1, generatedAt: '2026-01-01T00:00:00.000Z', recovery: [], primaryAudit: [],
    })
    const startDesktop = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    const desktopInput = vi.spyOn(VpsRuntime.prototype, 'desktopCommand').mockResolvedValue(Buffer.alloc(0))
    const browserStatus = vi.spyOn(VpsIsolatedBrowser.prototype, 'status').mockResolvedValue({ available: true })
    const browserNavigate = vi.spyOn(VpsIsolatedBrowser.prototype, 'navigate').mockResolvedValue(undefined)
    const browserLogin = vi.spyOn(VpsBrowserLogin.prototype, 'request').mockResolvedValue({ state: 'submitted' })
    const browserComputer = vi.spyOn(VpsIsolatedBrowser.prototype, 'computer').mockImplementation(() => new VpsComputer(
      { display: ':0', authorityPath: '/tmp/yharness-test.Xauthority' },
      { capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]), input: async () => undefined },
    ))
    const routes: ConnectionFetchRoute[] = []
    const terminalClosing = Promise.withResolvers<undefined>()
    const releaseTerminalClose = Promise.withResolvers<undefined>()
    const bindWorkspace = vi.fn<Context['terminalController']['bindWorkspace']>(agent => async () => {
      if (agent.id !== BOT_SESSION) return
      terminalClosing.resolve(undefined)
      await releaseTerminalClose.promise
    })
    const lateSession = SessionId('bot-session-c5496e76-4558-4cf8-a45a-0e59d0723527')
    const lateLookup = Promise.withResolvers<undefined>()
    const releaseLookup = Promise.withResolvers<undefined>()
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
      ctx.provide('workspaceFiles', {
        downloadComputer: vi.fn(async () => new Response('fixture-download')),
        list: vi.fn(async () => ({ entries: [], truncated: false })),
        read: vi.fn(async () => ({ text: '', version: 'fixture-version', offset: 1, lines: 0, eof: true })),
      } as never)
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
          if (sessionId === lateSession) {
            lateLookup.resolve(undefined)
            await releaseLookup.promise
            return { id: 'bot-test', sessionId, state: 'active' }
          }
          return undefined
        },
        isDirectOwnerTurn: async () => directOwnerTurn,
        privateOwnerTurnSource: async () => directOwnerTurn ? 'user' : undefined,
      } as never)
      const mount = () => ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-test', 'bot-desktop'],
          desktopOnlyBots: ['bot-desktop'],
          sharedWorkspace: { bots: ['bot-desktop'] },
          isolatedBrowser: { socketPath: '/run/yharness-browser.sock', bots: ['bot-test', 'bot-desktop'], savedLogins: true },
        }, [], undefined, {
          socketPath: '/run/yharness-test.sock', bots: ['bot-test', 'bot-desktop'],
        })
      })
      const mounted = await mount()
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
      const mcpFixture: ToolDefinition = {
        name: 'mcp_fixture',
        description: 'Fixture MCP operation.',
        source: { kind: 'mcp', serverName: 'fixture' },
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'mcp fixture' },
      }
      ctx.effect(() => ctx.tools.register(mcpFixture), 'fixture MCP tool')
      for (const name of ['bash', 'grep'] as const) {
        ctx.effect(() => ctx.tools.register(defineTool({
          name,
          description: `Fixture ${name} operation.`,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
          async execute() { return `${name} fixture` },
        })), `fixture ${name} tool`)
      }

      const options = { provider: 'fixture', model: 'fixture' }
      const bot = await ctx.agentLoop.create(BOT_SESSION, options)
      const desktop = await ctx.agentLoop.create(DESKTOP_SESSION, options)
      const legacy = await ctx.agentLoop.create(LEGACY_SESSION, options)
      const regular = await ctx.agentLoop.create(SessionId('regular-session'), options)
      const disposedAgent = await ctx.agentLoop.create(SessionId('d1e5a9b8-8c33-4d4a-9df3-0d8fd2f2c1e7'), options)
      await disposedAgent.ctx.fiber.dispose()
      await ctx.serial('agent/created', {
        agent: disposedAgent,
        source: 'resume',
      })
      await Promise.all([
        ctx.serial('agent/created', { agent: bot, source: 'resume' }),
        ctx.serial('agent/created', { agent: bot, source: 'resume' }),
      ])
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
      expect(bindWorkspace).toHaveBeenCalledTimes(2)
      expect(bindWorkspace).toHaveBeenCalledWith(bot, { cwd: execution.workspaceRoot, subprocess: execution.subprocess })
      expect(bindWorkspace).toHaveBeenCalledWith(desktop, expect.objectContaining({ cwd: '/yharness-test-bots/' + DESKTOP_SESSION }))
      const desktopPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: desktop }))
      expect(desktopPrompt).toContain('Bash and file tools use your existing Session workspace and permissions.')
      expect(desktopPrompt).not.toContain('managed runtime workspace')
      const botPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: bot }))
      expect(botPrompt).toContain('managed runtime workspace')
      expect(ctx.tools.get('vps_computer', bot)).toBeDefined()
      expect(ctx.tools.get('vps_computer', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_computer', regular)).toBeUndefined()
      expect(ctx.tools.get('vps_computer', bot)?.parameters).toMatchObject({
        properties: { surface: { enum: ['desktop'] } },
      })
      const projectTool = ctx.tools.get('vps_project_files', desktop)
      if (projectTool === undefined) throw new Error('shared project tool was not registered')
      await expect(ctx.tools.execute({
        ...call, name: 'vps_project_files', callId: ToolCallId('project-list'), agent: desktop,
        arguments: { action: 'list' },
      })).resolves.toMatchObject({ isError: false })
      const mismatched = desktop
      const computerTool = ctx.tools.get('vps_computer', bot)
      if (computerTool === undefined) throw new Error('managed Computer tool was not registered')
      await expect(computerTool.execute({ action: 'key', key: 'Escape' }, {
        agent: mismatched, signal: call.signal,
      } as never)).rejects.toThrow('owning Bot Session')
      await expect(computerTool.execute({ action: 'navigate', url: 'https://example.test/' }, {
        agent: mismatched, signal: call.signal,
      } as never)).rejects.toThrow('owning Bot Session')
      await expect(computerTool.execute({ action: 'key', key: 'Escape', surface: 'desktop' }, {
        agent: mismatched, signal: call.signal,
      } as never)).rejects.toThrow('owning Bot Session')
      await expect(ctx.tools.execute({
        ...call, name: 'vps_computer', callId: ToolCallId('desktop-input'), agent: bot,
        arguments: { action: 'key', surface: 'desktop', key: 'Escape' },
      })).resolves.toMatchObject({ isError: false })
      expect(desktopInput).toHaveBeenCalledWith(BOT_SESSION, expect.arrayContaining(['key', 'Escape']), call.signal, undefined)
      expect(browserStatus).not.toHaveBeenCalled()
      await expect(ctx.tools.execute({
        ...call, name: 'vps_computer', callId: ToolCallId('desktop-website-login'), agent: bot,
        arguments: { action: 'request_saved_login', surface: 'desktop' },
      })).resolves.toMatchObject({ isError: true })
      expect(browserLogin).not.toHaveBeenCalled()
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
      browserLogin.mockImplementationOnce(async (_bot, _session, lease, signal) => {
        await lease(async () => undefined, signal)
        return { state: 'submitted' }
      })
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
      expect(readJournal).toHaveBeenCalledExactlyOnceWith('bot-test', expect.any(AbortSignal))
      await expect(ctx.tools.execute({ ...call, name: 'vps_service_journal', callId: ToolCallId('desktop-journal-call'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      expect(readJournal).toHaveBeenNthCalledWith(2, 'bot-desktop', expect.any(AbortSignal))
      const journal = ctx.get('botVpsJournal')
      if (journal === undefined) throw new Error('native Bot journal reader was not mounted')
      expect(journal.forBot(BotId('bot-legacy'))).toBeUndefined()
      const readDesktopJournal = journal.forBot(BotId('bot-desktop'))
      if (readDesktopJournal === undefined) throw new Error('desktop-only Bot journal grant was not mounted')
      await expect(readDesktopJournal(call.signal)).resolves.toMatchObject({ version: 1 })
      expect(readJournal).toHaveBeenNthCalledWith(3, 'bot-desktop', expect.any(AbortSignal))
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('bot-call'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      await expect(ctx.tools.execute({ ...call, agent: undefined, callId: ToolCallId('host-call-without-agent') }))
        .resolves.toMatchObject({ isError: false })
      const mcpResult = await ctx.tools.execute({ ...call, name: 'mcp_fixture', callId: ToolCallId('mcp-call'), agent: bot })
      expect(ctx.tools.get('mcp_fixture', bot)?.source).toEqual({ kind: 'mcp', serverName: 'fixture' })
      expect(mcpResult).toMatchObject({ isError: false })
      const denied = await ctx.waterfall('tools/pre-execute', {
        ...call, agent: { id: BOT_SESSION } as never,
      } as never, () => Promise.resolve(undefined as never))
      expect(denied).toMatchObject({ kind: 'deny' })
      await expect(ctx.waterfall('tools/pre-execute', {
        ...call, name: 'grep', agent: bot,
      } as never, () => Promise.resolve(undefined as never))).resolves.toBeUndefined()
      await expect(ctx.tools.execute({ ...call, name: 'grep', callId: ToolCallId('grep-call'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
      setSandboxMode(bot.session, 'read-only')
      await expect(ctx.tools.execute({ ...call, name: 'bash', callId: ToolCallId('read-only-bash'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('desktop-call'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({
        ...call, name: 'vps_computer', callId: ToolCallId('primary-input'), agent: bot,
        arguments: { action: 'key', key: 'Escape' },
      })).resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('regular-call'), agent: regular }))
        .resolves.toMatchObject({ isError: false })

      const opening = ctx.agentLoop.create(lateSession, options)
      const refused = expect(opening).rejects.toThrow('VPS Bot Computer scope is closed')
      await lateLookup.promise
      const unloading = mounted.dispose()
      try {
        await ctx.serial('agent/created', {
          agent: {
            id: SessionId('a1b2c3d4-e5f6-47a8-89ab-cdef01234567'), ctx,
            session: { id: SessionId('a1b2c3d4-e5f6-47a8-89ab-cdef01234567') },
          } as never,
          source: 'resume',
        })
        await terminalClosing.promise
        await expect(execution.subprocess.resolveExecutable('/bin/bash')).rejects.toThrow('VPS Bot Computer scope is closed')
        await expect(execution.fs.lstat('notes.txt')).rejects.toThrow('VPS Bot Computer scope is closed')
      } finally {
        releaseTerminalClose.resolve(undefined)
        await unloading
        releaseLookup.resolve(undefined)
        await refused
      }
      expect(managedBotExecutionFor({ agent: bot }) === undefined).toBe(true)
      expect(readJournal.mock.calls.map(([, requestSignal]) => requestSignal.aborted)).toEqual([true, true, true])
      await expect(execution.subprocess.resolveExecutable('/bin/bash')).rejects.toThrow('VPS Bot Computer scope is closed')
      await expect(execution.fs.lstat('notes.txt')).rejects.toThrow('VPS Bot Computer scope is closed')
      expect(ctx.tools.get('vps_computer', desktop)).toBeUndefined()
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('bot-after-reload'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('regular-after-reload'), agent: regular }))
        .resolves.toMatchObject({ isError: false })

      await mount()
      await expect.poll(() => managedBotExecutionFor({ agent: bot })).toBeDefined()
      await expect.poll(() => ctx.tools.get('vps_computer', desktop)).toBeDefined()
      expect(bindWorkspace).toHaveBeenCalledTimes(4)
    } finally {
      releaseLookup.resolve(undefined)
      releaseTerminalClose.resolve(undefined)
      argv.mockRestore()
      readJournal.mockRestore()
      startDesktop.mockRestore()
      desktopInput.mockRestore()
      browserStatus.mockRestore()
      browserNavigate.mockRestore()
      browserLogin.mockRestore()
      browserComputer.mockRestore()
      await ctx.fiber.dispose()
    }
  })
})
