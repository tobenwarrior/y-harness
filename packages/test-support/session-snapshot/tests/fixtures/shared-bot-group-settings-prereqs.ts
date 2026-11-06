/** Seed a shared Bot group, rename it through the shared settings route, and deliver one message. */

import type { Context } from '@yharness/cordis'
import type { AgentHandle } from '@yharness/agent'
import { ApiSessionNotFound, type SessionCreateRequest } from '@yharness/api-session-controller'
import { SharedAccessAuthority } from '@yharness/client-connection'
import type { PeerScope } from '@yharness/typert-protocol'
import { SessionId } from '@yharness/session'
import { BotGroupId, BotGroupMessageId } from '@yharness/bots/src/group-chat.ts'
import { BotId } from '@yharness/bots/types'
import { BotService, SHARED_BOT_AGENT_PRESET, SharedBotService } from '@yharness/bots'
import type { SharedBotService as SharedBotServiceType } from '@yharness/bots'
import { botDomain } from '@yharness/bots/src/storage.ts'

export const name = 'snapshot-shared-bot-group-settings-prereqs'
export const inject = ['agentDefaultModel', 'agents', 'credentials', 'sessions', 'storageDomain']

const GROUP_ID = BotGroupId('bot-group-settings')
const TARGET_BOT_ID = BotId('bot-grok')
const GROUP_MESSAGE_ID = BotGroupMessageId('bot-group-message-settings')
const GROUP_REPLY_MESSAGE_ID = BotGroupMessageId('bot-group-message-settings-reply')
const RENAMED_GROUP = 'Renamed planning room'

interface SharedGroupDriver {
  readonly peer: PeerScope
  readonly service: SharedBotServiceType
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the private shared service mounted by the production Bot service. */
function productionSharedService(service: BotService): SharedBotServiceType {
  const descriptor = Object.getOwnPropertyDescriptor(service, 'sharedService')
  const value = descriptor?.value as SharedBotServiceType | undefined
  if (!(value instanceof SharedBotService)) throw new Error('snapshot shared Bot service is unavailable')
  return value
}

/** Read the authority used by the production shared service. */
function productionSharedAuthority(service: SharedBotServiceType): SharedAccessAuthority {
  const descriptor = Object.getOwnPropertyDescriptor(service, 'authority')
  const value = descriptor?.value as SharedAccessAuthority | undefined
  if (!(value instanceof SharedAccessAuthority)) throw new Error('snapshot shared Bot authority is unavailable')
  return value
}

function cookieOf(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? setCookie
}

function groupIdOf(value: unknown): BotGroupId {
  if (!isRecord(value) || !isRecord(value.group) || typeof value.group.id !== 'string') {
    throw new Error('shared group creation did not return a group id')
  }
  return BotGroupId(value.group.id)
}

function updatedAtOf(value: unknown): number {
  if (!isRecord(value) || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt)) {
    throw new Error('shared group settings did not return an updatedAt revision')
  }
  return value.updatedAt
}

function settingsNameOf(value: unknown): string {
  if (!isRecord(value) || value.name !== RENAMED_GROUP) {
    throw new Error('shared group settings did not preserve the renamed room')
  }
  return value.name
}

/** Confirm that the reply route retained the parent message identity. */
function assertPersistedReply(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error('shared group inspection did not return messages')
  }
  let reply: Record<string, unknown> | undefined
  for (const candidate of value.messages) {
    if (isRecord(candidate) && candidate.id === GROUP_REPLY_MESSAGE_ID) {
      reply = candidate
      break
    }
  }
  if (!isRecord(reply) || reply.replyToMessageId !== GROUP_MESSAGE_ID) {
    throw new Error('shared group reply did not retain its quoted parent')
  }
}

/** Seed the owner Bot and the hidden peer Bot needed by this standalone scenario. */
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
  await bots.put(TARGET_BOT_ID, {
    id: TARGET_BOT_ID,
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
    inspect: async (sessionId: SessionId) => {
      const session = ctx.sessions.get(sessionId)
      if (session === undefined) throw new ApiSessionNotFound(`snapshot Session "${String(sessionId)}" is not live`)
      return { meta: session.header, events: [] }
    },
    resolveAgent: async (sessionId: SessionId) => {
      const agent = ctx.agents.get(sessionId)
      return agent === undefined ? { error: new Error(`snapshot Session "${String(sessionId)}" is not live`) } : { agent }
    },
  } as never)
}

/** Install the headless controller seam that creates isolated shared-group Agents. */
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
    if (session === undefined) throw new ApiSessionNotFound(`snapshot Session "${String(sessionId)}" is not live`)
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

/** Create and rename the shared room before the first message is dispatched. */
async function createRenamedGroup(ctx: Context): Promise<SharedGroupDriver> {
  const bots = ctx.get('bots')
  if (bots === undefined) throw new Error('snapshot Bot service is unavailable')
  const service = productionSharedService(bots)
  const authority = productionSharedAuthority(service)
  const enrollment = await service.enrollOwner({ headers: { host: '127.0.0.1:3080' } })
  const admitted = await authority.admit({
    headers: { host: '127.0.0.1:3080', cookie: cookieOf(enrollment.setCookie) },
  })
  if (!('peer' in admitted)) throw new Error('snapshot shared Bot owner peer was not admitted')
  const signal = new AbortController().signal
  const created = await service.handle('bots/share/create-group', {
    id: GROUP_ID,
    name: 'Draft planning room',
    botIds: [BotId('bot-sender'), TARGET_BOT_ID],
  }, signal, admitted.peer)
  if (!created.ok) throw new Error(`shared group creation failed: ${created.error.message}`)
  const groupId = groupIdOf(created.value)
  const read = await service.handle('bots/share/group-settings', {
    groupId,
    action: 'read',
  }, signal, admitted.peer)
  if (!read.ok) throw new Error(`shared group settings read failed: ${read.error.message}`)
  const renamed = await service.handle('bots/share/group-settings', {
    groupId,
    action: 'rename',
    name: RENAMED_GROUP,
    expectedUpdatedAt: updatedAtOf(read.value),
  }, signal, admitted.peer)
  if (!renamed.ok) throw new Error(`shared group rename failed: ${renamed.error.message}`)
  settingsNameOf(renamed.value)
  return { peer: admitted.peer, service }
}

/** Seed the renamed room and verify that one targeted Bot receives its exact routing metadata. */
export async function apply(ctx: Context): Promise<void> {
  await seedSharedBotPrerequisites(ctx)
  const dispose = installSnapshotSessionController(ctx)
  ctx.effect(() => dispose, 'snapshot shared group Bot handles')

  const groupReady = Promise.withResolvers<SharedGroupDriver>()
  let sent = false
  ctx.on('agent/created', async ({ agent }) => {
    if (String(agent.id) !== 'bot-session-sender') return
    groupReady.resolve(await createRenamedGroup(ctx))
  })
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (sent || String(options.sessionId) !== 'bot-session-sender') return stream
    return (async function* () {
      yield* stream
      if (sent) return
      const driver = await groupReady.promise
      const sentResult = await driver.service.handle('bots/share/send-group-message', {
        groupId: GROUP_ID,
        text: 'Send the release room status to Grok Bot.',
        messageId: GROUP_MESSAGE_ID,
        targetBotIds: [TARGET_BOT_ID],
      }, new AbortController().signal, driver.peer)
      if (!sentResult.ok) throw new Error(`shared group message failed: ${sentResult.error.message}`)
      const binding = (await driver.service.sharedGroupSessionBindings()).find(candidate =>
        candidate.groupId === GROUP_ID && candidate.botId === TARGET_BOT_ID && candidate.revokedAt === undefined)
      if (binding === undefined) throw new Error('shared group Bot binding was not retained')
      let recipient = ctx.agents.get(binding.sessionId)
      const deadline = Date.now() + 5_000
      while (recipient === undefined && Date.now() < deadline) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
        recipient = ctx.agents.get(binding.sessionId)
      }
      if (recipient === undefined) throw new Error('shared group Agent was not created')
      await recipient.whenIdle()
      if (process.env.DSH_SNAPSHOT_GROUP_REPLY === '1') {
        const replyResult = await driver.service.handle('bots/share/send-group-message', {
          groupId: GROUP_ID,
          text: 'The room is green; please keep the original request in view.',
          messageId: GROUP_REPLY_MESSAGE_ID,
          targetBotIds: [TARGET_BOT_ID],
          replyToMessageId: GROUP_MESSAGE_ID,
        }, new AbortController().signal, driver.peer)
        if (!replyResult.ok) throw new Error(`shared group reply failed: ${replyResult.error.message}`)
        const inspected = await driver.service.handle('bots/share/inspect-group', {
          groupId: GROUP_ID,
        }, new AbortController().signal, driver.peer)
        if (!inspected.ok) throw new Error(`shared group reply inspection failed: ${inspected.error.message}`)
        assertPersistedReply(inspected.value)
        await recipient.whenIdle()
      }
      sent = true
    })()
  })
}
