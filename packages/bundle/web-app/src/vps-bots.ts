/** Assign each owner Bot on a configured VPS its own shell, files and desktop. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@yharness/cordis'
import { LocalBashExecutor } from '@yharness/bash-local'
import { bindManagedBotExecution, createManagedBotExecution, managedBotExecutionFor } from '@yharness/sandbox-policy'
import { VpsBotSubprocess } from './vps-bot-process.ts'
import { VpsBotFileSystem } from './vps-bot-files.ts'
import type {} from '@yharness/bots'
import type {} from '@yharness/client-connection'
import type {} from '@yharness/system-prompt'
import { containerComputer, type VpsComputer } from './computer.ts'
import * as ComputerTool from './computer-tool.ts'
import { botComputerRoutesWithLegacy } from './computer-api.ts'
import { VpsRuntime } from './vps-runtime.ts'
import { registerVpsServiceTools, VpsServices, type VpsServiceAccess } from './vps-services.ts'
import { registerVpsJournalTool, VpsJournal, type VpsJournalConfig } from './vps-journal.ts'

const exec = promisify(execFile)
const BOT_TOOLS = new Set([
  'bash', 'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'job_output', 'job_list', 'job_kill',
  'vps_computer', 'vps_service_status', 'vps_service_restart', 'vps_service_journal', 'skill', 'search_skills',
  'schedule_create', 'schedule_list', 'schedule_delete', 'schedule_update', 'schedule_pause', 'schedule_resume', 'schedule_history',
  'schedule_event_create', 'schedule_event_list', 'schedule_event_delete', 'schedule_event_update',
  'schedule_event_pause', 'schedule_event_resume', 'schedule_event_history',
  'ask_user_question', 'todo_write', 'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'web_search',
  'read_own_grok_history', 'list_bots', 'inspect_bot', 'send_bot_message', 'create_bot', 'edit_bot_profile',
  'list_bot_memory', 'remember_bot_memory', 'forget_bot_memory', 'list_connected_apps',
  'list_bot_groups', 'inspect_bot_group', 'create_bot_group', 'update_bot_group', 'send_bot_group_message',
])

/**
 * Mount managed Linux computers in the shipped VPS Web profile.
 * @param ctx - Web Host composition.
 * @param config - Installer-assigned runtime root, local desktop image, and Bot Computer selection.
 * @param grants - Exact operator-configured systemd grants.
 * @param legacyComputer - Existing shared controller used by Bots outside the allowlist.
 * @param journalConfig - Private socket and authorized Computer Bots.
 */
export function mountVpsBots(
  ctx: Context,
  config: {
    readonly root: string
    readonly image: string
    readonly bots?: readonly string[]
    readonly desktopOnlyBots?: readonly string[]
  },
  grants: readonly VpsServiceAccess[],
  legacyComputer?: VpsComputer,
  journalConfig?: VpsJournalConfig,
): void {
  const runtime = new VpsRuntime(config.root, config.image)
  const services = new VpsServices(grants)
  const computers = new Map<string, VpsComputer>()
  const managedBotIds = config.bots === undefined ? undefined : new Set(config.bots)
  const desktopOnlyBotIds = new Set(config.desktopOnlyBots ?? [])
  const isManagedBot = (botId: string): boolean => !desktopOnlyBotIds.has(botId)
    && (managedBotIds === undefined || managedBotIds.has(botId))
  if (managedBotIds !== undefined && [...desktopOnlyBotIds].some(botId => !managedBotIds.has(botId))) {
    throw new Error('Desktop-only VPS Bots must be selected by botComputers.bots.')
  }
  const isDesktopBot = (botId: string): boolean => isManagedBot(botId) || desktopOnlyBotIds.has(botId)
  if (journalConfig?.bots.some(botId => !isDesktopBot(botId))) {
    throw new Error('VPS journal grants must select Computer Bots.')
  }
  const journal = journalConfig === undefined ? undefined : new VpsJournal(journalConfig)
  if (journal !== undefined) {
    ctx.provide('botVpsJournal', {
      forBot: botId => journal.authorized(botId) ? signal => journal.read(botId, signal) : undefined,
    })
  }
  ctx.provide('botWorkspaces', {
    workspace: sessionId => runtime.workspace(sessionId),
    prepare: sessionId => runtime.ensure(sessionId),
    managed: (botId: string) => isManagedBot(botId),
  })
  ctx.effect(() => async () => {
    const active = [...computers.values()]
    computers.clear()
    await Promise.all(active.map(computer => computer.dispose()))
  }, 'vps-bots: dispose desktop controllers')

  const computerFor = async (sessionId: string): Promise<VpsComputer> => {
    await runtime.ensure(sessionId)
    const existing = computers.get(sessionId)
    if (existing !== undefined) return existing
    const computer = containerComputer(async (argv, signal) => {
      signal.throwIfAborted()
      const [program, ...args] = runtime.execArgv(sessionId, argv)
      const { stdout } = await exec(program, args, {
        encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 12_000, signal,
      })
      return stdout
    })
    computers.set(sessionId, computer)
    return computer
  }

  ctx.inject(['bots', 'connection'], (scope) => {
    for (const route of botComputerRoutesWithLegacy(async (sessionId) => {
      // Only an explicit allowlist rollout retains the old omitted-session
      // request as the shared legacy display. Fresh managed installations
      // require a Bot Session and fail closed in the route parser.
      if (sessionId === '' && managedBotIds !== undefined) {
        return legacyComputer === undefined
          ? undefined
          : { computer: legacyComputer, id: 'shared-vps', permissionScope: 'workspace' as const }
      }
      const bot = await scope.bots.ownerBotForSession(sessionId)
      if (bot?.state !== 'active') return undefined
      if (isDesktopBot(bot.id)) {
        return {
          computer: await computerFor(bot.sessionId),
          id: bot.id,
          permissionScope: 'bot' as const,
        }
      }
      if (legacyComputer === undefined) return undefined
      return { computer: legacyComputer, id: 'shared-vps', permissionScope: 'workspace' as const }
    }, { allowMissingSession: managedBotIds !== undefined })) {
      scope.effect(() => scope.connection.fetch.register(route), 'vps-bots: owner desktop route')
    }
  })

  ctx.inject(['bots'], (scope) => {
    scope.on('tools/pre-execute', async (call, next) => {
      const bot = call.agent === undefined ? undefined : await scope.bots.ownerBotForSession(call.agent.id)
      if (bot !== undefined && isManagedBot(bot.id) && managedBotExecutionFor(call) === undefined) {
        return { kind: 'deny', reason: 'The Bot’s VPS environment could not be bound to this Session.' }
      }
      return next()
    }, { prepend: true })
    scope.on('agent/created', async ({ agent }) => {
      const bot = await scope.bots.ownerBotForSession(agent.id)
      if (bot === undefined || !isDesktopBot(bot.id)) {
        if (managedBotIds === undefined || legacyComputer === undefined) return
        const canUseComputer = (): boolean => {
          const preset = ctx.get('agentPresets')?.composedPreset(agent.ctx)
          return preset !== undefined && /^(?:standard|cordis|ptc)$/u.test(preset)
        }
        if (!canUseComputer()) return
        await agent.ctx.inject(ComputerTool.inject, (agentCtx) => {
          ComputerTool.apply(agentCtx)
          agentCtx.effect(() => agentCtx.tools.guard(exec => exec.name === 'vps_computer' && !canUseComputer()
            ? 'This Agent preset cannot access the private Computer.'
            : undefined), 'vps-bots: preserve legacy Computer guard')
        })
        return
      }
      if (!isManagedBot(bot.id)) {
        await agent.ctx.inject(['tools', 'attachments', 'llm', 'systemPrompt'], (agentCtx) => {
          agentCtx.systemPrompt.section({
            name: 'app:vps-bot-desktop',
            order: agentCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
            text: () => 'Use vps_computer for visual interaction on your private VPS desktop. '
              + 'Bash and file tools use your existing Session workspace and permissions.',
          })
          ComputerTool.applyVpsBotComputer(agentCtx, async (sessionId) => {
            if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
            return computerFor(sessionId)
          })
          registerVpsServiceTools(agentCtx, bot.id, services)
          if (journal !== undefined) registerVpsJournalTool(agentCtx, bot.id, bot.sessionId, journal, agent.ctx)
        })
        return
      }
      await agent.ctx.inject(['tools', 'attachments', 'llm', 'systemPrompt', 'subprocess', 'sandboxPolicy'], async (agentCtx) => {
        const workspace = runtime.workspace(bot.sessionId)
        const managedContext = agentCtx.isolate('fs').isolate('subprocess').isolate('shell')
        const subprocess = new VpsBotSubprocess(managedContext, {
          runtime, sessionId: bot.sessionId, host: agentCtx.subprocess,
        })
        const fs = new VpsBotFileSystem(managedContext, runtime, bot.sessionId)
        const shell = new LocalBashExecutor(managedContext, LocalBashExecutor.Config({ cwd: workspace, timeoutMs: 60_000 }))
        const policy = agentCtx.sandboxPolicy
        const execution = createManagedBotExecution({
          // The capability is looked up against the exact agent context used by
          // tool execution. Providers remain isolated in `managedContext`.
          context: agent.ctx,
          workspaceRoot: workspace,
          shell,
          fs,
          subprocess,
          sandboxPolicy: {
            defaultMode: 'workspace-write',
            resolve: (request) => {
              const standing = policy.resolve(request)
              return { ...standing, workspaceRoot: workspace, mode: standing.mode === 'read-only' ? 'read-only' : 'workspace-write' }
            },
          },
          shellEnv: {},
        })
        agentCtx.effect(() => bindManagedBotExecution(agent.ctx, execution), 'vps-bots: bind execution')
        agentCtx.on('tools/pre-execute', async (call, next) => {
          if (call.name === 'bash' || call.name === 'grep' || call.name === 'glob') {
            if (call.name === 'bash' && execution.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') {
              return { kind: 'deny', reason: 'This Bot Session is read-only.' }
            }
            await runtime.ensure(bot.sessionId)
          }
          return next()
        }, { prepend: true })
        agentCtx.effect(() => agentCtx.tools.presentAs('native'), 'vps-bots: native tool dispatch')
        agentCtx.effect(() => agentCtx.tools.guard((call) => {
          if (BOT_TOOLS.has(call.name)) return undefined
          const source = agentCtx.tools.get(call.name, agent)?.source
          if (source?.kind === 'mcp' || source?.kind === 'mcp-resource') return undefined
          return 'This tool is unavailable inside the Bot’s VPS environment.'
        }), 'vps-bots: protect the host from Bot tools')
        agentCtx.systemPrompt.section({
          name: 'app:vps-bot',
          order: agentCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
          text: () => 'You have your own computer on the VPS with a managed runtime workspace. '
            + 'Use Bash, file tools and vps_computer there; do not use the Chat session cwd. '
            + 'Host service access requires a separate grant. Mac permissions do not apply here.',
        })
        ComputerTool.applyVpsBotComputer(agentCtx, async (sessionId) => {
          if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
          return computerFor(sessionId)
        })
        registerVpsServiceTools(agentCtx, bot.id, services)
        if (journal !== undefined) registerVpsJournalTool(agentCtx, bot.id, bot.sessionId, journal, agent.ctx)
      })
    })
  })
}
