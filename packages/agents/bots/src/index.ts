/** Durable user-owned Bot roster with one ordinary Session per Bot. */

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, Service } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import type {} from '@yharness/system-prompt'
import type {} from '@yharness/avatar-generation'
import type { ImageAttachmentRef } from '@yharness/attachment'
import type { UserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import type { TurnEndReason } from '@yharness/session'
import type { SessionCreateRequest } from '@yharness/api-session-controller'
import type { Domain, KvTable } from '@yharness/storage-domain'
import z from '@yharness/schemastery'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@yharness/typert-protocol'
import { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
import { BotCollaborationError, BotCollaborationService, BotMessageId } from './collaboration.ts'
import type { BotCollaborationClient } from './collaboration.ts'
import { BotGroupService, botGroupDomain } from './group-chat.ts'
import type {
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupDeliveryClaimInput,
  BotGroupInspectRequest,
  BotGroupInspectValue,
  BotGroupListRequest,
  BotGroupListValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
} from './group-chat.ts'
import { createBotNativeToolProvider } from './native-tools.ts'
import type { BotNativeToolHost } from './native-tools.ts'
import { installBotCollaborationTools } from './scoped-tools.ts'
import type { BotGroupToolHost } from './scoped-tools.ts'
import type {
  BotAvailability,
  BotAccent,
  BotAppearanceUpdateRequest,
  BotAppearanceUpdateValue,
  BotAvatarUpdateRequest,
  BotAvatarUpdateValue,
  BotAvatarReadRequest,
  BotAvatarReadValue,
  BotCreateRequest,
  BotCreateValue,
  BotIdentity,
  BotListRequest,
  BotListValue,
  BotRecord,
  BotRenameRequest,
  BotRenameValue,
  BotView,
} from './types.ts'
import { BOT_APPEARANCE_MIGRATION_VERSION, botDomain, imageAttachmentRefSchema } from './storage.ts'

export type * from './types.ts'
export { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
export { botDomain, botRecordSchema } from './storage.ts'
export {
  BotCollaborationError,
  BotCollaborationService,
  BotMessageId,
  projectBotTranscript,
} from './collaboration.ts'
export type {
  BotCollaborationClient,
  BotCollaborationAgent,
  BotCollaborationErrorCode,
  BotCollaborationHost,
  BotCollaborationInspection,
  BotCollaborationInspectionValue,
  BotCollaborationRosterEntry,
  BotCollaborationTranscriptEntry,
  BotDynamicToolEvent,
  BotDynamicToolEventResult,
  BotGroupMessageSource,
  BotMessageSource,
  SendBotMessageRequest,
  SendBotMessageResult,
  SendExternalBotMessageRequest,
} from './collaboration.ts'
export {
  BotGroupError,
  BotGroupId,
  BotGroupMessageId,
  BotGroupService,
  botGroupDomain,
  botGroupRecordSchema,
  botGroupMessageRecordSchema,
  botGroupDeliveryRecordSchema,
} from './group-chat.ts'
export type {
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupDeliveryClaim,
  BotGroupDeliveryClaimInput,
  BotGroupDeliveryHost,
  BotGroupDeliveryRecord,
  BotGroupDeliveryStatusView,
  BotGroupDeliveryView,
  BotGroupDomain,
  BotGroupInspectRequest,
  BotGroupInspectValue,
  BotGroupListRequest,
  BotGroupListValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
  BotGroupMemberView,
  BotGroupMessageRecord,
  BotGroupMessageSender,
  BotGroupMessageSenderView,
  BotGroupMessageView,
  BotGroupRecord,
  BotGroupSendRequest,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupView,
} from './group-chat.ts'
export { imageAttachmentRefSchema } from './storage.ts'
export { installBotCollaborationTools } from './scoped-tools.ts'

declare module '@yharness/cordis' {
  interface Context {
    /** Durable user-owned Bot roster and one-Session provisioning service. */
    bots: BotService
  }
}

/** Empty Bot service configuration. */
export const Config = z.object({})

interface NormalizedCreate {
  readonly id?: BotRecord['id']
  readonly name: string
  readonly description?: string
  readonly identity: BotIdentity
  readonly accent: BotAccent
  readonly cwd: string
  readonly agentPreset?: string
}

function groupDeliveryClaims(messages: readonly UserMessage[]): BotGroupDeliveryClaimInput[] {
  return messages.flatMap((message): BotGroupDeliveryClaimInput[] => {
    if (message.source.kind !== 'bot-group-message') return []
    return [{ groupId: message.source.groupId, messageId: message.source.messageId }]
  })
}

function isolatedGroupDelivery(messages: readonly UserMessage[], claims: readonly BotGroupDeliveryClaimInput[]): boolean {
  const only = messages[0]
  return messages.length === 1 && claims.length === 1 && only?.source.kind === 'bot-group-message'
}

const BOT_ID_PATTERN = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/
const RUNTIME_CONTEXT_SOURCE: string = 'runtime-context'

function badRequest(message: string): never {
  throw new RemoteError('gateway/bad-request', message, {})
}

function textLength(value: string): number {
  return [...value].length
}

function normalizeName(value: string): string {
  if (typeof value !== 'string') return badRequest('Bot name must be a string')
  const name = value.trim()
  if (name.length === 0) return badRequest('Bot name must not be empty')
  if (textLength(name) > 80) return badRequest('Bot name must be at most 80 characters')
  return name
}

function normalizeOptionalText(
  label: string,
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return badRequest(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (textLength(trimmed) > max) return badRequest(`${label} must be at most ${String(max)} characters`)
  return trimmed
}

function normalizeBotId(value: BotRecord['id'] | undefined): BotRecord['id'] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    return badRequest('Bot id must begin with bot- and contain simple URL-safe segments')
  }
  return BotId(value)
}

function normalizeIdentity(value: BotCreateRequest['identity']): BotIdentity {
  const identity = value ?? 'agent'
  if (!BOT_IDENTITIES.includes(identity)) return badRequest(`Unknown Bot identity '${String(identity)}'`)
  return identity
}

function normalizeAccent(value: BotCreateRequest['accent']): BotAccent {
  const accent = value ?? 'violet'
  if (!BOT_ACCENTS.includes(accent)) return badRequest(`Unknown Bot accent '${String(accent)}'`)
  return accent
}

function normalizeAppearanceIdentity(value: BotAppearanceUpdateRequest['identity']): BotIdentity | undefined {
  if (value === undefined) return undefined
  if (!BOT_IDENTITIES.includes(value)) return badRequest(`Unknown Bot identity '${String(value)}'`)
  return value
}

function normalizeAppearanceAccent(value: BotAppearanceUpdateRequest['accent']): BotAccent | undefined {
  if (value === undefined) return undefined
  if (!BOT_ACCENTS.includes(value)) return badRequest(`Unknown Bot accent '${String(value)}'`)
  return value
}

function normalizeClearAvatar(value: BotAppearanceUpdateRequest['clearAvatar']): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') return badRequest('Bot clearAvatar must be a boolean')
  return value
}

function normalizeCreate(request: BotCreateRequest): NormalizedCreate {
  if (request === null || typeof request !== 'object') return badRequest('Bot create request must be an object')
  const id = normalizeBotId(request.id)
  const name = normalizeName(request.name)
  const description = normalizeOptionalText('Bot description', request.description, 240)
  const cwdInput = normalizeOptionalText('Bot working directory', request.cwd, 4096)
  const agentPreset = normalizeOptionalText('Bot agent preset', request.agentPreset, 160)
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(description === undefined ? {} : { description }),
    identity: normalizeIdentity(request.identity),
    accent: normalizeAccent(request.accent),
    cwd: resolve(cwdInput ?? process.cwd()),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

function matchesMetadata(record: BotRecord, request: NormalizedCreate): boolean {
  return record.name === request.name
    && record.description === request.description
    && record.identity === request.identity
    && record.accent === request.accent
    && record.cwd === request.cwd
    && record.agentPreset === request.agentPreset
}

function sessionRequest(record: BotRecord): SessionCreateRequest {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(record.agentPreset === undefined ? {} : { agentPreset: record.agentPreset }),
  }
}

/** Stable scoped section name for one Bot's model-visible identity. */
const BOT_IDENTITY_SECTION = 'bot:identity'

/** Render the Bot identity that every model route, including native Codex, receives. */
function botIdentityPrompt(record: BotRecord): string {
  return [
    'You are a named Bot in Y Harness.',
    `Your Bot name is ${JSON.stringify(record.name)}.`,
    `Your Bot id is ${JSON.stringify(record.id)}.`,
    'When asked who you are or what your name is, identify yourself by that Bot name. Do not answer only with the underlying model or provider name.',
    ...(record.description === undefined ? [] : [`Your role is: ${record.description}`]),
  ].join('\n\n')
}

/** Convert a durable turn outcome into a safe group-visible recovery message. */
function groupTurnFailure(reason: TurnEndReason): string | undefined {
  switch (reason.kind) {
    case 'completed':
    case 'forked':
      return undefined
    case 'error':
      switch (reason.error.code) {
        case 'MISSING_CREDENTIAL':
          return 'This Bot could not reply because its provider credentials are missing. Connect the provider, then retry.'
        case 'INVALID_CREDENTIAL':
          return 'This Bot could not reply because its provider credentials were rejected. Update the provider connection, then retry.'
        default:
          return 'This Bot could not complete its reply. Try again.'
      }
    case 'aborted':
      return 'This Bot stopped before replying. Try again.'
    case 'blocked':
      return 'This Bot could not reply because the request was blocked. Try again.'
    case 'max-tokens':
      return 'This Bot reached its response limit before replying. Try again with a shorter request.'
    case 'interrupted':
      return 'This Bot stopped before replying. Try again.'
    default:
      return 'This Bot did not complete its reply. Try again.'
  }
}

/** Replace legacy avatar selections without deleting their attachments. */
async function migrateLegacyAvatars(domain: Domain<typeof botDomain>): Promise<void> {
  if (domain.global.get().animatedAvatarVersion === BOT_APPEARANCE_MIGRATION_VERSION) return
  const bots = domain.table('bots')
  for (const [key, record] of bots.entries()) {
    if (record.avatar === undefined) continue
    const { avatar: legacyAvatar, ...withoutAvatar } = record
    void legacyAvatar
    await bots.put(key, withoutAvatar)
  }
  await domain.global.set({ animatedAvatarVersion: BOT_APPEARANCE_MIGRATION_VERSION })
}

/** Host service that owns the durable roster and its Session mappings. */
export class BotService extends TypertRemoteService {
  private manageBots!: NonNullable<BotNativeToolHost['manage']>
  static inject = ['agents', 'storageDomain', 'sessionController', 'sessions', 'attachments', 'systemPrompt', 'tools']

  static Config = Config

  private readonly ready: Promise<Domain<typeof botDomain>>
  private readonly groupDomain: Promise<Domain<typeof botGroupDomain>>
  private readonly groupService: Promise<BotGroupService>
  private readonly initialized: PromiseLike<unknown>
  private readonly recordsBySession = new Map<string, BotRecord>()
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  private readonly promptDisposals = new Set<Promise<void>>()
  private readonly collaboration: BotCollaborationService
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host context carrying storage and explicit Session creation.
   */
  constructor(ctx: Context) {
    super(ctx, 'bots', { namespace: 'bots' })
    this.ready = ctx.storageDomain.open(botDomain).then(async (domain) => {
      const seenSessions = new Set<string>()
      for (const [key, record] of domain.table('bots').entries()) {
        if (key !== record.id) {
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`bots: closing after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`bots: stored key "${key}" differs from record id "${record.id}"`)
        }
        if (seenSessions.has(record.sessionId)) {
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`bots: closing after a duplicate Session mapping failed: ${String(error)}`)
          }
          throw new Error(`bots: Session "${record.sessionId}" is mapped by more than one Bot`)
        }
        seenSessions.add(record.sessionId)
      }
      try {
        await migrateLegacyAvatars(domain)
      } catch (error) {
        try { await domain.close() } catch (closeError: unknown) {
          ctx.logger.warn(`bots: closing after startup failed: ${String(closeError)}`)
        }
        throw error
      }
      for (const [, record] of domain.table('bots').entries()) this.recordsBySession.set(String(record.sessionId), record)
      return domain
    })
    this.collaboration = new BotCollaborationService({
      listBots: async () => (await this.list({})).bots,
      inspectSession: async (sessionId) => {
        const inspection = await ctx.sessionController.inspect(sessionId)
        return { events: inspection.events }
      },
      resolveAgent: sessionId => ctx.sessionController.resolveAgent(sessionId),
      flushSession: async (sessionId) => {
        let session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          if (!('agent' in resolved)) throw resolved.error
          session = ctx.sessions.get(resolved.agent.id)
        }
        if (session === undefined) throw new Error(`Bot Session "${sessionId}" is not live.`)
        if (!await ctx.sessions.flush(session)) throw new Error('Bot Session has no durable persistence listener.')
      },
    })
    this.groupDomain = ctx.storageDomain.open(botGroupDomain)
    this.groupService = this.groupDomain.then(domain => new BotGroupService(domain, {
      listBots: async () => (await this.list({})).bots,
      deliverToBot: async request => this.collaboration.sendExternal({
        targetBotId: request.targetBotId,
        groupId: request.groupId,
        groupName: request.groupName,
        ...(request.senderName === undefined ? {} : { senderName: request.senderName }),
        text: request.text,
        messageId: BotMessageId(String(request.messageId)),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }),
      changed: () => this.emitChanged(),
    }))
    ctx.on('session/event', (session, event) => {
      const record = this.recordsBySession.get(String(session.id))
      if (record === undefined) return
      if (event.type === 'turn/end') {
        const failure = groupTurnFailure(event.data.reason)
        if (failure === undefined) return
        void this.groupService.then(service => service.recordBotTurnFailure(record.id, event.data.turn, failure))
          .catch((error: unknown) => {
            ctx.logger.warn(`bots: group failure projection failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        return
      }
      if (event.type !== 'assistant/message') return
      const text = event.data.message.content
        .flatMap(block => block.type === 'text' ? [block.text] : [])
        .join('\n')
        .trim()
      // Tool-call assistant messages are intermediate model steps. Keep the
      // delivery open until the first assistant message without a tool call.
      if (text === '' || event.data.message.content.some(block => block.type === 'tool-call')) return
      void this.groupService.then(service => service.recordBotResponse(
        record.id,
        event.data.turn,
        event.data.step,
        text,
        String(event.data.message.id),
      ))
        .catch((error: unknown) => {
          ctx.logger.warn(`bots: group response projection failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    })
    ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
      const decision = await next()
      const record = this.recordsBySession.get(String(agent.id))
      const claims = groupDeliveryClaims(messages)
      if (record !== undefined && decision.kind === 'enter') {
        await this.groupService.then(service => service.recordBotMessageClaims(
          record.id,
          claims,
          turn,
          step,
          isolatedGroupDelivery(messages, claims),
          messages.length > 0 && !isolatedGroupDelivery(messages, claims),
        ))
      }
      return decision
    })
    ctx.provide('codexDynamicTools', createBotNativeToolProvider({
      bind: async (sessionId) => {
        const agent = ctx.get('agents')?.get(sessionId)
        if (agent === undefined) return undefined
        try {
          return await this.collaboration.bind(agent)
        } catch (error: unknown) {
          if (error instanceof BotCollaborationError && error.code === 'sender-not-bot') return undefined
          throw error
        }
      },
      groups: async (sessionId) => {
        const agent = ctx.get('agents')?.get(sessionId)
        if (agent === undefined) return undefined
        try {
          return await this.groupToolsFor(agent)
        } catch (error: unknown) {
          if (error instanceof BotCollaborationError && error.code === 'sender-not-bot') return undefined
          throw error
        }
      },
      manage: this.manageBots = async (action, args, context) => {
        const text = (key: string): string | undefined => {
          const value = args[key]
          if (value === undefined) return undefined
          if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${key}.`)
          return value.trim()
        }
        const name = text('name')
        const description = normalizeOptionalText('Bot description', text('description'), 240)
        const identityText = text('identity')
        const accentText = text('accent')
        const pictureDescription = text('pictureDescription')
        const identity = BOT_IDENTITIES.find(value => value === identityText)
        const accent = BOT_ACCENTS.find(value => value === accentText)
        if (identityText !== undefined && identity === undefined) throw new Error('Invalid Bot character.')
        if (accentText !== undefined && accent === undefined) throw new Error('Invalid Bot color.')
        if (action === 'edit' && name === undefined && description === undefined && identity === undefined && accent === undefined && pictureDescription === undefined) {
          throw new Error('Specify a profile change.')
        }
        const setPicture = async (botId: BotId): Promise<void> => {
          if (pictureDescription === undefined) return
          const generator = ctx.get('avatarGeneration')
          if (generator === undefined) throw new Error('Avatar generation is unavailable.')
          const preview = await generator.generate({ description: pictureDescription }, context.signal)
          context.signal.throwIfAborted()
          const { attachment } = await generator.commit(preview)
          context.signal.throwIfAborted()
          await this.updateAvatarImpl({ botId, avatar: attachment }, context.signal)
        }
        context.signal.throwIfAborted()
        if (action === 'create') {
          if (name === undefined) throw new Error('Bot name is required.')
          const sender = context.sessionId === undefined ? undefined : this.recordsBySession.get(String(context.sessionId))
          if (sender === undefined) throw new Error('Bot management requires a live Bot.')
          const digest = createHash('sha256').update(`${context.sessionId}:${context.threadId}:${context.turnId}:${context.callId}`).digest('hex')
          const created = await this.createImpl({ id: BotId(`bot-${digest}`), name,
            cwd: sender.cwd,
            ...(description === undefined ? {} : { description }),
            ...(identity === undefined ? {} : { identity }), ...(accent === undefined ? {} : { accent }) }, context.signal)
          try {
            await setPicture(created.bot.id)
          } catch {
            return { id: created.bot.id, name: created.bot.name, state: created.bot.state,
              pictureError: 'The Bot was created, but its picture could not be generated.' }
          }
          return { id: created.bot.id, name: created.bot.name, state: created.bot.state }
        }
        const current = context.sessionId === undefined ? undefined : this.recordsBySession.get(String(context.sessionId))
        const botId = BotId(text('botId') ?? current?.id ?? '')
        if (!(await this.list({})).bots.some(bot => bot.id === botId)) throw new Error('Bot not found.')
        if (name !== undefined) normalizeName(name)
        context.signal.throwIfAborted()
        await setPicture(botId)
        if (identity !== undefined || accent !== undefined) {
          await this.updateAppearanceImpl({ botId, ...(identity === undefined ? {} : { identity }),
            ...(accent === undefined ? {} : { accent }),
            clearAvatar: identity !== undefined && pictureDescription === undefined }, context.signal)
        }
        if (name !== undefined) await this.renameImpl({ botId, name }, context.signal)
        if (description !== undefined) await this.updateBotDescription(botId, description, context.signal)
        return { id: botId, updated: true }
      },
      persist: async (event) => {
        await this.ready
        const session = ctx.sessions.get(event.sessionId)
        if (session === undefined) throw new Error(`Bot Session "${event.sessionId}" is not live.`)
        session.append('bot/dynamic-tool', event)
        if (!await ctx.sessions.flush(session)) throw new Error('Bot Session has no durable persistence listener.')
      },
      replay: async (sessionId) => {
        await this.ready
        const inspection = await ctx.sessionController.inspect(sessionId)
        return inspection.events.flatMap(event => event.type === 'bot/dynamic-tool' ? [event.data] : [])
      },
    }))
    ctx.on('agent/created', async ({ agent }) => {
      await this.installPrompt(agent)
      await this.reconcileGroupSession(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => { this.disposePrompt(agent) })
    this.initialized = ctx.effect(async () => {
      let domain: Domain<typeof botDomain> | undefined
      let groupDomain: Domain<typeof botGroupDomain> | undefined
      let cleanup: () => Promise<void>
      try {
        domain = await this.ready
        groupDomain = await this.groupDomain
        const openedDomain = domain
        const openedGroupDomain = groupDomain
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.chain
          const promptFibers = [...this.promptFibers.values()]
          this.promptFibers.clear()
          await this.groupService.then(service => service.whenIdle())
          await Promise.all([
            ...promptFibers.map(fiber => fiber.dispose()),
            ...this.promptDisposals,
            openedDomain.close(),
            openedGroupDomain.close(),
          ])
        })
      } catch (error) {
        this.stopping = true
        await Promise.all([
          ...(domain === undefined ? [] : [domain.close()]),
          ...(groupDomain === undefined ? [] : [groupDomain.close()]),
        ])
        throw error
      }
      return cleanup
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
    await Promise.all(this.ctx.agents.list().map(async (agent) => {
      await this.installPrompt(agent)
      await this.reconcileGroupSession(agent)
    }))
  }

  /**
   * Bind peer-Bot operations to the live Agent that owns the current turn.
   *
   * The provider bridge must supply this Agent from its runtime context; the
   * returned client never accepts a model-supplied sender Session id. Each
   * operation rechecks that the Session remains owned by a durable Bot.
   * @param agent - live Agent supplied by the provider bridge or scoped tool.
   * @returns collaboration operations attributed to that Bot.
   */
  collaborationFor(agent: Pick<Agent, 'id'>): Promise<BotCollaborationClient> {
    return this.collaboration.bind(agent)
  }

  private updateBotDescription(botId: BotId, description: string, signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(botId)
      if (current === undefined) throw new RemoteError('bot/not-found', `Bot "${botId}" was not found`, { botId })
      const next = { ...current, description, updatedAt: Math.max(Date.now(), current.updatedAt) }
      signal?.throwIfAborted()
      await bots.put(botId, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
    })
  }

  /**
   * List the durable Bot roster without activating cold Sessions.
   * @param _request - Empty list request reserved for future paging.
   * @returns one row per Bot, ordered by creation time and id.
   */
  @Remote('list')
  async list(_request: BotListRequest): Promise<BotListValue> {
    const bots = (await this.getDomain()).table('bots')
    return {
      bots: [...bots.entries()]
        .map(([, record]) => this.view(record))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    }
  }

  /** List durable multi-Bot groups and current member projections. */
  @Remote('listGroups')
  async listGroups(request: BotGroupListRequest): Promise<BotGroupListValue> {
    return (await this.getGroupService()).list(request)
  }

  /** Create or idempotently reuse one durable multi-Bot group. */
  @Remote('createGroup')
  async createGroup(request: BotGroupCreateRequest): Promise<BotGroupCreateValue> {
    return (await this.getGroupService()).create(request)
  }

  /** Update a durable multi-Bot group from the human workspace. */
  @Remote('updateGroup')
  async updateGroup(request: BotGroupUpdateRequest): Promise<BotGroupUpdateValue> {
    return (await this.getGroupService()).update(request)
  }

  /** Apply a group update for an already-authenticated live Bot runtime. */
  async updateGroupAsBot(senderBotId: BotId, request: BotGroupUpdateRequest): Promise<BotGroupUpdateValue> {
    return (await this.getGroupService()).updateAsBot(senderBotId, request)
  }

  /** Read one durable group transcript. */
  @Remote('inspectGroup')
  async inspectGroup(request: BotGroupInspectRequest): Promise<BotGroupInspectValue> {
    return (await this.getGroupService()).inspect(request)
  }

  /** Persist and fan out one human group message to every member Bot. */
  @Remote('sendGroupMessage')
  async sendGroupMessage(request: BotGroupSendRemoteRequest): Promise<BotGroupSendValue> {
    return (await this.getGroupService()).send(request)
  }

  /**
   * Create one durable Bot and its exactly-one ordinary Session.
   *
   * A provisioning row is committed before Session creation. If Session creation
   * or activation cannot finish, the row remains visible and the same Bot id can
   * be retried safely; no second Session is allocated for that Bot.
   *
   * @param request - Name, visual identity, optional working directory, and preset.
   * @returns the active row or a retryable provisioning row.
   */
  @Remote('create')
  async create(request: BotCreateRequest): Promise<BotCreateValue> {
    return this.createImpl(request)
  }

  private async createImpl(request: BotCreateRequest, signal?: AbortSignal): Promise<BotCreateValue> {
    return this.serialize(async () => {
      const normalized = normalizeCreate(request)
      const bots = (await this.getDomain()).table('bots')
      signal?.throwIfAborted()
      const id = normalized.id ?? BotId(`bot-${randomUUID()}`)
      const existing = bots.get(id)
      if (existing !== undefined) {
        if (existing.state === 'active' && matchesMetadata(existing, normalized)) {
          return { bot: this.view(existing) }
        }
        if (existing.state !== 'provisioning') {
          throw new RemoteError('bot/id-conflict', `Bot "${id}" already exists`, { botId: id })
        }
        if (!matchesMetadata(existing, normalized)) {
          throw new RemoteError(
            'bot/provisioning-conflict',
            `Bot "${id}" is provisioning with different metadata`,
            { botId: id },
          )
        }
        const active = await this.provision(existing, bots)
        return { bot: this.view(active) }
      }

      const now = Date.now()
      // Keep the Session id independent from a caller-supplied Bot id. A Bot
      // id is user-facing and must never accidentally adopt an unrelated
      // ordinary Session with a matching derived name.
      const sessionId = SessionId(`bot-session-${randomUUID()}`)
      const record: BotRecord = {
        id,
        sessionId,
        name: normalized.name,
        ...(normalized.description === undefined ? {} : { description: normalized.description }),
        identity: normalized.identity,
        accent: normalized.accent,
        cwd: normalized.cwd,
        ...(normalized.agentPreset === undefined ? {} : { agentPreset: normalized.agentPreset }),
        state: 'provisioning',
        createdAt: now,
        updatedAt: now,
      }
      await bots.put(id, record)
      this.recordsBySession.set(String(record.sessionId), record)
      this.emitChanged()
      const active = await this.provision(record, bots)
      return { bot: this.view(active) }
    })
  }

  /**
   * Rename one Bot while preserving its one Session mapping and visual identity.
   * @param request - Bot id and new display name.
   * @returns the committed row.
   */
  @Remote('rename')
  async rename(request: BotRenameRequest): Promise<BotRenameValue> {
    return this.renameImpl(request)
  }

  private async renameImpl(request: BotRenameRequest, signal?: AbortSignal): Promise<BotRenameValue> {
    return this.serialize(async () => {
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const name = normalizeName(request.name)
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const next: BotRecord = { ...current, name, updatedAt: Math.max(Date.now(), current.updatedAt) }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Update a Bot's semantic identity and/or accent without creating or changing
   * its one backing Session. Generated avatars remain selected unless the
   * caller explicitly sets `clearAvatar` to true.
   * @param request - Bot id, optional appearance fields, and optional avatar clear.
   * @returns the committed row.
   */
  @Remote('updateAppearance')
  async updateAppearance(request: BotAppearanceUpdateRequest): Promise<BotAppearanceUpdateValue> {
    return this.updateAppearanceImpl(request)
  }

  private async updateAppearanceImpl(request: BotAppearanceUpdateRequest, signal?: AbortSignal): Promise<BotAppearanceUpdateValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot appearance request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const identity = normalizeAppearanceIdentity(request.identity)
      const accent = normalizeAppearanceAccent(request.accent)
      const clearAvatar = normalizeClearAvatar(request.clearAvatar)
      if (identity === undefined && accent === undefined && !clearAvatar) {
        return badRequest('Bot appearance request must change identity or accent, or clear its avatar')
      }

      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const updatedAt = Math.max(Date.now(), current.updatedAt)
      const withAppearance: BotRecord = {
        ...current,
        ...(identity === undefined ? {} : { identity }),
        ...(accent === undefined ? {} : { accent }),
        updatedAt,
      }
      let next: BotRecord
      if (clearAvatar) {
        const { avatar: ignoredAvatar, ...withoutAvatar } = withAppearance
        void ignoredAvatar
        next = withoutAvatar
      } else {
        next = withAppearance
      }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Persist or clear a generated avatar while preserving the Bot's Session mapping.
   * @param request - Bot id and generated avatar payload, or null to clear it.
   * @returns the updated Bot row.
   */
  @Remote('updateAvatar')
  async updateAvatar(request: BotAvatarUpdateRequest): Promise<BotAvatarUpdateValue> {
    return this.updateAvatarImpl(request)
  }

  private async updateAvatarImpl(request: BotAvatarUpdateRequest, signal?: AbortSignal): Promise<BotAvatarUpdateValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot avatar request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const avatar = request.avatar === null ? undefined : await this.admitAvatar(id, request.avatar)
      const updatedAt = Math.max(Date.now(), current.updatedAt)
      let next: BotRecord
      if (request.avatar === null) {
        const { avatar: ignoredAvatar, ...withoutAvatar } = current
        void ignoredAvatar
        next = { ...withoutAvatar, updatedAt }
      } else {
        next = { ...current, avatar, updatedAt }
      }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Read the current Bot avatar through the Host attachment store.
   * @param request - Bot id whose selected avatar should be returned.
   * @returns canonical reference and bytes for a Client preview.
   */
  @Remote('readAvatar')
  async readAvatar(request: BotAvatarReadRequest): Promise<BotAvatarReadValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot avatar request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      if (current.avatar === undefined) {
        throw new RemoteError('bot/avatar-missing', `Bot "${id}" has no generated avatar`, { botId: id })
      }
      try {
        const stored = await this.ctx.attachments.readImage(current.avatar)
        const canonical = imageAttachmentRefSchema.safeParse(stored.ref)
        if (!canonical.success
          || String(canonical.data.attachmentId) !== String(current.avatar.attachmentId)
          || canonical.data.mediaType !== current.avatar.mediaType
          || canonical.data.bytes !== current.avatar.bytes
          || canonical.data.width !== current.avatar.width
          || canonical.data.height !== current.avatar.height) {
          throw new Error('Attachment storage returned a different image reference')
        }
        return { avatar: canonical.data, data: Buffer.from(stored.data).toString('base64') }
      } catch (error: unknown) {
        throw new RemoteError(
          'bot/avatar-invalid',
          `Bot "${id}" avatar could not be read from attachment storage`,
          { botId: id, reason: 'unreadable' },
          { cause: error },
        )
      }
    })
  }

  private async admitAvatar(botId: BotRecord['id'], candidate: ImageAttachmentRef): Promise<ImageAttachmentRef> {
    const parsed = imageAttachmentRefSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new RemoteError(
        'bot/avatar-invalid',
        `Bot "${botId}" supplied an invalid avatar reference`,
        { botId, reason: 'invalid-reference' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(parsed.data)
      const canonical = imageAttachmentRefSchema.safeParse(stored.ref)
      if (!canonical.success
        || String(canonical.data.attachmentId) !== String(parsed.data.attachmentId)
        || canonical.data.mediaType !== parsed.data.mediaType
        || canonical.data.bytes !== parsed.data.bytes
        || canonical.data.width !== parsed.data.width
        || canonical.data.height !== parsed.data.height) {
        throw new Error('Attachment storage returned a different image reference')
      }
      return canonical.data
    } catch (error: unknown) {
      throw new RemoteError(
        'bot/avatar-invalid',
        `Bot "${botId}" avatar could not be read from attachment storage`,
        { botId, reason: 'unreadable' },
        { cause: error },
      )
    }
  }

  private async provision(
    record: BotRecord,
    bots: KvTable<BotRecord['id'], BotRecord>,
  ): Promise<BotRecord> {
    try {
      const created = await this.ctx.sessionController.create(sessionRequest(record))
      if (created.sessionId !== record.sessionId) {
        throw new Error(`Session controller returned "${created.sessionId}" for "${record.sessionId}"`)
      }
    } catch (error: unknown) {
      const detail = remoteErrorOf(error)
      const message = detail === undefined ? String(error) : detail.message
      throw new RemoteError(
        'bot/provisioning-failed',
        `Bot "${record.id}" could not create its Session: ${message}`,
        { botId: record.id, sessionId: record.sessionId },
        { cause: error },
      )
    }
    const active: BotRecord = {
      ...record,
      state: 'active',
      updatedAt: Math.max(Date.now(), record.updatedAt),
    }
    try {
      await bots.put(record.id, active)
    } catch (error: unknown) {
      throw new RemoteError(
        'bot/provisioning-failed',
        `Bot "${record.id}" Session was created but roster activation was not saved`,
        { botId: record.id, sessionId: record.sessionId },
        { cause: error },
      )
    }
    this.recordsBySession.set(String(active.sessionId), active)
    this.emitChanged()
    return active
  }

  /** Install the Bot identity in the Agent scope before its first model turn. */
  private async installPrompt(agent: Agent): Promise<void> {
    await this.ready
    if (this.recordsBySession.get(String(agent.id)) === undefined || this.promptFibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      scope.systemPrompt.section({
        name: BOT_IDENTITY_SECTION,
        order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
        text: () => {
          const record = this.recordsBySession.get(String(agent.id))
          return record === undefined ? '' : botIdentityPrompt(record)
        },
        // Bot names and descriptions are user-authored prose, not variables.
        interpolate: false,
      })
      installBotCollaborationTools(scope, () => this.collaborationFor(agent), this.manageBots, () => this.groupToolsFor(agent))
    })
    this.promptFibers.set(agent, fiber)
    await fiber
  }

  /** Rebuild group delivery claims and response projections from a resumed Bot Session. */
  private async reconcileGroupSession(agent: Agent): Promise<void> {
    const record = this.recordsBySession.get(String(agent.id))
    if (record === undefined) return
    const inputs = new Map<string, { readonly turn: number; readonly step: number; readonly messages: UserMessage[] }>()
    const inbox: { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } = {
      'next-turn': [],
      'next-step': [],
    }
    let rawInboxSeen = false
    let claimedForStep: UserMessage[] = []
    let turn = 0
    let step = 0
    const inspection = await this.ctx.sessionController.inspect(agent.id)
    for (const event of inspection.events) {
      if (event.type === 'agent/inbox/spliced') {
        rawInboxSeen = true
        const queue = inbox[event.data.target]
        const removed = queue.splice(
          event.data.start,
          event.data.removedCount ?? 0,
          ...event.data.inserted,
        )
        if ((event.data.removedCount ?? 0) > 0
          && event.data.inserted.length === 0
          && event.data.outcome === undefined) {
          claimedForStep.push(...removed)
        }
        continue
      }
      if (event.type === 'turn/start') {
        if (rawInboxSeen) claimedForStep = []
        turn = event.data.turn
        step = 0
        continue
      }
      if (event.type === 'step/start') {
        turn = event.data.turn
        step = event.data.step
        inputs.set(`${String(turn)}:${String(step)}`, {
          turn,
          step,
          messages: rawInboxSeen ? claimedForStep.splice(0) : [],
        })
        continue
      }
      if (event.type === 'user/message') {
        // When inbox events are present, the pure deletion that admitted the
        // step is authoritative. Surface appends can include synthetic notices
        // or rewritten history that did not belong to that claim. Older logs
        // without inbox events retain the append-only fallback for migration.
        if (rawInboxSeen || event.surfaceOp !== 'append' || event.data.source.kind === RUNTIME_CONTEXT_SOURCE) continue
        const current = inputs.get(`${String(turn)}:${String(step)}`)
        if (current !== undefined) current.messages.push(event.data)
        continue
      }
      if (event.type === 'turn/end') {
        const failure = groupTurnFailure(event.data.reason)
        if (failure === undefined) continue
        const turnInputs = [...inputs.values()].filter(input => input.turn === event.data.turn)
        await this.groupService.then(async (service) => {
          for (const input of turnInputs) {
            const claims = groupDeliveryClaims(input.messages)
            if (claims.length === 0) continue
            await service.recordBotMessageClaims(
              record.id,
              claims,
              input.turn,
              input.step,
              isolatedGroupDelivery(input.messages, claims),
              input.messages.length > 0 && !isolatedGroupDelivery(input.messages, claims),
            )
          }
          await service.recordBotTurnFailure(record.id, event.data.turn, failure)
        })
        continue
      }
      if (event.type !== 'assistant/message') continue
      const current = inputs.get(`${String(event.data.turn)}:${String(event.data.step)}`)
      if (current === undefined) continue
      const claims = groupDeliveryClaims(current.messages)
      await this.groupService.then(async (service) => {
        await service.recordBotMessageClaims(
          record.id,
          claims,
          event.data.turn,
          event.data.step,
          isolatedGroupDelivery(current.messages, claims),
          current.messages.length > 0 && !isolatedGroupDelivery(current.messages, claims),
        )
        if (claims.length === 0) return
        const text = event.data.message.content
          .flatMap(block => block.type === 'text' ? [block.text] : [])
          .join('\n')
          .trim()
        if (text !== '' && !event.data.message.content.some(block => block.type === 'tool-call')) {
          await service.recordBotResponse(record.id, event.data.turn, event.data.step, text, String(event.data.message.id))
        }
      })
    }
  }

  private async groupToolsFor(agent: Pick<Agent, 'id'>): Promise<BotGroupToolHost> {
    const record = this.recordsBySession.get(String(agent.id))
    if (record === undefined) throw new BotCollaborationError('sender-not-bot', 'The calling Session is not owned by a Bot')
    const service = await this.getGroupService()
    const memberGroup = async (groupId: BotGroupInspectRequest['groupId']): Promise<void> => {
      const listed = await service.list({})
      const group = listed.groups.find(candidate => candidate.id === groupId)
      if (group === undefined || !group.botIds.includes(record.id)) throw new Error(`Bot is not a member of group "${String(groupId)}"`)
    }
    return {
      list: async () => {
        const listed = await service.list({})
        return { groups: listed.groups.filter(group => group.botIds.includes(record.id)) }
      },
      inspect: async (request) => {
        await memberGroup(request.groupId)
        return service.inspect(request)
      },
      create: async (request) => {
        const botIds = [record.id, ...request.botIds.filter(botId => botId !== record.id)]
        return service.create({ ...request, botIds })
      },
      send: async (request) => {
        await memberGroup(request.groupId)
        return service.sendAsBot(record.id, request)
      },
      update: async request => service.updateAsBot(record.id, request),
    }
  }

  /** Release one Agent's scoped identity registration after its lifecycle ends. */
  private disposePrompt(agent: Agent): void {
    const fiber = this.promptFibers.get(agent)
    if (fiber === undefined) return
    this.promptFibers.delete(agent)
    const task = fiber.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(`bots: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.promptDisposals.add(task)
    void task.finally(() => { this.promptDisposals.delete(task) })
  }

  private view(record: BotRecord): BotView {
    const agent = this.ctx.agents.get(record.sessionId)
    const availability: BotAvailability = agent === undefined
      ? 'offline'
      : agent.status === 'running' ? 'running' : 'idle'
    return { ...record, availability }
  }

  private async getDomain(): Promise<Domain<typeof botDomain>> {
    await this.initialized
    return this.ready
  }

  private async getGroupService(): Promise<BotGroupService> {
    await this.initialized
    return await this.groupService
  }

  private emitChanged(): void {
    try {
      this.ctx.emit('bots/changed')
    } catch (error: unknown) {
      this.ctx.logger.warn(`bots: roster change listener failed: ${String(error)}`)
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Bot service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }
}

export default BotService
