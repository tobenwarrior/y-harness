/** Authenticated shared-Bot endpoints and durable private-session routing. */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@yharness/cordis'
import {
  SharedAccessAuthority,
  SharedInviteCode,
  SharedPrincipalId,
  sharedInviteDigest,
  sharedPrincipalOf,
  sharedSessionExpiresAt,
  sharedRevocationSignal,
  type SharedAccessEnrollment,
  type SharedAccessInviteMetadata,
  type SharedAccessStateSnapshot,
} from '@yharness/client-connection'
import type { Agent } from '@yharness/agent'
import { ApiSessionNotFound } from '@yharness/api-session-controller'
import type { ConnectionRpcHandler, ConnectionRpcHandlerResult, ConnectionTrustRequest } from '@yharness/client-connection'
import { credentialKey } from '@yharness/credentials'
import type { CredentialProvider, CredentialRecord } from '@yharness/credentials'
import { createUserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import type { Domain, DomainFacility, KvTable } from '@yharness/storage-domain'
import { remoteErrorOf } from '@yharness/typert-protocol'
import z from 'zod'
import {
  authorizeBotShare,
  BOT_SHARE_ROLES,
  BotPrincipalId,
  type BotPrivateConversationBinding,
  type BotShareOperation,
  type BotShareRole,
} from './sharing.ts'
import {
  BotId,
  BotShareMemoryId,
  type BotShareMemoryEntry,
  type BotShareMemoryPolicyValue,
  type BotShareMemoryValue,
  type BotAccent,
  type BotIdentity,
  type BotView,
} from './types.ts'
import { BotGroupId, BotGroupMessageId } from './group-chat.ts'
import type {
  BotGroupCreateRequest,
  BotGroupDeliveryRecoveryRequest,
  BotGroupDeliveryRecoveryValue,
  BotGroupSendRemoteRequest,
} from './group-chat.ts'
import {
  sharedBotDomain,
  SHARED_MEMORY_MAX_ENTRIES,
  SHARED_MEMORY_MAX_ENTRIES_PER_BOT,
  SHARED_MEMORY_MAX_POLICIES,
  sharedPrivateSessionSchema,
  sharedMemorySnapshotSchema,
  type SharedInviteRecord,
  type SharedMemoryEntry,
  type SharedMemorySnapshot,
  type SharedMembershipRecord,
  type SharedMembershipSnapshot,
  type SharedPrivateSessionRecord,
  sharedMembershipSnapshotSchema,
} from './storage.ts'
import { projectBotTranscript, type BotCollaborationInspection } from './collaboration.ts'
import {
  SharedBotGroupService,
  SharedGroupError,
  type SharedGroupHost,
  type SharedGroupSessionBinding,
} from './shared-group.ts'

/** Exact endpoint allowlist mounted on the collaborator-only route. */
export const SHARED_BOT_ENDPOINTS = [
  'bots/share/session',
  'bots/share/list',
  'bots/share/read-profile',
  'bots/share/read-private-chat',
  'bots/share/chat',
  'bots/share/manage-members',
  'bots/share/read-memory',
  'bots/share/write-memory',
  'bots/share/manage-memory',
  'bots/share/list-groups',
  'bots/share/create-group',
  'bots/share/update-group',
  'bots/share/inspect-group',
  'bots/share/send-group-message',
  'bots/share/manage-group-members',
] as const

/** Safe profile projection returned to a collaborator. */
export interface SharedBotProfile {
  readonly id: BotId
  readonly name: string
  readonly description?: string
  readonly identity: BotIdentity
  readonly accent: BotAccent
  readonly avatar?: BotView['avatar']
  readonly state: BotView['state']
  readonly availability: BotView['availability']
}

/** One roster entry visible to an authenticated shared principal. */
export interface SharedBotRosterEntry extends SharedBotProfile {
  readonly role: BotShareRole
}

/** Fields a manager may change without replacing the Bot's private Session. */
export interface SharedBotProfileUpdate {
  readonly name?: string
  readonly identity?: BotIdentity
  readonly accent?: BotAccent
}

/** Capabilities the runtime supplies to the shared-Bot service. */
export interface SharedBotHost extends SharedGroupHost {
  /** List the operator-owned Bots without exposing private Session data. */
  readonly listBots: (signal?: AbortSignal) => Promise<readonly BotView[]>
  /** Hold the durable Bot-profile lifecycle fence while one group operation commits. */
  readonly withBotRoster: NonNullable<SharedGroupHost['withBotRoster']>
  /** Find one operator-owned Bot by stable id. */
  readonly findBot: (botId: BotId, signal?: AbortSignal) => Promise<BotView | undefined>
  /**
   * Run one operation while the Host serializes it with Bot-row lifecycle work.
   * The result is marked missing when the durable Bot row is absent.
   */
  readonly withBot: <T>(
    botId: BotId,
    signal: AbortSignal | undefined,
    operation: (bot: BotView) => Promise<T>,
  ) => Promise<SharedBotHostOperationResult<T>>
  /** Commit one manager-authorized Bot profile update as one durable row. An expected version rejects stale writes. */
  readonly updateProfile: (
    botId: BotId,
    update: SharedBotProfileUpdate,
    signal?: AbortSignal,
    expectedUpdatedAt?: number,
  ) => Promise<BotView>
  /**
   * Create one private backing Session for a Bot and principal pair.
   * @returns the live Agent when creation completed, when the Host can expose
   *   it; returning `void` is supported for Hosts that resolve it separately.
   */
  readonly createPrivateSession: (
    bot: BotView,
    sessionId: SessionId,
    principalId: string,
    signal?: AbortSignal,
  ) => Promise<Pick<Agent, 'id' | 'cancel' | 'whenIdle'> | void>
  /**
   * Resume a private Session and return follow-up and cancellation capabilities.
   * The optional Bot id comes from the Host's authoritative private-session
   * binding and lets a cold resume register its shared scope before creation.
   */
  readonly resolvePrivateAgent: (sessionId: SessionId, signal: AbortSignal, botId?: BotId) => Promise<{
    readonly agent: Pick<Agent, 'id' | 'followup' | 'cancel' | 'whenIdle'>
  } | { readonly error: Error }>
  /** Inspect one private Session's durable events. */
  readonly inspectPrivateSession: (sessionId: SessionId, signal: AbortSignal) => Promise<BotCollaborationInspection>
  /** Validate the private Session header before any transcript read or resume. */
  readonly validatePrivateSession: (sessionId: SessionId, signal?: AbortSignal) => Promise<void>
  /** Wait until a private Session's latest message is durably stored. */
  readonly flushPrivateSession: (sessionId: SessionId, signal?: AbortSignal) => Promise<void>
}

/** Result of one Host operation that requires a still-existing Bot row. */
export type SharedBotHostOperationResult<T> =
  | { readonly found: true; readonly value: T }
  | { readonly found: false }

/** Enrollment result with the Bot share association for the new principal. */
export interface SharedBotEnrollment extends SharedAccessEnrollment {
  readonly botId: BotId
  readonly role: BotShareRole
}

/** Enrollment result after a principal redeems a group-only ACL invitation. */
export interface SharedGroupEnrollment extends SharedAccessEnrollment {
  readonly groupId: BotGroupId
}

/** Current collaborator identity returned after the browser reloads. */
export interface SharedBotSessionValue {
  /** Stable collaborator identity derived from the authenticated shared Peer. */
  readonly principalId: SharedPrincipalId
  /** Absolute expiry of the authenticated collaborator session. */
  readonly expiresAt: number
}

/** Result of a private-session lookup. */
export interface SharedPrivateSessionValue extends BotPrivateConversationBinding {
  readonly createdAt: number
  readonly updatedAt: number
}

interface SharedServiceOptions {
  readonly now?: () => number
  /** Durable provider used to refresh membership state across processes. */
  readonly credentials?: CredentialProvider
  /** Maximum interval before a process notices a membership change in storage. */
  readonly membershipPollIntervalMs?: number
}

interface PendingBotInvite {
  readonly botId: BotId
  readonly role: BotShareRole
  readonly expiresAt: number
}

interface SharedMembershipState {
  readonly roster: {
    readonly botId: BotId
    readonly memberships: readonly SharedMembershipRecord[]
  }
  readonly actor: SharedMembershipRecord
}

class SharedServiceFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SharedServiceFault'
  }
}

const botIdPayload = z.object({
  botId: z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId),
}).strict()
const chatPayload = botIdPayload.extend({
  text: z.string().min(1).max(16_000).refine(value => value.trim() === value),
}).strict()
const manageMembersPayload = botIdPayload.extend({
  action: z.enum(['create-invite', 'revoke']),
  role: z.enum(BOT_SHARE_ROLES).optional(),
  principalId: z.string().regex(/^principal-[A-Za-z0-9-]+$/).transform(BotPrincipalId).optional(),
}).strict()
const writeMemoryPayload = botIdPayload.extend({
  text: z.string().min(1).max(2_000).refine(value => value.trim() === value),
  consent: z.literal(true),
}).strict()
const manageMemoryPayload = botIdPayload.extend({
  enabled: z.boolean(),
}).strict()
const groupIdPayload = z.object({
  groupId: z.string().regex(/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupId),
}).strict()
const groupBotIds = z.array(botIdPayload.shape.botId).min(2).max(6).refine(
  botIds => new Set(botIds.map(String)).size === botIds.length,
  'group Bot members must be unique',
)
const groupCreatePayload = z.object({
  id: z.string().regex(/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupId).optional(),
  name: z.string().min(1).max(80).refine(value => value.trim() === value),
  botIds: groupBotIds,
}).strict()
const groupUpdatePayload = groupIdPayload.extend({
  name: z.string().min(1).max(80).refine(value => value.trim() === value),
  botIds: groupBotIds,
}).strict()
const groupSendPayload = groupIdPayload.extend({
  text: z.string().min(1).max(16_000).refine(value => value.trim() === value),
  messageId: z.string().regex(/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupMessageId).optional(),
  targetBotIds: z.array(botIdPayload.shape.botId).min(1).max(6).refine(
    botIds => new Set(botIds.map(String)).size === botIds.length,
    'group Bot targets must be unique',
  ).optional(),
}).strict()
const manageGroupMembersPayload = groupIdPayload.extend({
  action: z.enum(['create-invite', 'revoke']),
  principalId: z.string().regex(/^principal-[A-Za-z0-9-]+$/).transform(BotPrincipalId).optional(),
}).strict()
type BotIdPayload = z.infer<typeof botIdPayload>
type ChatPayload = z.infer<typeof chatPayload>
type ManageMembersPayload = z.infer<typeof manageMembersPayload>
type WriteMemoryPayload = z.infer<typeof writeMemoryPayload>
type ManageMemoryPayload = z.infer<typeof manageMemoryPayload>
type GroupIdPayload = z.infer<typeof groupIdPayload>
type GroupCreatePayload = z.infer<typeof groupCreatePayload>
type GroupUpdatePayload = z.infer<typeof groupUpdatePayload>
type GroupSendPayload = z.infer<typeof groupSendPayload>
type ManageGroupMembersPayload = z.infer<typeof manageGroupMembersPayload>

const SHARED_MEMBERSHIP_RECORD_KEY = credentialKey('agent-bots', 'shared-memberships')
const SHARED_MEMBERSHIP_EXTENSION_KEY = 'agent-bots/shared-memberships'
const SHARED_PRIVATE_SESSIONS_EXTENSION_KEY = 'agent-bots/shared-private-sessions'
const SHARED_PAIR_KEY_MIGRATION_EXTENSION_KEY = 'agent-bots/shared-pair-key-migration'
const SHARED_MEMBERSHIP_RECORD_VERSION = 1 as const
const SHARED_PRIVATE_SESSIONS_RECORD_VERSION = 1 as const
const SHARED_PAIR_KEY_MIGRATION_VERSION = 3 as const
const DEFAULT_SHARED_MEMBERSHIP_POLL_INTERVAL_MS = 1_000
const MAX_NODE_TIMER_MS = 2_147_483_647
const SHARED_AGENT_CANCEL_TIMEOUT_MS = 1_000
const SHARED_FLUSH_TIMEOUT_MS = 1_000
const SHARED_DISPOSE_TIMEOUT_MS = SHARED_AGENT_CANCEL_TIMEOUT_MS

const sharedPrivateSessionSnapshotSchema = z.object({
  version: z.literal(SHARED_PRIVATE_SESSIONS_RECORD_VERSION),
  bindings: z.array(sharedPrivateSessionSchema),
}).strict()

type SharedPrivateSessionSnapshot = z.infer<typeof sharedPrivateSessionSnapshotSchema>

/** Await one storage read unless the caller or service stops waiting. */
async function raceSharedAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  const abortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error('shared Bot request aborted', { cause: signal.reason })
  if (signal.aborted) {
    void operation.catch(() => undefined)
    throw abortError()
  }
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(abortError()) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Wait for tracked teardown work without making service disposal unbounded. */
async function waitForTracked(completions: readonly Promise<unknown>[]): Promise<void> {
  if (completions.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHARED_DISPOSE_TIMEOUT_MS)
    timer.unref()
  })
  try {
    await Promise.race([Promise.allSettled(completions), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Own shared-Bot persistence, role checks, private Session bindings, and the
 * exact handler surface used by the dedicated Connection route.
 */
export class SharedBotService {
  private readonly memberships: KvTable<string, SharedMembershipRecord>
  private readonly invites: KvTable<string, SharedInviteRecord>
  private readonly privateSessions: KvTable<string, SharedPrivateSessionRecord>
  private readonly privateSessionCache = new Map<string, SharedPrivateSessionRecord>()
  /** Bindings revoked by this process stay durable until sibling processes observe them. */
  private readonly deferredRemoteCleanup = new Set<string>()
  /** Locally quiescent revoked bindings stay out of this cache while siblings observe them. */
  private readonly completedRemoteCleanup = new Set<string>()
  private readonly owner: Context
  private membershipSnapshot: readonly SharedMembershipRecord[]
  private readonly now: () => number
  private readonly activeRequests = new Map<string, Set<AbortController>>()
  private readonly activeRequestControllers = new Set<AbortController>()
  private readonly activeRequestCompletions = new Set<Promise<void>>()
  /** Durability operations that may outlive a cancelled shared request. */
  private readonly activeFlushCompletions = new Set<Promise<void>>()
  /** Private Sessions whose Agent has been cancelled but has not reached idle. */
  private readonly quarantinedSessions = new Map<string, Promise<void>>()
  /** Bindings whose last quiescence attempt failed and need a fresh retry. */
  private readonly quarantineRetries = new Set<string>()
  /** Revoked Session identities retained until a delayed Agent is idle. */
  private readonly revokedBindings = new Map<string, SharedPrivateSessionRecord>()
  private readonly membershipPollTimer: ReturnType<typeof setInterval>
  private readonly stoppingController = new AbortController()
  private readonly groups: SharedBotGroupService
  private membershipRefresh: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  private constructor(
    owner: Context,
    private readonly domain: Domain<typeof sharedBotDomain>,
    private readonly authority: SharedAccessAuthority,
    private readonly host: SharedBotHost,
    membershipSnapshot: readonly SharedMembershipRecord[],
    privateSessionSnapshot: SharedPrivateSessionSnapshot,
    options: SharedServiceOptions,
  ) {
    this.owner = owner
    this.memberships = domain.table('memberships')
    this.invites = domain.table('invites')
    this.privateSessions = domain.table('private_sessions')
    this.groups = new SharedBotGroupService(authority, host, options.now ?? Date.now)
    this.membershipSnapshot = membershipSnapshot
    for (const binding of privateSessionSnapshot.bindings) {
      if (binding.revokedAt === undefined) {
        this.privateSessionCache.set(sessionKey(binding.botId, binding.principalId), binding)
      }
    }
    this.now = options.now ?? Date.now
    const membershipPollIntervalMs = Math.max(1, Math.min(
      options.membershipPollIntervalMs ?? DEFAULT_SHARED_MEMBERSHIP_POLL_INTERVAL_MS,
      MAX_NODE_TIMER_MS,
    ))
    this.membershipPollTimer = setInterval(() => {
      this.scheduleMembershipRefresh()
    }, membershipPollIntervalMs)
    this.membershipPollTimer.unref()
  }

  /**
   * Open the shared-Bot domain over the caller's storage facility.
   * @param owner - Context owning the service lifecycle.
   * @param facility - Domain facility routed to durable storage.
   * @param authority - Separate collaborator identity authority.
   * @param host - Operator Bot and Session capabilities.
   * @param options - Clock and durable membership-refresh options.
   * @returns a ready shared-Bot service.
   */
  static async create(
    owner: Context,
    facility: DomainFacility,
    authority: SharedAccessAuthority,
    host: SharedBotHost,
    options: SharedServiceOptions = {},
  ): Promise<SharedBotService> {
    const credentials = options.credentials ?? owner.get('credentials')
    if (credentials === undefined) {
      throw new Error('shared Bot service requires a credential provider')
    }
    let domain: Domain<typeof sharedBotDomain> | undefined
    try {
      await authority.mutateExtension(SHARED_PAIR_KEY_MIGRATION_EXTENSION_KEY, async (current, authorityState) => {
        if (current !== undefined && !sharedPairKeyMigrationSchema.safeParse(current).success) {
          throw new Error('shared Bot pair-key migration marker is invalid')
        }
        // Open the domain while the authority record is locked. A Host that
        // opened it before this point could retain a stale legacy snapshot and
        // overwrite a newer successor row after another Host migrated it.
        domain = await facility.open(sharedBotDomain)
        await migrateSharedPairTable(domain.table('memberships'), 'memberships')
        await migrateSharedPairTable(domain.table('private_sessions'), 'private_sessions')
        await reconcileInviteMirror(
          domain.table('invites'),
          authorityState.invites ?? [],
          options.now?.() ?? Date.now(),
        )
        return {
          value: undefined,
          next: { version: SHARED_PAIR_KEY_MIGRATION_VERSION },
        }
      })
      if (domain === undefined) throw new Error('shared Bot domain did not open during migration')
      const membershipSnapshot = await initializeMembershipSnapshot(authority, credentials, domain.table('memberships'))
      await reconcileMembershipMirror(authority, domain.table('memberships'))
      const privateSessionSnapshot = await initializePrivateSessionSnapshot(authority, domain.table('private_sessions'))
      await reconcilePrivateSessionMirror(authority, domain.table('private_sessions'))
      return new SharedBotService(owner, domain, authority, host, membershipSnapshot, privateSessionSnapshot, options)
    } catch (error) {
      if (domain !== undefined) await waitForTracked([domain.close()])
      throw error
    }
  }

  /**
   * Issue and durably associate one owner-side invite with a Bot.
   *
   * An omitted actor is an operator-side call. Shared collaborators must pass
   * their authenticated principal and therefore pass the role policy below.
   * @param botId - Bot to share.
   * @param role - Role granted when the code is redeemed.
   * @param actor - Optional authenticated manager/owner issuing the invite.
   * @returns one-time code and expiry.
   */
  async createInvite(
    botId: BotId,
    role: BotShareRole,
    actor?: ReturnType<typeof BotPrincipalId>,
  ): Promise<{ readonly code: SharedInviteCode; readonly expiresAt: number }> {
    return this.serialize(() => this.createInviteImpl(botId, role, actor))
  }

  /**
   * Enroll the authenticated local operator as the shared owner and repair
   * owner memberships for active local Bots that do not have one.
   *
   * The authority mints or reuses one durable principal before this method
   * updates membership records. Existing owners, members, and Session
   * bindings are retained; a later Host can safely retry after an interrupted
   * membership mirror write.
   * @param request - trusted operator request receiving the shared cookie.
   * @returns the durable owner enrollment and shared cookie.
   */
  async enrollOwner(request: ConnectionTrustRequest): Promise<SharedAccessEnrollment> {
    return this.serialize(async () => {
      const candidates = [...new Set(this.membershipSnapshot
        .filter(member => member.role === 'owner')
        .map(member => String(member.principalId)))].sort()
      const enrollment = await this.authority.enrollOwner(
        request,
        candidates[0] === undefined ? undefined : SharedPrincipalId(candidates[0]),
      )
      const principalId = BotPrincipalId(String(enrollment.principalId))
      const bots = await this.host.listBots()
      const activeBots = [...new Map(bots
        .filter(bot => bot.state === 'active')
        .map(bot => [String(bot.id), bot])).values()]
      const now = this.now()
      const result = await this.authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, async (current) => {
        const snapshot = parseMembershipSnapshot(current)
        let memberships = [...snapshot.memberships]
        for (const bot of activeBots) {
          const botId = bot.id
          const botMemberships = memberships.filter(member => member.botId === botId)
          if (botMemberships.some(member => member.role === 'owner')) continue
          const existing = botMemberships.find(member => member.principalId === principalId)
          const membership: SharedMembershipRecord = existing === undefined
            ? {
              botId,
              principalId,
              role: 'owner',
              grantedBy: principalId,
              createdAt: now,
              updatedAt: now,
            }
            : {
              ...existing,
              role: 'owner',
              grantedBy: principalId,
              updatedAt: Math.max(now, existing.updatedAt),
            }
          const key = membershipKey(membership.botId, membership.principalId)
          await this.memberships.put(key, membership)
          memberships = existing === undefined
            ? [...memberships, membership]
            : memberships.map(candidate => membershipKey(candidate.botId, candidate.principalId) === key ? membership : candidate)
        }
        return {
          value: { memberships },
          next: { ...snapshot, memberships },
        }
      })
      this.membershipSnapshot = result.memberships
      return enrollment
    })
  }

  /**
   * List the current members of one operator-owned Bot.
   * @param botId - Bot whose shared roster should be returned.
   * @returns durable membership summaries in storage order.
   */
  async listMembers(botId: BotId): Promise<readonly SharedMembershipRecord[]> {
    return this.serialize(async () => {
      await this.requireBot(botId)
      return this.membershipsFor(botId)
    })
  }

  /**
   * Read the operator-controlled shared-context policy for one Bot.
   * @param botId - Bot whose policy should be returned.
   * @returns the current policy, disabled when no policy has been published.
   */
  async readMemoryPolicy(botId: BotId): Promise<BotShareMemoryPolicyValue> {
    return this.serialize(async () => {
      await this.requireBot(botId)
      const extension = await this.authority.readExtension(SHARED_MEMBERSHIP_EXTENSION_KEY)
      return memoryPolicyFor(parseMembershipSnapshot(extension.value).sharedMemory, botId)
    })
  }

  /**
   * Enable or disable shared context for one operator-owned Bot.
   * @param botId - Bot whose policy should change.
   * @param enabled - Whether members may publish and read shared notes.
   * @returns the committed policy.
   */
  async setMemoryPolicy(botId: BotId, enabled: boolean): Promise<BotShareMemoryPolicyValue> {
    return this.serialize(async () => {
      return this.mutateSharedMemory(botId, undefined, undefined, undefined, (memory) => {
        const updatedAt = this.now()
        const currentPolicy = memory.policies.find(candidate => candidate.botId === botId)
        if (currentPolicy === undefined && memory.policies.length >= SHARED_MEMORY_MAX_POLICIES) {
          throw new SharedServiceFault('gateway/unavailable', 'shared Bot context policy limit reached')
        }
        const policy = { botId, enabled, updatedAt }
        const policies = [
          ...memory.policies.filter(candidate => candidate.botId !== botId),
          policy,
        ]
        return {
          memory: {
            policies,
            entries: enabled ? memory.entries : memory.entries.filter(entry => entry.botId !== botId),
          },
          value: policy,
        }
      })
    })
  }

  /**
   * Revoke one non-owner membership for one Bot.
   *
   * The operation deliberately does not revoke the authority principal: a
   * person may be a member of several Bots, so removal is scoped to this Bot.
   * @param botId - Bot whose membership should be removed.
   * @param principalId - Principal to remove.
   * @param actor - Optional shared manager/owner performing the mutation.
   * @returns the removed principal after durable deletion.
   */
  async revokeMember(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    actor?: ReturnType<typeof BotPrincipalId>,
  ): Promise<{ readonly botId: BotId; readonly principalId: ReturnType<typeof BotPrincipalId>; readonly revoked: true }> {
    return this.serialize(() => this.revokeMemberImpl(botId, principalId, actor))
  }

  /**
   * Redeem one owner-issued invite and bind its principal to the selected Bot.
   * @param code - raw one-time invite code.
   * @param request - trusted request receiving the authority cookie.
   * @returns authority cookie plus the Bot membership granted by the invite.
   */
  async enroll(code: SharedInviteCode, request: ConnectionTrustRequest): Promise<SharedBotEnrollment | SharedGroupEnrollment> {
    return this.serialize(async () => {
      if (await this.groups.hasInvite(code)) {
        return await this.groups.redeemInvite(code, request)
      }
      const digest = sharedInviteDigest(code)
      const authoritySnapshot = await this.authority.readExtension(SHARED_MEMBERSHIP_EXTENSION_KEY)
      const pending = pendingBotInvite(digest, authoritySnapshot.state.invites, this.invites.get(digest))
      if (pending === undefined || this.now() >= pending.expiresAt) {
        if (this.invites.get(digest) !== undefined) await this.withPairKeyMirrorWrite(() => this.invites.delete(digest))
        throw new SharedServiceFault('gateway/bad-request', 'shared Bot invite is invalid or expired')
      }
      const operation = await this.host.withBot(pending.botId, undefined, async (bot) => {
        if (bot.state !== 'active') throw new SharedServiceFault('gateway/bad-request', 'shared Bot is not ready')
        const current = this.membershipsFor(pending.botId)
        const owner = current.find(member => member.role === 'owner')
        if (pending.role === 'owner' ? owner !== undefined : owner === undefined) {
          throw new SharedServiceFault('gateway/bad-request', 'shared Bot invite can no longer be redeemed')
        }
        let enrollment: SharedAccessEnrollment
        try {
          enrollment = await this.authority.redeemInvite(code, request)
        } catch {
          throw new SharedServiceFault('gateway/bad-request', 'shared Bot invite is invalid or expired')
        }
        const principalId = BotPrincipalId(String(enrollment.principalId))
        const grantedBy = owner?.principalId ?? principalId
        const now = this.now()
        const membership: SharedMembershipRecord = {
          botId: pending.botId,
          principalId,
          role: pending.role,
          grantedBy,
          createdAt: now,
          updatedAt: now,
        }
        let existingMembership: SharedMembershipRecord | undefined
        try {
          await this.updateMemberships(async (memberships) => {
            const existing = memberships.find(member =>
              member.botId === membership.botId && member.principalId === membership.principalId)
            if (existing !== undefined) {
              existingMembership = existing
              const existingKey = membershipKey(existing.botId, existing.principalId)
              const stored = this.memberships.get(existingKey)
              if (stored === undefined || !isDeepStrictEqual(stored, existing)) {
                await this.memberships.put(existingKey, existing)
              }
              await this.invites.delete(digest)
              return { memberships, value: undefined }
            }
            if (membership.role === 'owner' && memberships.some(member =>
              member.botId === membership.botId && member.role === 'owner')) {
              throw new SharedServiceFault('gateway/bad-request', 'shared Bot already has an owner')
            }
            await this.memberships.put(membershipKey(membership.botId, membership.principalId), membership)
            await this.invites.delete(digest)
            return { memberships: [...memberships, membership], value: undefined }
          })
          if (existingMembership !== undefined) {
            if (existingMembership.role !== pending.role) {
              throw new SharedServiceFault('gateway/bad-request', 'shared Bot principal is already enrolled with a different role')
            }
          }
        } catch (error) {
          if (existingMembership !== undefined) {
            if (error instanceof SharedServiceFault) throw error
            throw new SharedServiceFault('gateway/internal', 'shared Bot enrollment could not restore its existing membership')
          }
          // The membership extension and mirror are written in one
          // authority-record mutation. If the credential provider reports an
          // uncertain commit, do not issue a compensating delete that could
          // remove a row from a committed grant; the next Host reconciles it.
          await this.authority.revokePrincipal(SharedPrincipalId(String(enrollment.principalId))).catch(() => undefined)
          if (error instanceof SharedServiceFault) throw error
          throw new SharedServiceFault('gateway/internal', 'shared Bot enrollment could not be stored')
        }
        return { ...enrollment, botId: pending.botId, role: pending.role }
      })
      if (!operation.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
      return operation.value
    })
  }

  /**
   * Resolve one durable private Session binding without creating a Session.
   * @param botId - shared Bot identity.
   * @param principalId - authenticated participant identity.
   * @returns the binding, or undefined before the participant first chats.
   */
  sessionFor(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): SharedPrivateSessionValue | undefined {
    const record = this.privateSessionCache.get(sessionKey(botId, principalId))
    if (record === undefined || record.revokedAt !== undefined) return undefined
    return {
      botId: record.botId,
      principalId: record.principalId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  /**
   * Return durable private-session bindings so the Host can restore Bot
   * identity context after a process restart.
   * @returns all persisted Bot/principal session bindings.
   */
  privateSessionBindings(): readonly SharedPrivateSessionValue[] {
    return [...this.privateSessionCache.values()].map(record => ({
      botId: record.botId,
      principalId: record.principalId,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }))
  }

  /**
   * Return durable isolated shared-group Session bindings for Host recovery.
   * @returns the persisted shared-group Session bindings.
   */
  async sharedGroupSessionBindings(): Promise<readonly SharedGroupSessionBinding[]> {
    return this.groups.sessionBindings()
  }

  /**
   * Replay durable shared-group deliveries after a Host restart.
   * @param signal - optional cancellation for the recovery sweep.
   */
  async recoverSharedGroupDeliveries(signal?: AbortSignal): Promise<void> {
    await this.groups.recoverPendingDeliveries(signal)
  }

  /**
   * Reconcile one isolated shared-group recipient admission after explicit
   * owner confirmation that every possible Session Host is quiesced.
   * @param request - Exact group, Bot, Session, and message identities.
   * @returns The durable recovery status for the recipient fence.
   */
  async recoverSharedGroupDelivery(request: BotGroupDeliveryRecoveryRequest): Promise<BotGroupDeliveryRecoveryValue> {
    return this.groups.recoverDelivery(request)
  }

  /**
   * Record one shared-group Session's exact model claim.
   * @param groupId - group containing the delivery.
   * @param botId - Bot whose Session claimed the delivery.
   * @param claims - message claims observed in the model step.
   * @param turn - model turn number.
   * @param step - model step number.
   * @param isolated - whether the step retained shared-group isolation.
   * @param competingInput - whether competing input invalidated prior isolated claims.
   */
  async recordSharedGroupMessageClaims(
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    claims: readonly import('./group-chat.ts').BotGroupDeliveryClaimInput[],
    turn: number,
    step: number,
    isolated: boolean,
    competingInput: boolean,
  ): Promise<void> {
    await this.groups.recordBotMessageClaims(groupId, botId, claims, turn, step, isolated, competingInput)
  }

  /**
   * Record one visible shared-group Bot response.
   * @param groupId - group containing the delivery.
   * @param botId - responding Bot.
   * @param turn - model turn number.
   * @param step - model step number.
   * @param text - visible response text.
   * @param sourceMessageId - source message identity used for idempotency.
   */
  async recordSharedGroupResponse(
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    turn: number,
    step: number,
    text: string,
    sourceMessageId: string,
  ): Promise<void> {
    await this.groups.recordBotResponse(groupId, botId, turn, step, text, sourceMessageId)
  }

  /**
   * Record one safe shared-group Bot turn failure.
   * @param groupId - group containing the delivery.
   * @param botId - Bot whose turn failed.
   * @param turn - model turn number.
   * @param error - bounded failure text shown in the delivery status.
   */
  async recordSharedGroupTurnFailure(groupId: ReturnType<typeof BotGroupId>, botId: BotId, turn: number, error: string): Promise<void> {
    await this.groups.recordBotTurnFailure(groupId, botId, turn, error)
  }

  private async readPrivateSessionSnapshot(signal?: AbortSignal): Promise<SharedPrivateSessionSnapshot> {
    const extension = await raceSharedAbort(
      this.authority.readExtension(SHARED_PRIVATE_SESSIONS_EXTENSION_KEY),
      signal,
    )
    signal?.throwIfAborted()
    const snapshot = parsePrivateSessionSnapshot(extension.value)
    this.replacePrivateSessionCache(snapshot.bindings)
    return snapshot
  }

  private async mutatePrivateSessions<T>(
    signal: AbortSignal | undefined,
    mutation: (
      bindings: readonly SharedPrivateSessionRecord[],
    ) => Promise<{ readonly bindings: readonly SharedPrivateSessionRecord[]; readonly value: T }>
      | { readonly bindings: readonly SharedPrivateSessionRecord[]; readonly value: T },
  ): Promise<T> {
    signal?.throwIfAborted()
    const result = await this.authority.mutateExtension(
      SHARED_PRIVATE_SESSIONS_EXTENSION_KEY,
      async (current) => {
        const snapshot = parsePrivateSessionSnapshot(current)
        signal?.throwIfAborted()
        const next = await mutation(snapshot.bindings)
        signal?.throwIfAborted()
        return {
          value: next,
          next: {
            version: SHARED_PRIVATE_SESSIONS_RECORD_VERSION,
            bindings: next.bindings,
          },
        }
      },
    )
    this.replacePrivateSessionCache(result.bindings)
    return result.value
  }

  private replacePrivateSessionCache(bindings: readonly SharedPrivateSessionRecord[]): void {
    this.privateSessionCache.clear()
    for (const binding of bindings) {
      const key = sessionKey(binding.botId, binding.principalId)
      if (binding.revokedAt === undefined && !this.completedRemoteCleanup.has(key)) this.privateSessionCache.set(key, binding)
    }
  }

  private async authoritativeSessionFor(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal?: AbortSignal,
    includePendingCleanup = false,
  ): Promise<SharedPrivateSessionValue | undefined> {
    const key = sessionKey(botId, principalId)
    if (!includePendingCleanup && (this.deferredRemoteCleanup.has(key) || this.completedRemoteCleanup.has(key))) return undefined
    const snapshot = await this.readPrivateSessionSnapshot(signal)
    const record = snapshot.bindings.find(binding =>
      binding.botId === botId && binding.principalId === principalId)
    return record === undefined || record.revokedAt !== undefined ? undefined : privateSessionValue(record)
  }

  private async deletePrivateSessionIfCurrent(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = sessionKey(botId, principalId)
    return this.mutatePrivateSessions(signal, async (bindings) => {
      const current = bindings.find(binding => membershipKey(binding.botId, binding.principalId) === key)
      if (current === undefined || current.sessionId !== sessionId) return { bindings, value: false }
      await this.privateSessions.delete(key)
      return {
        bindings: bindings.filter(binding => membershipKey(binding.botId, binding.principalId) !== key),
        value: true,
      }
    })
  }

  private async touchPrivateSession(
    binding: SharedPrivateSessionValue,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = sessionKey(binding.botId, binding.principalId)
    const updated: SharedPrivateSessionRecord = {
      ...binding,
      updatedAt: Math.max(this.now(), binding.updatedAt + 1),
    }
    await this.mutatePrivateSessions(signal, async (bindings) => {
      const current = bindings.find(candidate => membershipKey(candidate.botId, candidate.principalId) === key)
      if (current === undefined || current.sessionId !== binding.sessionId || current.revokedAt !== undefined) {
        throw new SharedServiceFault('gateway/conflict', 'shared Bot Session binding changed during chat')
      }
      await this.privateSessions.put(key, updated)
      return {
        bindings: bindings.map(candidate =>
          membershipKey(candidate.botId, candidate.principalId) === key ? updated : candidate),
        value: undefined,
      }
    })
  }

  /**
   * Dispatch one explicitly allowlisted shared-Bot endpoint.
   * @param endpoint - exact endpoint name from {@link SHARED_BOT_ENDPOINTS}.
   * @param payload - untrusted decoded request payload.
   * @param signal - request cancellation signal.
   * @param peer - identity-authenticated shared Peer.
   * @returns a safe carrier-neutral RPC result.
   */
  async handle(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    peer: Parameters<ConnectionRpcHandler>[3],
  ): Promise<ConnectionRpcHandlerResult> {
    if (!SHARED_BOT_ENDPOINTS.some(candidate => candidate === endpoint)) {
      return failure('gateway/forbidden', 'shared Bot endpoint is not allowed')
    }
    if (this.stopping) return failure('gateway/unavailable', 'shared Bot service is stopping')
    const sharedPrincipal = sharedPrincipalOf(peer)
    if (sharedPrincipal === undefined) return failure('gateway/forbidden', 'shared Bot identity is required')
    const principalId = BotPrincipalId(String(sharedPrincipal))
    const sessionExpiresAt = sharedSessionExpiresAt(peer)
    if (sessionExpiresAt === undefined) return failure('gateway/forbidden', 'shared Bot session is required')
    const revocationSignal = sharedRevocationSignal(peer)
    if (revocationSignal?.aborted) return failure('gateway/forbidden', 'shared Bot identity is no longer active')
    const botId = sharedBotIdFromPayload(endpoint, payload)
    const requestController = new AbortController()
    const completed = Promise.withResolvers<void>()
    const abortRequest = (): void => { requestController.abort() }
    signal.addEventListener('abort', abortRequest, { once: true })
    revocationSignal?.addEventListener('abort', abortRequest, { once: true })
    this.stoppingController.signal.addEventListener('abort', abortRequest, { once: true })
    if (signal.aborted || revocationSignal?.aborted === true) requestController.abort()
    const activeKey = botId === undefined ? undefined : requestKey(botId, principalId)
    this.activeRequestControllers.add(requestController)
    this.activeRequestCompletions.add(completed.promise)
    try {
      requestController.signal.throwIfAborted()
      await this.refreshMemberships(requestController.signal)
      requestController.signal.throwIfAborted()
      if (activeKey !== undefined) {
        const active = this.activeRequests.get(activeKey) ?? new Set<AbortController>()
        active.add(requestController)
        this.activeRequests.set(activeKey, active)
      }
      await this.prepareRevocation(endpoint, payload, principalId, requestController.signal)
      requestController.signal.throwIfAborted()
      return await this.serialize(
        () => this.dispatch(endpoint, payload, requestController.signal, principalId, sessionExpiresAt),
        requestController.signal,
      )
    } catch (error) {
      return faultResult(error)
    } finally {
      signal.removeEventListener('abort', abortRequest)
      revocationSignal?.removeEventListener('abort', abortRequest)
      this.stoppingController.signal.removeEventListener('abort', abortRequest)
      this.activeRequestControllers.delete(requestController)
      this.activeRequestCompletions.delete(completed.promise)
      if (activeKey !== undefined) {
        const active = this.activeRequests.get(activeKey)
        active?.delete(requestController)
        if (active?.size === 0) this.activeRequests.delete(activeKey)
      }
      completed.resolve()
    }
  }

  /** Close the service after queued mutations settle. */
  async dispose(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const request of [...this.activeRequestControllers]) request.abort()
    for (const requests of this.activeRequests.values()) {
      for (const request of [...requests]) request.abort()
    }
    this.stoppingController.abort()
    clearInterval(this.membershipPollTimer)
    await waitForTracked([...this.activeRequestCompletions])
    await waitForTracked([...this.activeFlushCompletions])
    await waitForTracked([...this.quarantinedSessions.values()])
    await waitForTracked(this.membershipRefresh === undefined ? [] : [this.membershipRefresh])
    await waitForTracked([this.chain])
    await this.groups.dispose()
    await waitForTracked([this.domain.close()])
  }

  private async dispatch(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
    sessionExpiresAt: number,
  ): Promise<ConnectionRpcHandlerResult> {
    switch (endpoint) {
      case 'bots/share/session':
        return {
          ok: true,
          value: { principalId: SharedPrincipalId(String(principalId)), expiresAt: sessionExpiresAt } satisfies SharedBotSessionValue,
        }
      case 'bots/share/list':
        return this.list(signal, principalId)
      case 'bots/share/read-profile':
        return this.readProfile(parsePayload(botIdPayload, payload), signal, principalId)
      case 'bots/share/read-private-chat':
        return this.readPrivateChat(parsePayload(botIdPayload, payload), signal, principalId)
      case 'bots/share/chat':
        return this.chat(parsePayload(chatPayload, payload), signal, principalId)
      case 'bots/share/manage-members':
        return this.manageMembers(parsePayload(manageMembersPayload, payload), signal, principalId)
      case 'bots/share/read-memory':
        return this.readMemory(parsePayload(botIdPayload, payload), signal, principalId)
      case 'bots/share/write-memory':
        return this.writeMemory(parsePayload(writeMemoryPayload, payload), signal, principalId)
      case 'bots/share/manage-memory':
        return this.manageMemory(parsePayload(manageMemoryPayload, payload), signal, principalId)
      case 'bots/share/list-groups':
        return this.listGroups(signal, principalId)
      case 'bots/share/create-group':
        return this.createGroup(parsePayload(groupCreatePayload, payload), signal, principalId)
      case 'bots/share/update-group':
        return this.updateGroup(parsePayload(groupUpdatePayload, payload), signal, principalId)
      case 'bots/share/inspect-group':
        return this.inspectGroup(parsePayload(groupIdPayload, payload), signal, principalId)
      case 'bots/share/send-group-message':
        return this.sendGroupMessage(parsePayload(groupSendPayload, payload), signal, principalId)
      case 'bots/share/manage-group-members':
        return this.manageGroupMembers(parsePayload(manageGroupMembersPayload, payload), signal, principalId)
      default:
        return failure('gateway/forbidden', 'shared Bot endpoint is not allowed')
    }
  }

  private async list(
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    signal.throwIfAborted()
    await this.host.listBots(signal)
    signal.throwIfAborted()
    await this.refreshMemberships(signal)
    signal.throwIfAborted()
    const currentBots = await this.host.listBots(signal)
    signal.throwIfAborted()
    const rows: SharedBotRosterEntry[] = []
    let memberSeen = false
    for (const bot of currentBots) {
      signal.throwIfAborted()
      const memberships = this.membershipsFor(bot.id)
      const roster = this.roster(bot.id, memberships)
      const member = memberships.find(candidate => candidate.principalId === principalId)
      if (member === undefined) continue
      memberSeen = true
      if (!authorizeBotShare(roster, { actor: principalId, operation: 'read-profile' }).allowed) {
        return failure('gateway/forbidden', 'shared Bot membership is not valid')
      }
      rows.push({ ...publicProfile(bot), role: member.role })
    }
    if (!memberSeen) return failure('gateway/forbidden', 'shared Bot membership is required')
    return { ok: true, value: { bots: rows } }
  }

  private async readProfile(
    payload: BotIdPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    signal.throwIfAborted()
    this.requireAuthorization(payload.botId, principalId, 'read-profile')
    await this.findBotOrFault(payload.botId, signal)
    signal.throwIfAborted()
    await this.refreshMemberships(signal)
    signal.throwIfAborted()
    this.requireAuthorization(payload.botId, principalId, 'read-profile')
    const currentBot = await this.findBotOrFault(payload.botId, signal)
    return { ok: true, value: { bot: publicProfile(currentBot) } }
  }

  private async readPrivateChat(
    payload: BotIdPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    this.requireAuthorization(payload.botId, principalId, 'read-private-chat', principalId)
    await this.requireBot(payload.botId, signal)
    signal.throwIfAborted()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const binding = await this.authoritativeSessionFor(payload.botId, principalId, signal)
      if (binding === undefined) {
        await this.requireBot(payload.botId, signal)
        return { ok: true, value: { botId: payload.botId, recent: [] } }
      }
      let inspection: BotCollaborationInspection
      try {
        await this.host.validatePrivateSession(binding.sessionId, signal)
        inspection = await this.host.inspectPrivateSession(binding.sessionId, signal)
      } catch (error: unknown) {
        if (!isMissingPrivateSessionError(error)) throw error
        const removed = await this.deletePrivateSessionIfCurrent(
          payload.botId,
          principalId,
          binding.sessionId,
          signal,
        )
        if (!removed && attempt === 0) continue
        signal.throwIfAborted()
        await this.refreshMemberships(signal)
        signal.throwIfAborted()
        this.requireAuthorization(payload.botId, principalId, 'read-private-chat', principalId)
        await this.requireBot(payload.botId, signal)
        return { ok: true, value: { botId: payload.botId, recent: [] } }
      }
      signal.throwIfAborted()
      await this.refreshMemberships(signal)
      signal.throwIfAborted()
      this.requireAuthorization(payload.botId, principalId, 'read-private-chat', principalId)
      await this.requireBot(payload.botId, signal)
      return {
        ok: true,
        value: { botId: payload.botId, sessionId: binding.sessionId, recent: projectBotTranscript(inspection.events) },
      }
    }
    throw new SharedServiceFault('gateway/internal', 'shared Bot transcript is unavailable')
  }

  private async readMemory(
    payload: BotIdPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    signal.throwIfAborted()
    this.requireAuthorization(payload.botId, principalId, 'read-memory')
    const extension = await raceSharedAbort(
      this.authority.readExtension(SHARED_MEMBERSHIP_EXTENSION_KEY),
      signal,
    )
    signal.throwIfAborted()
    const snapshot = parseMembershipSnapshot(extension.value)
    const authorityPrincipal = extension.state.principals.find(candidate => String(candidate.id) === String(principalId))
    if (authorityPrincipal === undefined || authorityPrincipal.revokedAt !== undefined) {
      throw new SharedServiceFault('gateway/forbidden', 'shared Bot authority is no longer active')
    }
    this.requireAuthorizationForMemberships(snapshot.memberships, payload.botId, principalId, 'read-memory')
    await this.requireBot(payload.botId, signal)
    const memory = snapshot.sharedMemory ?? emptySharedMemorySnapshot()
    const policy = memoryPolicyFor(memory, payload.botId)
    const value = memoryValueFor(memory, payload.botId, policy)
    await this.requireBot(payload.botId, signal)
    return { ok: true, value }
  }

  private async writeMemory(
    payload: WriteMemoryPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    signal.throwIfAborted()
    this.requireAuthorization(payload.botId, principalId, 'write-memory')
    const value = await this.mutateSharedMemory(
      payload.botId,
      signal,
      principalId,
      'write-memory',
      (memory) => {
        const policy = memoryPolicyFor(memory, payload.botId)
        if (!policy.enabled) {
          throw new SharedServiceFault('gateway/forbidden', 'shared Bot context is disabled')
        }
        const botEntryCount = memory.entries.filter(entry => entry.botId === payload.botId).length
        if (botEntryCount >= SHARED_MEMORY_MAX_ENTRIES_PER_BOT) {
          throw new SharedServiceFault('gateway/unavailable', 'shared Bot context reached its per-Bot limit')
        }
        if (memory.entries.length >= SHARED_MEMORY_MAX_ENTRIES) {
          throw new SharedServiceFault('gateway/unavailable', 'shared Bot context is full')
        }
        const entry: SharedMemoryEntry = {
          id: BotShareMemoryId(`memory-${randomUUID()}`),
          botId: payload.botId,
          principalId,
          text: payload.text,
          createdAt: this.now(),
        }
        return {
          memory: { ...memory, entries: [...memory.entries, entry] },
          value: { entry: memoryEntryValue(entry) },
        }
      },
    )
    await this.requireBot(payload.botId, signal)
    return { ok: true, value }
  }

  private async manageMemory(
    payload: ManageMemoryPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    signal.throwIfAborted()
    this.requireAuthorization(payload.botId, principalId, 'manage-memory')
    const value = await this.mutateSharedMemory(
      payload.botId,
      signal,
      principalId,
      'manage-memory',
      (memory) => {
        const currentPolicy = memory.policies.find(candidate => candidate.botId === payload.botId)
        if (currentPolicy === undefined && memory.policies.length >= SHARED_MEMORY_MAX_POLICIES) {
          throw new SharedServiceFault('gateway/unavailable', 'shared Bot context policy limit reached')
        }
        const policy = { botId: payload.botId, enabled: payload.enabled, updatedAt: this.now() }
        return {
          memory: {
            policies: [
              ...memory.policies.filter(candidate => candidate.botId !== payload.botId),
              policy,
            ],
            entries: payload.enabled
              ? memory.entries
              : memory.entries.filter(entry => entry.botId !== payload.botId),
          },
          value: policy,
        }
      },
    )
    await this.requireBot(payload.botId, signal)
    return { ok: true, value }
  }

  private async listGroups(
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    return { ok: true, value: await this.groups.list(principalId, signal) }
  }

  private async createGroup(
    payload: GroupCreatePayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    const request: BotGroupCreateRequest = {
      name: payload.name,
      botIds: payload.botIds,
      ...(payload.id === undefined ? {} : { id: payload.id }),
    }
    const result = await this.groups.create(request, principalId, signal)
    return { ok: true, value: result }
  }

  private async updateGroup(
    payload: GroupUpdatePayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    const result = await this.groups.update(payload, principalId, signal)
    return { ok: true, value: result }
  }

  private async inspectGroup(
    payload: GroupIdPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    const result = await this.groups.inspect(payload.groupId, principalId, signal)
    return { ok: true, value: result }
  }

  private async sendGroupMessage(
    payload: GroupSendPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    const request: BotGroupSendRemoteRequest = {
      groupId: payload.groupId,
      text: payload.text,
      ...(payload.messageId === undefined ? {} : { messageId: payload.messageId }),
      ...(payload.targetBotIds === undefined ? {} : { targetBotIds: payload.targetBotIds }),
    }
    const result = await this.groups.send(request, principalId, signal)
    return { ok: true, value: result }
  }

  private async manageGroupMembers(
    payload: ManageGroupMembersPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    if (payload.action === 'create-invite') {
      const invite = await this.groups.createInvite(payload.groupId, principalId)
      return { ok: true, value: { code: invite.code, expiresAt: invite.expiresAt } }
    }
    if (payload.principalId === undefined) throw new SharedServiceFault('gateway/bad-request', 'principalId is required')
    const result = await this.groups.revokeMember(payload.groupId, payload.principalId, principalId, signal)
    return { ok: true, value: result }
  }

  private async chat(
    payload: ChatPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    this.requireAuthorization(payload.botId, principalId, 'chat')
    const bot = await this.findBotOrFault(payload.botId, signal)
    signal.throwIfAborted()
    let binding = await this.ensureSession(bot, principalId, signal)
    const key = sessionKey(payload.botId, principalId)
    const repairBinding = async (): Promise<void> => {
      const removed = await this.deletePrivateSessionIfCurrent(payload.botId, principalId, binding.sessionId, signal)
      if (!removed) {
        const current = await this.authoritativeSessionFor(payload.botId, principalId, signal)
        if (current !== undefined) {
          binding = current
          return
        }
      }
      signal.throwIfAborted()
      await this.refreshMemberships(signal)
      signal.throwIfAborted()
      this.requireAuthorization(payload.botId, principalId, 'chat')
      binding = await this.ensureSession(bot, principalId, signal)
      await this.refreshMemberships(signal)
      this.requireAuthorization(payload.botId, principalId, 'chat')
      signal.throwIfAborted()
    }
    // Membership may have been revoked while the private Session was being
    // created. Re-check before resolving the Agent and before emitting a turn.
    await this.refreshMemberships(signal)
    this.requireAuthorization(payload.botId, principalId, 'chat')
    signal.throwIfAborted()
    let resolved: Awaited<ReturnType<SharedBotHost['resolvePrivateAgent']>> | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        resolved = await this.host.resolvePrivateAgent(binding.sessionId, signal, binding.botId)
      } catch (error: unknown) {
        if (!isMissingPrivateSessionError(error) || attempt === 1) throw error
        await repairBinding()
        continue
      }
      if (!('error' in resolved) || !isMissingPrivateSessionError(resolved.error) || attempt === 1) break
      await repairBinding()
    }
    if (resolved === undefined || 'error' in resolved) {
      throw new SharedServiceFault('gateway/internal', 'shared Bot Session is unavailable')
    }
    const cancelAndWait = (): Promise<boolean> => this.cancelResolvedAgent(resolved.agent, key)
    if (signal.aborted) {
      await cancelAndWait()
      signal.throwIfAborted()
    }
    signal.throwIfAborted()
    let cancelledIdle: Promise<void> | undefined
    const cancelOnAbort = (): void => { cancelledIdle = cancelAndWait().then(() => undefined) }
    signal.addEventListener('abort', cancelOnAbort, { once: true })
    try {
      const operation = await this.host.withBot(payload.botId, signal, async () => {
        signal.throwIfAborted()
        resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text: payload.text }], source: { kind: 'user' } }))
        await this.flushPrivateSession(binding.sessionId, signal)
        signal.throwIfAborted()
        await this.touchPrivateSession(binding, signal)
        return true as const
      })
      if (!operation.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
      const currentBot = await this.findBotOrFault(payload.botId, signal)
      signal.throwIfAborted()
      return { ok: true, value: { bot: publicProfile(currentBot), sessionId: binding.sessionId, accepted: true } }
    } catch (error: unknown) {
      if (cancelledIdle === undefined && !signal.aborted) {
        cancelledIdle = cancelAndWait().then(() => undefined)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', cancelOnAbort)
      if (cancelledIdle !== undefined) await cancelledIdle
    }
  }

  private async manageMembers(
    payload: ManageMembersPayload,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    this.requireAuthorization(payload.botId, principalId, 'manage-members')
    signal.throwIfAborted()
    if (payload.action === 'create-invite') {
      if (payload.role === undefined) throw new SharedServiceFault('gateway/bad-request', 'invite role is required')
      const invite = await this.createInviteImpl(payload.botId, payload.role, principalId, signal)
      return { ok: true, value: { code: invite.code, expiresAt: invite.expiresAt, role: payload.role } }
    }
    if (payload.principalId === undefined) throw new SharedServiceFault('gateway/bad-request', 'principalId is required')
    return {
      ok: true,
      value: await this.revokeMemberImpl(payload.botId, payload.principalId, principalId, signal),
    }
  }

  private async revokeMemberImpl(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    actor?: ReturnType<typeof BotPrincipalId>,
    signal?: AbortSignal,
  ): Promise<{ readonly botId: BotId; readonly principalId: ReturnType<typeof BotPrincipalId>; readonly revoked: true }> {
    const operation = await this.host.withBot(botId, signal, async () => {
      signal?.throwIfAborted()
      if (actor !== undefined) this.requireAuthorization(botId, actor, 'manage-members')
      const target = this.membershipSnapshot.find(member =>
        member.botId === botId && member.principalId === principalId)
      if (target === undefined) throw new SharedServiceFault('gateway/not-found', 'shared Bot member was not found')
      if (target.role === 'owner') throw new SharedServiceFault('gateway/forbidden', 'the shared Bot owner cannot be revoked')
      const cleanupKey = sessionKey(botId, principalId)
      this.deferredRemoteCleanup.add(cleanupKey)
      let committedTarget: SharedMembershipRecord
      try {
        committedTarget = await this.updateMemberships((memberships, authorityState) => {
          signal?.throwIfAborted()
          const currentTarget = memberships.find(member =>
            member.botId === botId && member.principalId === principalId)
          if (currentTarget === undefined) {
            throw new SharedServiceFault('gateway/not-found', 'shared Bot member was not found')
          }
          if (currentTarget.role === 'owner') {
            throw new SharedServiceFault('gateway/forbidden', 'the shared Bot owner cannot be revoked')
          }
          if (currentTarget.createdAt !== target.createdAt
            || currentTarget.updatedAt !== target.updatedAt
            || currentTarget.role !== target.role
            || String(currentTarget.grantedBy) !== String(target.grantedBy)) {
            throw new SharedServiceFault('gateway/conflict', 'shared Bot membership changed during revocation')
          }
          if (actor !== undefined) {
            const authorityPrincipal = authorityState.principals.find(principal => String(principal.id) === String(actor))
            if (authorityPrincipal === undefined || authorityPrincipal.revokedAt !== undefined) {
              throw new SharedServiceFault('gateway/forbidden', 'shared Bot authority is no longer active')
            }
            this.requireAuthorizationForMemberships(memberships, botId, actor, 'manage-members')
            signal?.throwIfAborted()
          }
          return {
            memberships: memberships.filter(member =>
              !(member.botId === botId && member.principalId === currentTarget.principalId)),
            value: currentTarget,
          }
        })
      } catch (error) {
        this.deferredRemoteCleanup.delete(cleanupKey)
        throw error
      }
      const binding = await this.authoritativeSessionFor(botId, committedTarget.principalId, undefined, true)
      // Membership removal is already committed in the authority extension. A
      // later actor revocation must not leave the membership row behind. The
      // private binding is retained when Agent quiescence cannot be proven so a
      // later membership refresh can retry cleanup without losing the identity.
      let quiescent = binding === undefined
      try {
        if (binding !== undefined) {
          this.revokedBindings.set(cleanupKey, {
            ...binding,
            revokedAt: Math.max(this.now(), binding.updatedAt),
          })
          await this.markPrivateSessionRevoked(botId, committedTarget.principalId, binding.sessionId)
        }
        this.cancelActive(botId, committedTarget.principalId)
        if (binding !== undefined) {
          quiescent = await this.cancelAgent(
            binding.sessionId,
            sessionKey(botId, committedTarget.principalId),
            botId,
          )
        }
      } finally {
        try {
          await this.removeMembershipMirrorIfUnclaimed(botId, committedTarget.principalId)
        } finally {
          if (quiescent) {
            this.deferredRemoteCleanup.delete(cleanupKey)
            this.revokedBindings.delete(cleanupKey)
            this.privateSessionCache.delete(cleanupKey)
            if (binding !== undefined) this.completedRemoteCleanup.add(cleanupKey)
            else this.completedRemoteCleanup.delete(cleanupKey)
          }
        }
      }
      if (!quiescent) {
        throw new SharedServiceFault('gateway/unavailable', 'shared Bot Session cleanup is still in progress')
      }
      signal?.throwIfAborted()
      return { botId, principalId: committedTarget.principalId, revoked: true as const }
    })
    if (!operation.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
    return operation.value
  }

  private async markPrivateSessionRevoked(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    sessionId: SessionId,
  ): Promise<void> {
    const key = sessionKey(botId, principalId)
    await this.mutatePrivateSessions(undefined, async (bindings) => {
      const current = bindings.find(binding => membershipKey(binding.botId, binding.principalId) === key)
      if (current === undefined || current.sessionId !== sessionId || current.revokedAt !== undefined) {
        return { bindings, value: undefined }
      }
      const revoked: SharedPrivateSessionRecord = {
        ...current,
        revokedAt: Math.max(this.now(), current.updatedAt),
      }
      await this.privateSessions.put(key, revoked)
      return {
        bindings: bindings.map(binding => binding === current ? revoked : binding),
        value: undefined,
      }
    })
  }

  private async ensureSession(
    bot: BotView,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal?: AbortSignal,
  ): Promise<SharedPrivateSessionValue> {
    const operation = await this.host.withBot(bot.id, signal, current =>
      this.ensureSessionForBot(current, principalId, signal))
    if (!operation.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
    return operation.value
  }

  private async ensureSessionForBot(
    bot: BotView,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal?: AbortSignal,
  ): Promise<SharedPrivateSessionValue> {
    const key = sessionKey(bot.id, principalId)
    if (this.quarantinedSessions.has(key) || this.deferredRemoteCleanup.has(key)) {
      throw new SharedServiceFault('gateway/unavailable', 'shared Bot Session cleanup is still in progress')
    }
    if (this.quarantineRetries.delete(key)) {
      signal?.throwIfAborted()
      const previous = this.sessionFor(bot.id, principalId)
      if (previous !== undefined && !await this.cancelAgent(previous.sessionId, key, bot.id)) {
        throw new SharedServiceFault('gateway/unavailable', 'shared Bot Session cleanup is still in progress')
      }
      signal?.throwIfAborted()
    }
    const current = await this.authoritativeSessionFor(bot.id, principalId, signal)
    if (current !== undefined) return current
    const now = this.now()
    const sessionId = SessionId(`shared-session-${randomUUID()}`)
    const record: SharedPrivateSessionRecord = {
      botId: bot.id,
      principalId,
      sessionId,
      createdAt: now,
      updatedAt: now,
    }
    let created: Pick<Agent, 'id' | 'cancel' | 'whenIdle'> | undefined
    let cancellationStarted = false
    try {
      created = await this.host.createPrivateSession(bot, sessionId, String(principalId), signal) ?? undefined
      signal?.throwIfAborted()
      const committed = await this.mutatePrivateSessions(signal, async (bindings) => {
        const existing = bindings.find(binding =>
          binding.botId === bot.id && binding.principalId === principalId && binding.revokedAt === undefined)
        if (existing !== undefined) return { bindings, value: { binding: existing, created: false } }
        const stale = bindings.filter(binding =>
          binding.botId === bot.id && binding.principalId === principalId && binding.revokedAt !== undefined)
        this.deferredRemoteCleanup.delete(key)
        this.completedRemoteCleanup.delete(key)
        this.revokedBindings.delete(key)
        await this.privateSessions.put(sessionKey(bot.id, principalId), record)
        return {
          bindings: [...bindings.filter(binding => !stale.includes(binding)), record],
          value: { binding: record, created: true },
        }
      })
      if (committed.created) return privateSessionValue(committed.binding)
      cancellationStarted = true
      const quiescent = created === undefined
        ? await this.cancelAgent(sessionId, key, bot.id)
        : await this.cancelResolvedAgent(created, key)
      if (!quiescent) throw new SharedServiceFault('gateway/unavailable', 'shared Bot Session cleanup is still in progress')
      return privateSessionValue(committed.binding)
    } catch (error) {
      if (cancellationStarted) throw error
      // Revocation or caller cancellation can arrive after the Host creates
      // the Agent but before the private binding is durable. Prefer the
      // returned exact Agent; a Host that cannot return it is resolved by id.
      const quiescent = created === undefined
        ? await this.cancelAgent(sessionId, key, bot.id)
        : await this.cancelResolvedAgent(created, key)
      if (!quiescent) {
        // Retain enough durable identity to let the next membership refresh
        // retry cancellation instead of orphaning the live Session.
        await this.mutatePrivateSessions(undefined, async (bindings) => {
          if (bindings.some(binding =>
            binding.botId === bot.id && binding.principalId === principalId)) {
            return { bindings, value: undefined }
          }
          await this.privateSessions.put(key, record)
          return { bindings: [...bindings, record], value: undefined }
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private cancelActive(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
    exceptSignal?: AbortSignal,
  ): void {
    for (const request of this.activeRequests.get(requestKey(botId, principalId)) ?? []) {
      if (exceptSignal !== undefined && request.signal === exceptSignal) continue
      request.abort()
    }
  }

  /** Wait for one private-session durability checkpoint without holding the shared request chain forever. */
  private async flushPrivateSession(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const completion = this.host.flushPrivateSession(sessionId, signal)
    this.activeFlushCompletions.add(completion)
    void completion.then(() => {
      this.activeFlushCompletions.delete(completion)
    }, () => {
      this.activeFlushCompletions.delete(completion)
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new SharedServiceFault('gateway/unavailable', 'shared Bot Session durability checkpoint timed out'))
      }, SHARED_FLUSH_TIMEOUT_MS)
      timer.unref()
    })
    try {
      await raceSharedAbort(Promise.race([completion, deadline]), signal)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async prepareRevocation(
    endpoint: string,
    payload: unknown,
    actor: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<void> {
    if (endpoint !== 'bots/share/manage-members') return
    const parsed = manageMembersPayload.safeParse(payload)
    if (!parsed.success || parsed.data.action !== 'revoke' || parsed.data.principalId === undefined) return
    signal.throwIfAborted()
    try {
      this.requireAuthorization(parsed.data.botId, actor, 'manage-members')
    } catch {
      return
    }
    await this.refreshMemberships(signal)
    signal.throwIfAborted()
    try {
      this.requireAuthorization(parsed.data.botId, actor, 'manage-members')
    } catch {
      return
    }
    const target = this.membershipSnapshot.find(member =>
      member.botId === parsed.data.botId && member.principalId === parsed.data.principalId)
    if (target === undefined || target.role === 'owner') return
    this.cancelActive(parsed.data.botId, target.principalId)
    const binding = await this.authoritativeSessionFor(parsed.data.botId, target.principalId, signal)
    if (binding !== undefined) {
      await this.cancelAgent(binding.sessionId, sessionKey(parsed.data.botId, target.principalId), parsed.data.botId)
    }
  }

  private async cancelAgent(sessionId: SessionId, quarantineKey?: string, botId?: BotId): Promise<boolean> {
    const cancellation = new AbortController()
    let releaseStopped: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => { releaseStopped = resolve })
    const abortOnStop = (): void => {
      cancellation.abort()
      releaseStopped?.()
    }
    if (this.stoppingController.signal.aborted) abortOnStop()
    else this.stoppingController.signal.addEventListener('abort', abortOnStop, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        cancellation.abort()
        resolve()
      }, SHARED_AGENT_CANCEL_TIMEOUT_MS)
      timer.unref()
    })
    const quiescence = Promise.resolve().then(async () => {
      const resolved = await this.host.resolvePrivateAgent(sessionId, cancellation.signal, botId)
      if ('agent' in resolved) {
        resolved.agent.cancel({ kind: 'parent' })
        await resolved.agent.whenIdle()
        return true
      }
      return false
    })
    const resolution = quiescence.then(agentFound => agentFound || !cancellation.signal.aborted, () => false)
    try {
      const quiescent = await Promise.race([
        resolution,
        deadline.then(() => false),
        stopped.then(() => false),
      ])
      if (!quiescent && quarantineKey !== undefined) {
        this.quarantineSession(quarantineKey, quiescence.then((agentFound) => {
          if (!agentFound) throw new Error('shared Bot Agent did not prove quiescence')
        }))
      }
      return quiescent
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.stoppingController.signal.removeEventListener('abort', abortOnStop)
      cancellation.abort()
    }
  }

  /** Cancel one exact Agent capability and report whether it became idle. */
  private async cancelResolvedAgent(
    agent: Pick<Agent, 'id' | 'cancel' | 'whenIdle'>,
    quarantineKey?: string,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, SHARED_AGENT_CANCEL_TIMEOUT_MS)
      timer.unref()
    })
    const quiescence = Promise.resolve().then(async () => {
      agent.cancel({ kind: 'parent' })
      await agent.whenIdle()
    })
    const resolution = quiescence.then(() => true, () => false)
    try {
      const quiescent = await Promise.race([resolution, deadline])
      if (!quiescent && quarantineKey !== undefined) this.quarantineSession(quarantineKey, quiescence)
      return quiescent
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Keep a non-idle private Session inaccessible until its Agent proves quiescence. */
  private quarantineSession(key: string, quiescence: Promise<void>): void {
    if (this.quarantinedSessions.has(key)) return
    const released = new Promise<void>((resolve) => {
      void quiescence.then(async () => {
        try {
          if (this.deferredRemoteCleanup.has(key)) {
            const binding = this.revokedBindings.get(key)
            if (binding !== undefined) this.revokedBindings.delete(key)
            this.completedRemoteCleanup.add(key)
            this.privateSessionCache.delete(key)
            this.deferredRemoteCleanup.delete(key)
          }
          this.quarantineRetries.delete(key)
        } catch {
          this.quarantineRetries.add(key)
        } finally {
          resolve()
          if (this.quarantinedSessions.get(key) === released) this.quarantinedSessions.delete(key)
        }
      }, () => {
        resolve()
        this.quarantineRetries.add(key)
        if (this.quarantinedSessions.get(key) === released) this.quarantinedSessions.delete(key)
      })
    })
    this.quarantinedSessions.set(key, released)
  }

  private async createInviteImpl(
    botId: BotId,
    role: BotShareRole,
    actor?: ReturnType<typeof BotPrincipalId>,
    signal?: AbortSignal,
  ): Promise<{ readonly code: SharedInviteCode; readonly expiresAt: number }> {
    const operation = await this.host.withBot(botId, signal, async () => {
      signal?.throwIfAborted()
      if (!BOT_SHARE_ROLES.includes(role)) throw new SharedServiceFault('gateway/bad-request', 'invalid shared Bot role')
      let persistedDigest: string | undefined
      let invite: { readonly code: SharedInviteCode; readonly expiresAt: number }
      try {
        invite = await this.authority.createInviteIf((authorityState, extensions) => {
          const snapshot = parseMembershipSnapshot(extensions[SHARED_MEMBERSHIP_EXTENSION_KEY])
          const memberships = snapshot.memberships.filter(member => member.botId === botId)
          const owner = memberships.find(member => member.role === 'owner')
          if (role === 'owner' && owner !== undefined) {
            throw new SharedServiceFault('gateway/bad-request', 'shared Bot already has an owner')
          }
          if (role !== 'owner' && owner === undefined) {
            throw new SharedServiceFault('gateway/bad-request', 'shared Bot must have an owner first')
          }
          if (actor !== undefined) {
            const principal = authorityState.principals.find(candidate => String(candidate.id) === String(actor))
            if (principal === undefined || principal.revokedAt !== undefined) {
              throw new SharedServiceFault('gateway/forbidden', 'shared Bot authority is no longer active')
            }
            this.requireAuthorizationForMemberships(snapshot.memberships, botId, actor, 'manage-members')
          }
          signal?.throwIfAborted()
        }, async (issued) => {
          signal?.throwIfAborted()
          const record: SharedInviteRecord = {
            digest: sharedInviteDigest(issued.code),
            botId,
            role,
            createdAt: this.now(),
            expiresAt: issued.expiresAt,
          }
          persistedDigest = record.digest
          await this.invites.put(record.digest, record)
          signal?.throwIfAborted()
        }, {
          botId: String(botId),
          role,
        })
      } catch (error) {
        const digest = persistedDigest
        if (digest !== undefined) {
          await this.withPairKeyMirrorWrite(() => this.invites.delete(digest)).catch(() => undefined)
        }
        if (signal?.aborted) throw error
        if (error instanceof SharedServiceFault) throw error
        throw new SharedServiceFault('gateway/internal', 'shared Bot invite could not be stored')
      }
      return invite
    })
    if (!operation.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
    return operation.value
  }

  private async requireBot(botId: BotId, signal?: AbortSignal): Promise<BotView> {
    return this.findBotOrFault(botId, signal)
  }

  private async findBotOrFault(botId: BotId, signal?: AbortSignal): Promise<BotView> {
    signal?.throwIfAborted()
    const bot = await this.host.findBot(botId, signal)
    signal?.throwIfAborted()
    if (bot === undefined) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
    return bot
  }

  private requireAuthorization(
    botId: BotId,
    actor: ReturnType<typeof BotPrincipalId>,
    operation: BotShareOperation,
    subject?: ReturnType<typeof BotPrincipalId>,
  ): SharedMembershipState {
    return this.requireAuthorizationForMemberships(this.membershipSnapshot, botId, actor, operation, subject)
  }

  private requireAuthorizationForMemberships(
    memberships: readonly SharedMembershipRecord[],
    botId: BotId,
    actor: ReturnType<typeof BotPrincipalId>,
    operation: BotShareOperation,
    subject?: ReturnType<typeof BotPrincipalId>,
  ): SharedMembershipState {
    const botMemberships = memberships.filter(member => member.botId === botId)
    const roster = this.roster(botId, botMemberships)
    const actorMembership = botMemberships.find(member => member.principalId === actor)
    if (actorMembership === undefined) throw new SharedServiceFault('gateway/forbidden', 'shared Bot membership is required')
    const decision = authorizeBotShare(roster, { actor, operation, ...(subject === undefined ? {} : { subject }) })
    if (!decision.allowed) throw new SharedServiceFault('gateway/forbidden', 'shared Bot operation is not permitted')
    return { roster, actor: actorMembership }
  }

  private membershipsFor(botId: BotId): SharedMembershipRecord[] {
    return this.membershipSnapshot.filter(value => value.botId === botId)
  }

  private roster(botId: BotId, memberships: readonly SharedMembershipRecord[]): SharedMembershipState['roster'] {
    return { botId, memberships }
  }

  private serialize<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopping) return Promise.reject(new SharedServiceFault('gateway/unavailable', 'shared Bot service is stopping'))
    const pending = this.chain.then(async () => {
      await this.refreshMemberships(signal)
      signal?.throwIfAborted()
      return work()
    })
    this.chain = pending.catch(() => undefined)
    return pending
  }

  private scheduleMembershipRefresh(): void {
    if (this.stopping || this.membershipRefresh !== undefined) return
    const pending = this.readMemberships(this.stoppingController.signal)
    this.membershipRefresh = pending
    void pending.then(() => {
      if (this.membershipRefresh === pending) this.membershipRefresh = undefined
    }, (error: unknown) => {
      if (this.membershipRefresh === pending) this.membershipRefresh = undefined
      this.owner.logger.warn(`bots: shared membership refresh failed: ${String(error)}`)
    })
  }

  private async refreshMemberships(signal?: AbortSignal): Promise<void> {
    const pending = this.membershipRefresh
    if (pending !== undefined) await raceSharedAbort(pending, signal)
    await this.readMemberships(signal)
  }

  private async readMemberships(signal?: AbortSignal): Promise<void> {
    const extension = await raceSharedAbort(
      this.authority.readExtension(SHARED_MEMBERSHIP_EXTENSION_KEY),
      signal,
    )
    signal?.throwIfAborted()
    const next = parseMembershipSnapshot(extension.value).memberships
    signal?.throwIfAborted()
    const current = this.membershipSnapshot
    this.membershipSnapshot = next
    signal?.throwIfAborted()
    const retained = new Set(next.map(member => membershipKey(member.botId, member.principalId)))
    const removedMembers = current.filter(member => !retained.has(membershipKey(member.botId, member.principalId)))
    const privateSessionSnapshot = await this.readPrivateSessionSnapshot(signal)
    const staleBindings = privateSessionSnapshot.bindings
      .filter(binding => !retained.has(membershipKey(binding.botId, binding.principalId)))
    const cleanupKeys = new Set<string>()
    for (const removed of removedMembers) {
      this.cancelActive(removed.botId, removed.principalId, signal)
      cleanupKeys.add(sessionKey(removed.botId, removed.principalId))
    }
    for (const binding of staleBindings) {
      this.cancelActive(binding.botId, binding.principalId, signal)
      cleanupKeys.add(sessionKey(binding.botId, binding.principalId))
    }
    await Promise.all([...cleanupKeys].map(async (key) => {
      const binding = privateSessionSnapshot.bindings.find(candidate =>
        membershipKey(candidate.botId, candidate.principalId) === key)
      if (binding === undefined) return
      this.revokedBindings.set(key, {
        ...binding,
        revokedAt: binding.revokedAt ?? Math.max(this.now(), binding.updatedAt),
      })
      await this.markPrivateSessionRevoked(binding.botId, binding.principalId, binding.sessionId)
      if (this.deferredRemoteCleanup.has(key) || this.completedRemoteCleanup.has(key)) return
      const quiescent = await this.cancelAgent(
        binding.sessionId,
        sessionKey(binding.botId, binding.principalId),
        binding.botId,
      )
      if (quiescent) {
        this.deferredRemoteCleanup.delete(key)
        this.completedRemoteCleanup.add(key)
        this.revokedBindings.delete(key)
      }
    }))
  }

  private async updateMemberships<T>(
    mutation: (memberships: readonly SharedMembershipRecord[], authorityState: SharedAccessStateSnapshot) => {
      readonly memberships: readonly SharedMembershipRecord[]
      readonly value: T
    } | Promise<{
      readonly memberships: readonly SharedMembershipRecord[]
      readonly value: T
    }>,
  ): Promise<T> {
    const result = await this.authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, (current, authorityState) => {
      const snapshot = parseMembershipSnapshot(current)
      return Promise.resolve(mutation(snapshot.memberships, authorityState)).then(next => ({
        value: { memberships: next.memberships, value: next.value },
        next: {
          ...snapshot,
          memberships: next.memberships,
        },
      }))
    })
    this.membershipSnapshot = result.memberships
    return result.value
  }

  /**
   * Serialize one membership/invite mirror write with pair-key migration and
   * every other current Host mirror writer. The callback must only touch the
   * already-open storage table; it must not call another authority mutation
   * or inspect a Bot while the credential record is exclusive.
   * @param operation - one bounded durable table mutation.
   * @returns the table mutation result after the authority fence commits.
   */
  private async withPairKeyMirrorWrite<T>(operation: () => Promise<T>): Promise<T> {
    return this.authority.mutateExtension(SHARED_PAIR_KEY_MIGRATION_EXTENSION_KEY, async (current) => {
      if (current !== undefined && !sharedPairKeyMigrationSchema.safeParse(current).success) {
        throw new Error('shared Bot pair-key migration marker is invalid')
      }
      const value = await operation()
      return {
        value,
        next: { version: SHARED_PAIR_KEY_MIGRATION_VERSION },
      }
    })
  }

  /**
   * Remove one revoked membership row only while the authority still proves
   * that no later enrollment has restored the membership. The table handle is
   * Host-local, so the decision must come from the credential record rather
   * than a cached table read.
   * @param botId - Bot whose stale row may be removed.
   * @param principalId - principal whose membership was revoked.
   * @returns completion after the fenced reconciliation.
   */
  private async removeMembershipMirrorIfUnclaimed(
    botId: BotId,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<void> {
    await this.authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, async (current) => {
      const snapshot = parseMembershipSnapshot(current)
      if (snapshot.memberships.some(member => member.botId === botId && member.principalId === principalId)) {
        return { value: undefined, next: current }
      }
      await this.memberships.delete(membershipKey(botId, principalId))
      return { value: undefined, next: current }
    })
  }

  private async mutateSharedMemory<T>(
    botId: BotId,
    signal: AbortSignal | undefined,
    actor: ReturnType<typeof BotPrincipalId> | undefined,
    operation: BotShareOperation | undefined,
    mutation: (memory: SharedMemorySnapshot) => {
      readonly memory: SharedMemorySnapshot
      readonly value: T
    },
  ): Promise<T> {
    signal?.throwIfAborted()
    const operationResult = await this.host.withBot(botId, signal, async () => {
      const result = await this.authority.mutateExtension(
        SHARED_MEMBERSHIP_EXTENSION_KEY,
        async (current, authorityState) => {
          const snapshot = parseMembershipSnapshot(current)
          if (actor !== undefined && operation !== undefined) {
            const authorityPrincipal = authorityState.principals.find(principal => String(principal.id) === String(actor))
            if (authorityPrincipal === undefined || authorityPrincipal.revokedAt !== undefined) {
              throw new SharedServiceFault('gateway/forbidden', 'shared Bot authority is no longer active')
            }
            this.requireAuthorizationForMemberships(snapshot.memberships, botId, actor, operation)
          }
          signal?.throwIfAborted()
          const next = mutation(snapshot.sharedMemory ?? emptySharedMemorySnapshot())
          signal?.throwIfAborted()
          const parsedMemory = sharedMemorySnapshotSchema.safeParse(next.memory)
          if (!parsedMemory.success) {
            throw new SharedServiceFault('gateway/unavailable', 'shared Bot context limits were exceeded')
          }
          return {
            value: { memberships: snapshot.memberships, value: next.value },
            next: { ...snapshot, sharedMemory: parsedMemory.data },
          }
        },
      )
      this.membershipSnapshot = result.memberships
      return result.value
    })
    if (!operationResult.found) throw new SharedServiceFault('bot/not-found', 'shared Bot was not found')
    return operationResult.value
  }

}

async function initializeMembershipSnapshot(
  authority: SharedAccessAuthority,
  credentials: CredentialProvider,
  table: KvTable<string, SharedMembershipRecord>,
): Promise<readonly SharedMembershipRecord[]> {
  const extension = await authority.readExtension(SHARED_MEMBERSHIP_EXTENSION_KEY)
  if (extension.value !== undefined) return parseMembershipSnapshot(extension.value).memberships
  const legacy = await credentials.modifyRecord(SHARED_MEMBERSHIP_RECORD_KEY, (current) => {
    if (current !== undefined) {
      parseLegacyMembershipSnapshot(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({
      kind: 'grant',
      payload: {
        version: SHARED_MEMBERSHIP_RECORD_VERSION,
        memberships: [...table.entries()].map(([, membership]) => membership),
      },
    })
  })
  const memberships = parseLegacyMembershipSnapshot(legacy).memberships
  return authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, (current) => {
    if (current !== undefined) {
      return { value: parseMembershipSnapshot(current).memberships, next: current }
    }
    return {
      value: memberships,
      next: { version: SHARED_MEMBERSHIP_RECORD_VERSION, memberships },
    }
  })
}

async function initializePrivateSessionSnapshot(
  authority: SharedAccessAuthority,
  table: KvTable<string, SharedPrivateSessionRecord>,
): Promise<SharedPrivateSessionSnapshot> {
  return authority.mutateExtension(SHARED_PRIVATE_SESSIONS_EXTENSION_KEY, (current) => {
    if (current !== undefined) {
      return { value: parsePrivateSessionSnapshot(current), next: current }
    }
    const bindings = [...table.entries()].map(([, binding]) => binding)
    const snapshot: SharedPrivateSessionSnapshot = {
      version: SHARED_PRIVATE_SESSIONS_RECORD_VERSION,
      bindings,
    }
    return { value: snapshot, next: snapshot }
  })
}

/** Reconcile invite mirror rows against the authority state while its lock is held. */
async function reconcileInviteMirror(
  table: KvTable<string, SharedInviteRecord>,
  authorityInvites: readonly { readonly digest: string; readonly expiresAt: number }[],
  now: number,
): Promise<void> {
  const active = new Set(authorityInvites
    .filter(invite => now < invite.expiresAt)
    .map(invite => invite.digest))
  for (const [key] of [...table.entries()]) {
    if (!active.has(key)) await table.delete(key)
  }
}

/**
 * Reconcile membership rows against the authority extension. A failed mirror
 * write may leave a row behind after the authority mutation rejects; stale
 * rows are never treated as grants and are removed on the next Host startup.
 */
async function reconcileMembershipMirror(
  authority: SharedAccessAuthority,
  table: KvTable<string, SharedMembershipRecord>,
): Promise<void> {
  await authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, async (current) => {
    const snapshot = parseMembershipSnapshot(current)
    const expected = new Map(snapshot.memberships.map(member => [membershipKey(member.botId, member.principalId), member]))
    for (const [storedKey, record] of [...table.entries()]) {
      const canonicalKey = membershipKey(record.botId, record.principalId)
      if (storedKey !== canonicalKey) throw new Error('shared Bot membership mirror key changed during reconciliation')
      const authoritative = expected.get(canonicalKey)
      if (authoritative === undefined) {
        await table.delete(storedKey)
      } else if (!isDeepStrictEqual(record, authoritative)) {
        await table.put(storedKey, authoritative)
      }
      expected.delete(canonicalKey)
    }
    for (const [key, record] of expected) await table.put(key, record)
    return { value: undefined, next: current }
  })
}

/** Reconcile private-Session mirror rows against their authority bindings. */
async function reconcilePrivateSessionMirror(
  authority: SharedAccessAuthority,
  table: KvTable<string, SharedPrivateSessionRecord>,
): Promise<void> {
  await authority.mutateExtension(SHARED_PRIVATE_SESSIONS_EXTENSION_KEY, async (current) => {
    const snapshot = parsePrivateSessionSnapshot(current)
    const expected = new Map(snapshot.bindings.map(binding => [sessionKey(binding.botId, binding.principalId), binding]))
    for (const [storedKey, record] of [...table.entries()]) {
      const canonicalKey = sessionKey(record.botId, record.principalId)
      if (storedKey !== canonicalKey) throw new Error('shared Bot private-Session mirror key changed during reconciliation')
      const authoritative = expected.get(canonicalKey)
      if (authoritative === undefined) {
        await table.delete(storedKey)
      } else if (!isDeepStrictEqual(record, authoritative)) {
        await table.put(storedKey, authoritative)
      }
      expected.delete(canonicalKey)
    }
    for (const [key, record] of expected) await table.put(key, record)
    return { value: undefined, next: current }
  })
}

function pendingBotInvite(
  digest: string,
  authorityInvites: SharedAccessStateSnapshot['invites'],
  mirror: SharedInviteRecord | undefined,
): PendingBotInvite | undefined {
  const authoritative = authorityInvites?.find(invite => invite.digest === digest)
  if (authorityInvites !== undefined && authoritative === undefined) return undefined
  if (authoritative === undefined) return mirror
  const metadata: SharedAccessInviteMetadata | undefined = authoritative.metadata
  if (metadata === undefined) {
    return mirror === undefined ? undefined : { ...mirror, expiresAt: authoritative.expiresAt }
  }
  const botId = metadata.botId
  const role = metadata.role
  if (botId === undefined || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(botId)
    || role === undefined || !BOT_SHARE_ROLES.some(candidate => candidate === role)) {
    throw new SharedServiceFault('gateway/internal', 'shared Bot invite association is invalid')
  }
  return {
    botId: BotId(botId),
    role: role as BotShareRole,
    expiresAt: authoritative.expiresAt,
  }
}

function parseMembershipSnapshot(value: unknown): SharedMembershipSnapshot {
  const parsed = sharedMembershipSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('shared Bot service membership snapshot is invalid')
  return parsed.data
}

function parsePrivateSessionSnapshot(value: unknown): SharedPrivateSessionSnapshot {
  const parsed = sharedPrivateSessionSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('shared Bot service private-session snapshot is invalid')
  const keys = new Set<string>()
  for (const binding of parsed.data.bindings) {
    const key = membershipKey(binding.botId, binding.principalId)
    if (keys.has(key)) throw new Error('shared Bot service private-session snapshot has duplicate bindings')
    keys.add(key)
  }
  return parsed.data
}

function emptySharedMemorySnapshot(): SharedMemorySnapshot {
  return { policies: [], entries: [] }
}

function memoryPolicyFor(
  memory: SharedMemorySnapshot | undefined,
  botId: BotId,
): BotShareMemoryPolicyValue {
  const policy = memory?.policies.find(candidate => candidate.botId === botId)
  return policy === undefined
    ? { botId, enabled: false, updatedAt: 0 }
    : { botId: policy.botId, enabled: policy.enabled, updatedAt: policy.updatedAt }
}

function memoryEntryValue(entry: SharedMemoryEntry): BotShareMemoryEntry {
  return {
    id: entry.id,
    principalId: entry.principalId,
    text: entry.text,
    createdAt: entry.createdAt,
  }
}

function memoryValueFor(
  memory: SharedMemorySnapshot,
  botId: BotId,
  policy: BotShareMemoryPolicyValue,
): BotShareMemoryValue {
  return {
    ...policy,
    entries: policy.enabled
      ? memory.entries.filter(entry => entry.botId === botId).map(memoryEntryValue)
      : [],
  }
}

function privateSessionValue(record: SharedPrivateSessionRecord): SharedPrivateSessionValue {
  return {
    botId: record.botId,
    principalId: record.principalId,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function parseLegacyMembershipSnapshot(record: CredentialRecord | undefined): { readonly memberships: readonly SharedMembershipRecord[] } {
  if (record === undefined || record.kind !== 'grant') {
    throw new Error('shared Bot service membership snapshot is missing or unsupported')
  }
  return parseMembershipSnapshot(record.payload)
}

function parsePayload<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new SharedServiceFault('gateway/bad-request', 'invalid shared Bot request')
  return parsed.data
}

function publicProfile(bot: BotView): SharedBotProfile {
  return {
    id: bot.id,
    name: bot.name,
    ...(bot.description === undefined ? {} : { description: bot.description }),
    identity: bot.identity,
    accent: bot.accent,
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
    state: bot.state,
    availability: bot.availability,
  }
}

const sharedPairKeyMigrationSchema = z.object({
  version: z.literal(SHARED_PAIR_KEY_MIGRATION_VERSION),
}).strict()

// These checks mirror the durable shared id schemas. The successor stores
// case-sensitive SHA-256 digests so its length is bounded and its path does
// not collide on case-insensitive filesystems.
const SHARED_BOT_ID_KEY_RE = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/
const SHARED_PRINCIPAL_ID_KEY_RE = /^principal-[A-Za-z0-9-]+$/
const SHARED_KEY_PREFIX = 'shared-v3_'
const SHARED_PREDECESSOR_KEY_PREFIX = 'shared-v2_'

function sharedIdentityKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function membershipKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  const bot = String(botId)
  const principal = String(principalId)
  if (!SHARED_BOT_ID_KEY_RE.test(bot) || !SHARED_PRINCIPAL_ID_KEY_RE.test(principal)) {
    throw new Error('shared Bot membership key contains an invalid identity')
  }
  return `${SHARED_KEY_PREFIX}${sharedIdentityKey(bot)}_${sharedIdentityKey(principal)}`
}

function predecessorMembershipKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  const bot = String(botId)
  const principal = String(principalId)
  if (!SHARED_BOT_ID_KEY_RE.test(bot) || !SHARED_PRINCIPAL_ID_KEY_RE.test(principal)) {
    throw new Error('shared Bot membership key contains an invalid identity')
  }
  return `${SHARED_PREDECESSOR_KEY_PREFIX}${bot}_${principal}`
}

function legacyMembershipKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  return `${encodeURIComponent(String(botId))}:${encodeURIComponent(String(principalId))}`
}

/** Rewrite predecessor pair keys with a bounded successor before service use. */
async function migrateSharedPairTable<T extends {
  readonly botId: BotId
  readonly principalId: ReturnType<typeof BotPrincipalId>
}>(table: KvTable<string, T>, tableName: string): Promise<void> {
  for (const [storedKey, record] of [...table.entries()]) {
    const canonicalKey = membershipKey(record.botId, record.principalId)
    if (storedKey === canonicalKey) continue
    if (storedKey !== predecessorMembershipKey(record.botId, record.principalId)
      && storedKey !== legacyMembershipKey(record.botId, record.principalId)) {
      throw new Error(`shared Bot ${tableName} has an invalid key '${storedKey}'`)
    }
    const canonical = table.get(canonicalKey)
    if (canonical !== undefined && !isDeepStrictEqual(canonical, record)) {
      throw new Error(`shared Bot ${tableName} has conflicting legacy and canonical records`)
    }
    if (canonical === undefined) await table.put(canonicalKey, record)
    const currentLegacy = table.get(storedKey)
    if (currentLegacy === undefined) continue
    if (!isDeepStrictEqual(currentLegacy, record)) {
      throw new Error(`shared Bot ${tableName} changed during key migration`)
    }
    await table.delete(storedKey)
  }
}

function sessionKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  return membershipKey(botId, principalId)
}

function requestKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  return sessionKey(botId, principalId)
}

function sharedBotIdFromPayload(endpoint: string, payload: unknown): BotId | undefined {
  if (endpoint === 'bots/share/list') return undefined
  if (!isRecord(payload)) return undefined
  const parsed = z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).safeParse(payload.botId)
  return parsed.success ? BotId(parsed.data) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPrivateSessionError(value: unknown): boolean {
  if (value instanceof ApiSessionNotFound) return true
  if (remoteErrorOf(value)?.code === 'session/not-found') return true
  return value instanceof Error && value.name === 'ApiSessionNotFound'
}

function failure(code: string, message: string): ConnectionRpcHandlerResult {
  return { ok: false, error: { code, message, details: {} } }
}

function faultResult(error: unknown): ConnectionRpcHandlerResult {
  if (error instanceof SharedServiceFault) return failure(error.code, error.message)
  if (error instanceof SharedGroupError) return failure(error.code, error.message)
  return failure('gateway/internal', 'shared Bot request failed')
}
