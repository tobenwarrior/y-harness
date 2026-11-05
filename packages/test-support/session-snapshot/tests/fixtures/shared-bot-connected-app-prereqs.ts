/** Seed a shared Bot Session with a granted deterministic MCP app tool. */

import type { Context } from '@yharness/cordis'
import type { Agent, AgentHandle } from '@yharness/agent'
import { SharedAccessAuthority } from '@yharness/client-connection'
import type { SessionCreateRequest } from '@yharness/api-session-controller'
import { createUserMessage } from '@yharness/llm'
import { basename } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { SessionId } from '@yharness/session'
import { defineTool, type ToolDefinition } from '@yharness/tools'
import { BotId } from '@yharness/bots/types'
import { BotPrincipalId } from '@yharness/bots/src/sharing.ts'
import {
  BotService,
  SHARED_BOT_AGENT_PRESET,
  sharedBotWorkingDirectory,
  type SharedBotHost,
} from '@yharness/bots'
import { botDomain, sharedMembershipSnapshotSchema, sharedPrivateSessionSchema } from '@yharness/bots/src/storage.ts'
import { z } from 'zod'

export const name = 'snapshot-shared-bot-connected-app-prereqs'
export const inject = ['agentDefaultModel', 'agents', 'credentials', 'sessions', 'storageDomain', 'tools', 'web']

const sharedPrivateSessionSnapshotSchema = z.object({
  version: z.literal(1),
  bindings: z.array(sharedPrivateSessionSchema),
}).strict()

/**
 * Reflect the production shared host used by the Bot service.
 * @param service - the mounted Bot service.
 * @returns The service's shared-session host.
 */
function productionSharedHost(service: BotService): SharedBotHost {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), 'sharedHost')
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error('snapshot shared Bot host is unavailable')
  }
  const method = descriptor.value as (this: BotService) => SharedBotHost
  return method.call(service)
}

/** Seed only the owner Agent and Bot rows needed by this standalone scenario. */
async function seedSharedBotPrerequisites(ctx: Context): Promise<void> {
  const cwd = process.cwd()
  const selection = ctx.agentDefaultModel.currentSelection()
  const handle = await ctx.agents.create({
    sessionId: SessionId('bot-session-sender'),
    meta: { cwd },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  const domain = await ctx.storageDomain.open(botDomain)
  const bots = domain.table('bots')
  await bots.put(BotId('bot-sender'), {
    id: BotId('bot-sender'),
    sessionId: SessionId('bot-session-sender'),
    ownerId: 'local-owner',
    name: 'Chief of Staff',
    description: 'Coordinates the work with peer Bots.',
    persona: 'Keep internal release guidance private to the operator Bot.',
    capabilities: ['planning', 'coordination'],
    identity: 'agent',
    accent: 'violet',
    cwd,
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
  })
  await bots.put(BotId('bot-grok'), {
    id: BotId('bot-grok'),
    sessionId: SessionId('bot-session-target'),
    ownerId: 'local-owner',
    name: 'Grok Bot',
    description: 'Researches a request and reports concise findings.',
    identity: 'browse',
    accent: 'blue',
    hidden: true,
    cwd,
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
  })
  await domain.close()
  ctx.provide('snapshotBotAgents', [handle] as never)
  ctx.provide('sessionController', {
    create: async (request: SessionCreateRequest, signal: AbortSignal) => {
      signal.throwIfAborted()
      return { sessionId: request.sessionId }
    },
    inspect: async (sessionId: SessionId) => ({
      meta: ctx.sessions.get(sessionId)?.header,
      events: [],
    }),
    resolveAgent: async (sessionId: SessionId) => {
      const agent = ctx.agents.get(sessionId)
      return agent === undefined ? { error: new Error(`snapshot Session "${String(sessionId)}" is not live`) } : { agent }
    },
  } as never)
}

/**
 * Install a controller seam that creates a real Agent while avoiding the Web-only
 * Session Controller bundle in this headless snapshot.
 * @param ctx - snapshot composition context.
 * @returns A disposer for the setup-owned shared Agent handles.
 */
function installSnapshotSessionController(ctx: Context): () => Promise<void> {
  const handles: AgentHandle[] = []
  const controller = ctx.get('sessionController', false) as {
    create: (request: SessionCreateRequest, signal: AbortSignal) => Promise<unknown>
    inspect: (sessionId: SessionId) => Promise<unknown>
    resolveAgent?: (sessionId: SessionId) => Promise<unknown>
  } | undefined
  if (controller === undefined) throw new Error('snapshot Bot prerequisites did not provide sessionController')
  controller.create = async (request: SessionCreateRequest, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (request.sessionId === undefined || request.cwd === undefined) {
      throw new Error('shared Bot snapshot Session requests must include an id and cwd')
    }
    const selection = ctx.agentDefaultModel.currentSelection()
    const cwd = request.cwd
    const handle = await ctx.agents.create({
      sessionId: request.sessionId,
      meta: { cwd: request.cwd, ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }) },
      agentOptions: { provider: selection.provider, model: selection.model },
      ...(request.agentPreset === SHARED_BOT_AGENT_PRESET
        ? { setup: async (agentCtx: Context) => {
          agentCtx.systemPrompt.variable('provider', () => selection.provider)
          agentCtx.systemPrompt.variable('model', () => selection.model)
          agentCtx.systemPrompt.variable('cwd', () => cwd)
          await agentCtx.inject(['tools', 'systemPrompt'], (scope) => {
            scope.systemPrompt.section({
              name: 'deployment:persona-prefix',
              order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
              text: 'You are a shared Y Harness Bot. Answer the collaborator in this private Bot session.',
            })
            scope.systemPrompt.suppressRuntimeContext()
          })
        } }
        : {}),
    })
    handles.push(handle)
    return { sessionId: handle.agent.id, agentPreset: request.agentPreset }
  }
  controller.inspect = async (sessionId: SessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error(`snapshot Session "${String(sessionId)}" is not live`)
    return {
      meta: session.header,
      inheritedEventCount: session.inheritedEventCount,
      events: [],
    }
  }
  controller.resolveAgent = async (sessionId: SessionId) => {
    const agent = ctx.agents.get(sessionId)
    return agent === undefined ? { error: new Error(`snapshot Session "${String(sessionId)}" is not live`) } : { agent }
  }
  return async () => {
    await Promise.all(handles.map(handle => handle.dispose()))
  }
}

/** Persist the exact principal membership and private-session binding used by the test Session. */
async function bindSharedSession(
  ctx: Context,
  botId: BotId,
  sessionId: SessionId,
): Promise<string> {
  const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
    sessionMaxAgeMs: 60_000,
    inviteMaxAgeMs: 60_000,
  })
  try {
    const owner = await authority.enrollOwner({ headers: { host: '127.0.0.1:3080' } })
    const principalId = BotPrincipalId(String(owner.principalId))
    await authority.mutateExtension('agent-bots/shared-memberships', (current) => {
      const snapshot = current === undefined
        ? { version: 1 as const, memberships: [] }
        : sharedMembershipSnapshotSchema.parse(current)
      const membership = {
        botId,
        principalId,
        role: 'owner' as const,
        grantedBy: principalId,
        createdAt: 1,
        updatedAt: 1,
      }
      return {
        value: undefined,
        next: {
          ...snapshot,
          memberships: [
            ...snapshot.memberships.filter(candidate => !(candidate.botId === botId && candidate.principalId === principalId)),
            membership,
          ],
        },
      }
    })
    await authority.mutateExtension('agent-bots/shared-private-sessions', (current) => {
      const snapshot = current === undefined
        ? { version: 1 as const, bindings: [] }
        : sharedPrivateSessionSnapshotSchema.parse(current)
      const binding = {
        botId,
        principalId,
        sessionId,
        createdAt: 1,
        updatedAt: 1,
      }
      return {
        value: undefined,
        next: {
          ...snapshot,
          bindings: [
            ...snapshot.bindings.filter(candidate => !(candidate.botId === botId && candidate.sessionId === sessionId)),
            binding,
          ],
        },
      }
    })
    return String(principalId)
  } finally {
    await authority.dispose()
  }
}

function mcpFixtureTool(name: string, execute: () => Promise<string>): ToolDefinition {
  return {
    ...defineTool({
      name,
      description: 'Return the deterministic result from the granted fixture MCP app.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute,
    }),
    source: { kind: 'mcp', serverName: 'fixture' },
  }
}

/** Install the fixture app and admit one shared Agent before the runner's turn. */
export async function apply(ctx: Context): Promise<void> {
  await seedSharedBotPrerequisites(ctx)
  let appCalled = false
  ctx.tools.register(mcpFixtureTool('mcp__fixture__lookup', async () => {
    appCalled = true
    return 'Owner-allowed connected app result.'
  }))
  const dispose = installSnapshotSessionController(ctx)
  let testSharedCwd: string | undefined
  ctx.effect(() => async () => {
    await dispose()
    if (testSharedCwd !== undefined) await rm(testSharedCwd, { recursive: true, force: true })
  }, 'snapshot shared Bot handles')

  let admitted = false
  let shared: Pick<Agent, 'followup' | 'whenIdle'> | undefined
  let sharedDriven = false
  ctx.on('agent/created', async ({ agent }) => {
    if (admitted || String(agent.id) !== 'bot-session-sender') return
    admitted = true
    const bots = ctx.get('bots')
    if (bots === undefined) throw new Error('snapshot Bot service is unavailable')
    const host = productionSharedHost(bots)
    const bot = (await host.listBots()).find(candidate => String(candidate.id) === 'bot-grok')
    if (bot === undefined) throw new Error('snapshot shared Bot record is missing')
    const sharedSessionId = SessionId(decodeURIComponent(basename(process.cwd())))
    const cwd = sharedBotWorkingDirectory(sharedSessionId)
    await mkdir(cwd, { mode: 0o700 })
    testSharedCwd = cwd
    const principalId = await bindSharedSession(ctx, bot.id, sharedSessionId)
    const before = await bots.listSharedAppAccess({ botId: bot.id })
    await bots.setSharedAppAccess({
      botId: bot.id,
      appId: 'fixture',
      allowed: true,
      expectedRevision: before.revision,
    })
    const created = await host.createPrivateSession(
      bot,
      sharedSessionId,
      principalId,
      new AbortController().signal,
    )
    if (created === undefined) throw new Error('snapshot shared Bot Session was not returned')
    shared = ctx.agents.get(created.id)
    if (shared === undefined) throw new Error('snapshot shared Bot Agent is unavailable')
  })
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (sharedDriven || String(options.sessionId) !== 'bot-session-sender') return stream
    return (async function* () {
      yield* stream
      if (sharedDriven) return
      const current = shared
      if (current === undefined) throw new Error('snapshot shared Bot Session was not admitted')
      sharedDriven = true
      await ctx.agents.withoutInitiator(async () => {
        current.followup(createUserMessage({
          content: [{ type: 'text', text: 'Use the granted connected app and report its result.' }],
          source: { kind: 'user' },
        }))
        await current.whenIdle()
      })
      if (!appCalled) throw new Error('snapshot shared Bot did not execute the granted connected app')
    })()
  })
}
