import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import { BotId } from '@yharness/bots'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import LlmRuntime, { ToolCallId } from '@yharness/llm'
import { managedBotExecutionFor, SandboxPolicyService, setSandboxMode } from '@yharness/sandbox-policy'
import SessionStore, { SessionId } from '@yharness/session'
import SessionProjections from '@yharness/session-projection'
import SystemPrompt, { renderPrompt } from '@yharness/system-prompt'
import ToolRuntime, { defineTool } from '@yharness/tools'
import { LocalSubprocessRuntime } from '@yharness/subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { ComputerHost } from '../src/computer.ts'
import { mountVpsBots } from '../src/vps-bots.ts'
import { VpsJournal } from '../src/vps-journal.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const BOT_SESSION = SessionId('bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76')
const DESKTOP_SESSION = SessionId('bot-session-5f3ec8e4-4c34-4ec6-a38f-aad6d07cb337')
const LEGACY_SESSION = SessionId('bot-session-37888424-5b3d-4a8c-81f5-751ed2d24f95')
const FIXTURE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

function registerRoutes(ctx: Context) {
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
    routes.set(route.path, route)
    return () => { routes.delete(route.path) }
  } } } as never)
  return async (endpoint: string, payload: object): Promise<Response> => {
    const route = routes.get('/api/computer/' + endpoint)
    if (route === undefined) throw new Error('The Computer route is missing')
    return route.fetch(new Request('http://127.0.0.1' + route.path, {
      method: 'POST', body: JSON.stringify(payload),
    }))
  }
}

describe('managed VPS Bot composition', () => {
  it('rejects desktop-only Bots outside the selected Bot allowlist', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-selected'], desktopOnlyBots: ['bot-other'],
    }, []) }).toThrow('Desktop-only VPS Bots must be selected by botComputers.bots.')
  })

  it('rejects a journal grant outside the selected Computer Bots', () => {
    expect(() => { mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-selected'],
    }, [], undefined, { socketPath: '/run/yharness-test.sock', bots: ['bot-other'] }) })
      .toThrow('VPS journal grants must select Computer Bots.')
  })

  it('requires a Session on a fresh installation with no shared display', async () => {
    const ctx = new Context()
    const request = registerRoutes(ctx)
    const ownerBotForSession = vi.fn(async () => undefined)
    ctx.provide('bots', { ownerBotForSession } as never)
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, { root: '/yharness-test-bots', image: 'localhost/yharness-test' }, []) })
      expect(ctx.get('botWorkspaces')?.managed?.('fixture-bot')).toBe(true)
      expect(ctx.get('botVpsJournal')).toBeUndefined()
      expect((await request('status', {})).status).toBe(400)
      expect(ownerBotForSession).not.toHaveBeenCalled()
      await expect((await request('status', { sessionId: BOT_SESSION })).json()).resolves.toMatchObject({ available: false })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('quiesces a pending Computer resolution before disposing the VPS scope', async () => {
    const ctx = new Context()
    const request = registerRoutes(ctx)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockImplementation(async (sessionId) => {
      if (sessionId !== BOT_SESSION) throw new Error('unexpected VPS Session')
      entered.resolve(undefined)
      await release.promise
    })
    ctx.provide('bots', {
      ownerBotForSession: async (sessionId: string) => sessionId === BOT_SESSION
        ? { id: 'bot-test', sessionId, state: 'active' }
        : undefined,
    } as never)
    let disposed = false
    let disposing: Promise<void> | undefined
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, { root: '/yharness-test-bots', image: 'localhost/yharness-test' }, []) })
      const status = request('status', { sessionId: BOT_SESSION })
      await entered.promise
      disposing = ctx.fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await expect((await status).json()).resolves.toMatchObject({ available: false })
      await disposing
    } finally {
      release.resolve(undefined)
      ensure.mockRestore()
      if (!disposed) await ctx.fiber.dispose()
    }
  })

  it('shares an in-progress Computer startup and rejects resolution through a retired route', async () => {
    const ctx = new Context()
    const request = registerRoutes(ctx)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const ownersRead = Promise.withResolvers<undefined>()
    const lookupEntered = Promise.withResolvers<undefined>()
    const releaseLookup = Promise.withResolvers<undefined>()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const ownerBotForSession = vi.fn(async () => {
      const lookups = ownerBotForSession.mock.calls.length
      if (lookups === 2) ownersRead.resolve(undefined)
      if (lookups === 3) {
        lookupEntered.resolve(undefined)
        await releaseLookup.promise
      }
      return { id: 'bot-test', sessionId: BOT_SESSION, state: 'active' }
    })
    ctx.provide('bots', { ownerBotForSession } as never)
    const statusRequests: Promise<Response>[] = []
    try {
      await ctx.plugin((scope) => { mountVpsBots(scope, { root: '/yharness-test-bots', image: 'localhost/yharness-test' }, []) })
      statusRequests.push(request('status', { sessionId: BOT_SESSION }))
      await entered.promise
      statusRequests.push(request('status', { sessionId: BOT_SESSION }))
      await ownersRead.promise
      release.resolve(undefined)
      for (const response of await Promise.all(statusRequests)) {
        await expect(response.json()).resolves.toMatchObject({ available: true, computer: { id: 'bot-test' } })
      }
      expect(ensure).toHaveBeenCalledExactlyOnceWith(BOT_SESSION)
      const lateStatus = request('status', { sessionId: BOT_SESSION })
      statusRequests.push(lateStatus)
      await lookupEntered.promise
      await ctx.fiber.dispose()
      releaseLookup.resolve(undefined)
      await expect((await lateStatus).json()).resolves.toMatchObject({ available: false })
      expect(ensure).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(undefined)
      releaseLookup.resolve(undefined)
      await Promise.allSettled(statusRequests)
      await ctx.fiber.dispose()
      ensure.mockRestore()
    }
  })

  // The managed filesystem and execution world use absolute Linux paths.
  it.skipIf(process.platform === 'win32').each([false, true])('binds the exact Agent and desktop with a shared display configured=%s', async (withLegacy) => {
    const ctx = new Context()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue()
    const argv = vi.spyOn(VpsRuntime.prototype, 'execArgv')
      .mockImplementation((_sessionId, command) => command[0] === '/usr/local/bin/yharness-vps-bot-capture'
        ? [process.execPath, '-e', `process.stdout.write(Buffer.from('${FIXTURE_JPEG}', 'base64'))`]
        : [process.execPath, '-e', 'process.stdout.write("managed-shell")'])
    const readJournal = vi.spyOn(VpsJournal.prototype, 'read').mockResolvedValue({
      version: 1, generatedAt: '2026-01-01T00:00:00.000Z', recovery: [], primaryAudit: [],
    })
    const legacyComputer = withLegacy
      ? new ComputerHost({ display: ':legacy', authorityPath: '/dev/null' }, { run: async () => {} })
      : undefined
    const request = registerRoutes(ctx)
    const composedPreset = vi.fn<() => string | undefined>(() => 'standard')
    const regularSession = SessionId('regular-session')
    let regularIsManaged = false
    ctx.provide('agentPresets', { composedPreset } as never)
    if (legacyComputer !== undefined) ctx.provide('vpsComputer', legacyComputer)
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
      ctx.provide('bots', {
        ownerBotForSession: async (sessionId: string) => {
          if (sessionId === BOT_SESSION) return { id: 'bot-test', sessionId, state: 'active' }
          if (sessionId === DESKTOP_SESSION) return { id: 'bot-desktop', sessionId, state: 'active' }
          if (sessionId === LEGACY_SESSION) return { id: 'bot-legacy', sessionId, state: 'active' }
          if (regularIsManaged && sessionId === regularSession) return { id: 'bot-test', sessionId, state: 'active' }
          return undefined
        },
      } as never)
      await ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-test', 'bot-desktop'],
          desktopOnlyBots: ['bot-desktop'],
        }, [{ unit: 'fixture.service', scope: 'user', bots: ['bot-desktop'] }], legacyComputer, withLegacy ? {
          socketPath: '/run/yharness-test.sock', bots: ['bot-test', 'bot-desktop'],
        } : undefined)
      })
      ctx.tools.register(defineTool({
        name: 'host_probe',
        description: 'Fixture tool that models a host-only operation.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'host fixture' },
      }))
      ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Fixture Bash operation.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'bash fixture' },
      }))
      ctx.tools.register(defineTool({
        name: 'read_image',
        description: 'Fixture image read in the workspace.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'image fixture' },
      }))
      ctx.tools.register({ ...defineTool({
        name: 'configured_mcp',
        description: 'Fixture tool with an approved MCP source.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute() { return 'mcp fixture' },
      }), source: { kind: 'mcp', serverName: 'fixture' } })

      const options = { provider: 'fixture', model: 'fixture' }
      const bot = await ctx.agentLoop.create(BOT_SESSION, options)
      const desktop = await ctx.agentLoop.create(DESKTOP_SESSION, options)
      const legacy = await ctx.agentLoop.create(LEGACY_SESSION, options)
      composedPreset.mockReturnValue('minimal')
      const regular = await ctx.agentLoop.create(regularSession, options)
      const execution = managedBotExecutionFor({ agent: bot })
      if (execution === undefined) throw new Error('managed Bot execution was not bound')
      expect(execution.workspaceRoot).toBe('/yharness-test-bots/' + BOT_SESSION)
      expect(execution.sandboxPolicy.resolve().mode).toBe('workspace-write')
      const workspaces = ctx.get('botWorkspaces')
      if (workspaces === undefined) throw new Error('The managed workspace provider is missing')
      expect(workspaces.workspace(BOT_SESSION)).toBe(execution.workspaceRoot)
      expect(workspaces.managed?.('bot-desktop')).toBe(false)
      await workspaces.prepare?.(BOT_SESSION)
      expect(ensure).toHaveBeenCalledWith(BOT_SESSION)
      const shell = await execution.shell.execute(execution.shell.resolve({ command: 'printf managed-shell' }))
      await expect(shell.result()).resolves.toMatchObject({ exitCode: 0, stdout: { text: 'managed-shell' } })
      expect(argv).toHaveBeenCalledWith(BOT_SESSION, ['bash', '-c', 'printf managed-shell'], {
        workdir: execution.workspaceRoot, stdin: false,
      })
      expect(managedBotExecutionFor({ agent: regular })).toBeUndefined()
      expect(managedBotExecutionFor({ agent: legacy })).toBeUndefined()
      expect(managedBotExecutionFor({ agent: desktop })).toBeUndefined()
      const desktopPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: desktop }))
      expect(desktopPrompt).toContain('Bash and file tools use your existing Session workspace and permissions.')
      expect(desktopPrompt).not.toContain('managed runtime workspace')
      const managedPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: bot }))
      expect(managedPrompt).toContain('You have your own computer on the VPS with a managed runtime workspace.')
      expect(ctx.tools.get('vps_computer', bot)).toBeDefined()
      expect(ctx.tools.get('vps_computer', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_computer', regular)).toBeUndefined()
      expect(ctx.tools.get('vps_computer', legacy) !== undefined).toBe(withLegacy)
      expect(ctx.tools.get('vps_service_journal', bot) !== undefined).toBe(withLegacy)
      expect(ctx.tools.get('vps_service_journal', desktop) !== undefined).toBe(withLegacy)
      expect(ctx.tools.get('vps_service_journal', legacy)).toBeUndefined()
      expect(ctx.tools.get('vps_service_journal', regular)).toBeUndefined()
      await expect((await request('status', { sessionId: BOT_SESSION })).json()).resolves.toMatchObject({
        available: true, computer: { id: 'bot-test', permissionScope: 'bot' },
      })
      await expect((await request('status', { sessionId: DESKTOP_SESSION })).json()).resolves.toMatchObject({
        available: true, computer: { id: 'bot-desktop', permissionScope: 'bot' },
      })
      const legacyStatus = withLegacy
        ? { available: true, computer: { id: 'shared-vps', permissionScope: 'workspace' } }
        : { available: false }
      await expect((await request('status', { sessionId: LEGACY_SESSION })).json()).resolves.toMatchObject(legacyStatus)
      await expect((await request('status', {})).json()).resolves.toMatchObject(legacyStatus)
      await expect((await request('status', { sessionId: regular.id })).json()).resolves.toMatchObject({ available: false })
      await expect((await request('frame', {
        sessionId: DESKTOP_SESSION, viewerId: '11111111-1111-4111-8111-111111111111',
      })).json()).resolves.toMatchObject({ jpeg: FIXTURE_JPEG })

      const call = { signal: new AbortController().signal, name: 'host_probe', arguments: {} }
      await expect.soft(ctx.tools.execute({ ...call, name: 'read_image', callId: ToolCallId('managed-image'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
      await expect.soft(ctx.tools.execute({ ...call, name: 'vps_service_status', callId: ToolCallId('desktop-service-list'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      expect(ctx.tools.get('vps_service_status', regular)).toBeUndefined()
      if (withLegacy) {
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
      }
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('bot-call'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('desktop-call'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('regular-call'), agent: regular }))
        .resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('host-call') }))
        .resolves.toMatchObject({ isError: false })
      regularIsManaged = true
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('unbound-bot-call'), agent: regular }))
        .resolves.toMatchObject({ isError: true })
      regularIsManaged = false
      await expect(ctx.tools.execute({ ...call, name: 'configured_mcp', callId: ToolCallId('mcp-call'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
      const computerCall = { ...call, name: 'vps_computer', arguments: { action: 'text', text: 'fixture' } }
      await expect(ctx.tools.execute({ ...computerCall, callId: ToolCallId('managed-input'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
      await expect(ctx.tools.execute({ ...computerCall, callId: ToolCallId('desktop-input'), agent: desktop }))
        .resolves.toMatchObject({ isError: false })
      ctx.tools.register(defineTool({
        name: 'check_computer_scope',
        description: 'Test whether a captured Computer tool accepts another Agent.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
        async execute(_args, context) {
          for (const owner of [bot, desktop]) {
            const tool = ctx.tools.get('vps_computer', owner)
            if (tool === undefined) throw new Error('The scoped Computer tool is missing')
            await expect(tool.execute(computerCall.arguments, context)).rejects.toThrow('VPS Computer requires the owning Bot Session.')
          }
          return 'scope checked'
        },
      }))
      await expect(ctx.tools.execute({ ...call, name: 'check_computer_scope', callId: ToolCallId('foreign-computer'), agent: regular }))
        .resolves.toMatchObject({ isError: false })
      if (withLegacy) {
        await expect(ctx.tools.execute({ ...call, callId: ToolCallId('legacy-ordinary-call'), agent: legacy }))
          .resolves.toMatchObject({ isError: false })
        await expect(ctx.tools.execute({ ...computerCall, callId: ToolCallId('legacy-input-denied'), agent: legacy }))
          .resolves.toMatchObject({ isError: true })
        composedPreset.mockReturnValue('standard')
        await expect(ctx.tools.execute({ ...computerCall, callId: ToolCallId('legacy-input'), agent: legacy }))
          .resolves.toMatchObject({ isError: false })
      }
      setSandboxMode(bot.session, 'read-only')
      await expect(ctx.tools.execute({ ...call, name: 'bash', callId: ToolCallId('read-only-bash'), agent: bot }))
        .resolves.toMatchObject({ isError: true })
      setSandboxMode(bot.session, 'workspace-write')
      await expect(ctx.tools.execute({ ...call, name: 'bash', callId: ToolCallId('managed-bash'), agent: bot }))
        .resolves.toMatchObject({ isError: false })
    } finally {
      ensure.mockRestore()
      argv.mockRestore()
      readJournal.mockRestore()
      await ctx.fiber.dispose()
      await legacyComputer?.dispose()
    }
  })
})
