/** Authenticated shared-Bot endpoints and durable private-session routing. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@yharness/cordis'
import {
  SharedAccessAuthority,
  SharedInviteCode,
  SharedPrincipalId,
  sharedInviteDigest,
  sharedPrincipalOf,
  sharedRevocationSignal,
  type SharedAccessEnrollment,
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

/** Exact endpoint allowlist mounted on the collaborator-only route. */
export const SHARED_BOT_ENDPOINTS = [
  'bots/share/list',
  'bots/share/read-profile',
  'bots/share/read-private-chat',
  'bots/share/chat',
  'bots/share/manage-members',
  'bots/share/read-memory',
  'bots/share/write-memory',
  'bots/share/manage-memory',
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
export interface SharedBotHost {
  /** List the operator-owned Bots without exposing private Session data. */
  readonly listBots: (signal?: AbortSignal) => Promise<readonly BotView[]>
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
type BotIdPayload = z.infer<typeof botIdPayload>
type ChatPayload = z.infer<typeof chatPayload>
type ManageMembersPayload = z.infer<typeof manageMembersPayload>
type WriteMemoryPayload = z.infer<typeof writeMemoryPayload>
type ManageMemoryPayload = z.infer<typeof manageMemoryPayload>

const SHARED_MEMBERSHIP_RECORD_KEY = credentialKey('agent-bots', 'shared-memberships')
const SHARED_MEMBERSHIP_EXTENSION_KEY = 'agent-bots/shared-memberships'
const SHARED_PRIVATE_SESSIONS_EXTENSION_KEY = 'agent-bots/shared-private-sessions'
const SHARED_MEMBERSHIP_RECORD_VERSION = 1 as const
const SHARED_PRIVATE_SESSIONS_RECORD_VERSION = 1 as const
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
    const domain = await facility.open(sharedBotDomain)
    const credentials = options.credentials ?? owner.get('credentials')
    if (credentials === undefined) {
      await waitForTracked([domain.close()])
      throw new Error('shared Bot service requires a credential provider')
    }
    try {
      const membershipSnapshot = await initializeMembershipSnapshot(authority, credentials, domain.table('memberships'))
      const privateSessionSnapshot = await initializePrivateSessionSnapshot(authority, domain.table('private_sessions'))
      return new SharedBotService(owner, domain, authority, host, membershipSnapshot, privateSessionSnapshot, options)
    } catch (error) {
      await waitForTracked([domain.close()])
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
  async enroll(code: SharedInviteCode, request: ConnectionTrustRequest): Promise<SharedBotEnrollment> {
    return this.serialize(async () => {
      const digest = sharedInviteDigest(code)
      const pending = this.invites.get(digest)
      if (pending === undefined || this.now() >= pending.expiresAt) {
        if (pending !== undefined) await this.invites.delete(digest)
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
          await this.memberships.put(membershipKey(membership.botId, membership.principalId), membership)
          await this.updateMemberships((memberships) => {
            const existing = memberships.find(member =>
              member.botId === membership.botId && member.principalId === membership.principalId)
            if (existing !== undefined) {
              existingMembership = existing
              return { memberships, value: undefined }
            }
            if (membership.role === 'owner' && memberships.some(member =>
              member.botId === membership.botId && member.role === 'owner')) {
              throw new SharedServiceFault('gateway/bad-request', 'shared Bot already has an owner')
            }
            return { memberships: [...memberships, membership], value: undefined }
          })
          if (existingMembership !== undefined) {
            // The durable table write precedes the cross-host extension lock;
            // restore the authoritative row when another invite won the race.
            await this.memberships.put(
              membershipKey(existingMembership.botId, existingMembership.principalId),
              existingMembership,
            )
            if (existingMembership.role !== pending.role) {
              await this.invites.delete(digest)
              throw new SharedServiceFault('gateway/bad-request', 'shared Bot principal is already enrolled with a different role')
            }
          }
          await this.invites.delete(digest)
        } catch (error) {
          if (existingMembership !== undefined) {
            await this.memberships.put(
              membershipKey(existingMembership.botId, existingMembership.principalId),
              existingMembership,
            ).catch(() => undefined)
            if (error instanceof SharedServiceFault) throw error
            throw new SharedServiceFault('gateway/internal', 'shared Bot enrollment could not restore its existing membership')
          }
          await this.memberships.delete(membershipKey(membership.botId, membership.principalId)).catch(() => undefined)
          await this.removeMembershipSnapshot(membership.botId, membership.principalId).catch(() => undefined)
          await this.invites.delete(digest).catch(() => undefined)
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
        () => this.dispatch(endpoint, payload, requestController.signal, principalId),
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
    await waitForTracked([this.domain.close()])
  }

  private async dispatch(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<ConnectionRpcHandlerResult> {
    switch (endpoint) {
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
          await this.memberships.delete(membershipKey(botId, committedTarget.principalId))
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
      const invite = await this.authority.createInviteIf((authorityState, extensions) => {
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
      })
      try {
        signal?.throwIfAborted()
      } catch (error) {
        await this.authority.cancelInvite(invite.code).catch(() => undefined)
        throw error
      }
      const record: SharedInviteRecord = {
        digest: sharedInviteDigest(invite.code),
        botId,
        role,
        createdAt: this.now(),
        expiresAt: invite.expiresAt,
      }
      try {
        await this.invites.put(record.digest, record)
      } catch {
        await this.authority.cancelInvite(invite.code).catch(() => undefined)
        throw new SharedServiceFault('gateway/internal', 'shared Bot invite could not be stored')
      }
      try {
        signal?.throwIfAborted()
      } catch (error) {
        await this.invites.delete(record.digest).catch(() => undefined)
        await this.authority.cancelInvite(invite.code).catch(() => undefined)
        throw error
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
    },
  ): Promise<T> {
    const result = await this.authority.mutateExtension(SHARED_MEMBERSHIP_EXTENSION_KEY, (current, authorityState) => {
      const snapshot = parseMembershipSnapshot(current)
      const next = mutation(snapshot.memberships, authorityState)
      return {
        value: { memberships: next.memberships, value: next.value },
        next: {
          ...snapshot,
          memberships: next.memberships,
        },
      }
    })
    this.membershipSnapshot = result.memberships
    return result.value
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

  private async removeMembershipSnapshot(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): Promise<void> {
    await this.updateMemberships(memberships => ({
      memberships: memberships.filter(member => !(member.botId === botId && member.principalId === principalId)),
      value: undefined,
    }))
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

function membershipKey(botId: BotId, principalId: ReturnType<typeof BotPrincipalId>): string {
  return `${encodeURIComponent(String(botId))}:${encodeURIComponent(String(principalId))}`
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
  return failure('gateway/internal', 'shared Bot request failed')
}
