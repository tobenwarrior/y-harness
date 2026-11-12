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
import { botComputerRoutes } from './computer-api.ts'
import { applyVpsBotComputer } from './computer-tool.ts'
import { VpsRuntime } from './vps-runtime.ts'
import { registerVpsServiceTools, VpsServices, type VpsServiceAccess } from './vps-services.ts'

const exec = promisify(execFile)
const BOT_TOOLS = new Set([
  'bash', 'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'job_output', 'job_list', 'job_kill',
  'vps_computer', 'vps_service_status', 'vps_service_restart', 'skill', 'search_skills',
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
 * @param config - Installer-assigned runtime root and local desktop image.
 * @param grants - Exact operator-configured systemd grants.
 */
export function mountVpsBots(
  ctx: Context,
  config: { readonly root: string; readonly image: string },
  grants: readonly VpsServiceAccess[],
): void {
  const runtime = new VpsRuntime(config.root, config.image)
  const services = new VpsServices(grants)
  const computers = new Map<string, VpsComputer>()
  ctx.provide('botWorkspaces', {
    workspace: sessionId => runtime.workspace(sessionId),
    prepare: sessionId => runtime.ensure(sessionId),
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
    for (const route of botComputerRoutes(async (sessionId) => {
      const bot = await scope.bots.ownerBotForSession(sessionId)
      if (bot?.state !== 'active') return undefined
      return computerFor(bot.sessionId)
    })) {
      scope.effect(() => scope.connection.fetch.register(route), 'vps-bots: owner desktop route')
    }
  })

  ctx.inject(['bots'], (scope) => {
    scope.on('tools/pre-execute', async (call, next) => {
      if (call.agent !== undefined && managedBotExecutionFor(call) === undefined
        && await scope.bots.ownerBotForSession(call.agent.id) !== undefined) {
        return { kind: 'deny', reason: 'The Bot’s VPS environment could not be bound to this Session.' }
      }
      return next()
    }, { prepend: true })
    scope.on('agent/created', async ({ agent }) => {
      const bot = await scope.bots.ownerBotForSession(agent.id)
      if (bot === undefined) return
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
        applyVpsBotComputer(agentCtx, async (sessionId) => {
          if (sessionId !== bot.sessionId) throw new Error('VPS Computer requires the owning Bot Session.')
          return computerFor(sessionId)
        })
        registerVpsServiceTools(agentCtx, bot.id, services)
      })
    })
  })
}
