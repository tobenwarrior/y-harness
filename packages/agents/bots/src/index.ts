/** Durable user-owned Bot roster with one ordinary Session per Bot. */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionCreateRequest } from '@deepseek-ai/dsh-api-session-controller'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
import type {
  BotAvailability,
  BotAccent,
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
import { botDomain, imageAttachmentRefSchema } from './storage.ts'

export type * from './types.ts'
export { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
export { botDomain, botRecordSchema } from './storage.ts'
export { imageAttachmentRefSchema } from './storage.ts'

declare module '@deepseek-ai/cordis' {
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

const BOT_ID_PATTERN = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/

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

/** Host service that owns the durable roster and its Session mappings. */
export class BotService extends TypertRemoteService {
  static inject = ['agents', 'storageDomain', 'sessionController', 'attachments']

  static Config = Config

  private readonly ready: Promise<Domain<typeof botDomain>>
  private readonly initialized: PromiseLike<unknown>
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
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.chain
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      return cleanup
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
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
    return this.serialize(async () => {
      const normalized = normalizeCreate(request)
      const bots = (await this.getDomain()).table('bots')
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
    this.emitChanged()
    return active
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
