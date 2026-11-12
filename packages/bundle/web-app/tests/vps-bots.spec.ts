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
import { describe, expect, it, vi } from 'vitest'
import { mountVpsBots } from '../src/vps-bots.ts'
import { VpsJournal } from '../src/vps-journal.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const BOT_SESSION = SessionId('bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76')
const DESKTOP_SESSION = SessionId('bot-session-5f3ec8e4-4c34-4ec6-a38f-aad6d07cb337')
const LEGACY_SESSION = SessionId('bot-session-37888424-5b3d-4a8c-81f5-751ed2d24f95')

describe('managed VPS Bot composition', () => {
  it('rejects desktop-only Bots outside the selected Bot allowlist', () => {
    expect(() => mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-selected'], desktopOnlyBots: ['bot-other'],
    }, [])).toThrow('Desktop-only VPS Bots must be selected by botComputers.bots.')
  })

  it('limits browser access to Bots with private Computers', () => {
    expect(() => mountVpsBots(new Context(), {
      root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-private'],
      browser: { bots: ['bot-shared-desktop'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
    }, [])).toThrow('VPS browser access must select private Computer Bots.')
  })

  it('prepares the browser runtime only for the selected Bot', async () => {
    const ctx = new Context()
    const ensure = vi.spyOn(VpsRuntime.prototype, 'ensure').mockResolvedValue(undefined)
    try {
      await ctx.plugin(scope => mountVpsBots(scope, {
        root: '/yharness-test-bots', image: 'localhost/yharness-test',
        browser: { bots: ['bot-browser'], image: 'localhost/yharness-browser', seccompProfile: '/yharness-browser.json' },
      }, []))
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
          return undefined
        },
      } as never)
      await ctx.plugin((scope) => {
        mountVpsBots(scope, {
          root: '/yharness-test-bots', image: 'localhost/yharness-test', bots: ['bot-test', 'bot-desktop'],
          desktopOnlyBots: ['bot-desktop'],
        }, [], undefined, {
          socketPath: '/run/yharness-test.sock', bots: ['bot-test', 'bot-desktop'],
        })
      })
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
      const desktopPrompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: desktop }))
      expect(desktopPrompt).toContain('Bash and file tools use your existing Session workspace and permissions.')
      expect(desktopPrompt).not.toContain('managed runtime workspace')
      expect(ctx.tools.get('vps_computer', bot)).toBeDefined()
      expect(ctx.tools.get('vps_computer', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_computer', regular)).toBeUndefined()
      expect(ctx.tools.get('vps_service_journal', bot)).toBeDefined()
      expect(ctx.tools.get('vps_service_journal', desktop)).toBeDefined()
      expect(ctx.tools.get('vps_service_journal', legacy)).toBeUndefined()
      expect(ctx.tools.get('vps_service_journal', regular)).toBeUndefined()

      const call = { signal: new AbortController().signal, name: 'host_probe', arguments: {} }
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
      await ctx.fiber.dispose()
    }
  })
})
