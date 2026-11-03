/** Shared Bot membership policy and private-conversation routing primitives. */

import { brandString, type Branded } from '@yharness/brand'
import type { SessionId } from '@yharness/session/types'
import type { BotId } from './types.ts'

/**
 * Canonical identity for one authenticated person in a shared Bot deployment.
 *
 * The Host must obtain this value from its authenticated identity provider. A
 * workspace id, browser-session token, Bot id, or shared link must never be
 * converted into a `BotPrincipalId`.
 */
export type BotPrincipalId = Branded<'BotPrincipalId'>

/**
 * Apply the principal brand to an id already authenticated and canonicalized
 * by the Host identity provider.
 * @param value - Authenticated provider-owned principal id.
 * @returns Branded principal id for policy checks and durable bindings.
 */
export function BotPrincipalId(value: string): BotPrincipalId {
  return brandString<BotPrincipalId>(value)
}

/** Roles supported by the shared Bot membership policy. */
export const BOT_SHARE_ROLES = ['owner', 'manager', 'collaborator'] as const

/** Shared Bot membership role. */
export type BotShareRole = typeof BOT_SHARE_ROLES[number]

/** Operations evaluated by the shared Bot policy. */
export const BOT_SHARE_OPERATIONS = [
  'read-profile',
  'chat',
  'manage-profile',
  'manage-members',
  'read-private-chat',
  'read-memory',
  'write-memory',
  'manage-memory',
  'read-group',
  'write-group',
] as const

/** Shared Bot operation. */
export type BotShareOperation = typeof BOT_SHARE_OPERATIONS[number]

/** Policy rejection reason exposed to a caller without revealing private data. */
export type BotShareDenialReason =
  | 'not-member'
  | 'role-forbidden'
  | 'private-chat-owner-only'
  | 'subject-required'
  | 'invalid-roster'

/** One authenticated person's durable membership in a shared Bot. */
export interface BotShareMembership {
  /** Shared Bot whose roster contains this membership. */
  readonly botId: BotId
  /** Authenticated person represented by this membership. */
  readonly principalId: BotPrincipalId
  /** Access level granted to the person. */
  readonly role: BotShareRole
  /** Authenticated person who granted the membership. */
  readonly grantedBy: BotPrincipalId
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last membership mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Shared Bot roster used by the authorization policy. */
export interface SharedBotRoster {
  /** Stable Bot identity. */
  readonly botId: BotId
  /** Each principal occurs at most once; exactly one entry has the owner role. */
  readonly memberships: readonly BotShareMembership[]
}

/** One explicit operation request evaluated against a shared Bot roster. */
export interface BotShareRequest {
  /** Authenticated person making the request. */
  readonly actor: BotPrincipalId
  /** Operation being requested. */
  readonly operation: BotShareOperation
  /** Person whose private conversation is requested, when applicable. */
  readonly subject?: BotPrincipalId
}

/** Result of a shared Bot authorization check. */
export type BotShareDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BotShareDenialReason }

/** Binding for a private Session owned by one shared-Bot participant. */
export interface BotPrivateConversationBinding {
  /** Shared Bot whose behavior backs the conversation. */
  readonly botId: BotId
  /** Only this authenticated person may read the conversation. */
  readonly principalId: BotPrincipalId
  /** Ordinary Session created specifically for this Bot/person pair. */
  readonly sessionId: SessionId
}

/** Opaque routing key for a shared Bot participant's private conversation. */
export type BotPrivateConversationKey = Branded<'BotPrivateConversationKey'>

/**
 * Build a stable routing key for one Bot/person pair.
 *
 * The key deliberately excludes the Session id so a Session replacement does
 * not change the participant identity. It is a lookup key only, never an
 * authorization credential; callers must still run `authorizeBotShare`.
 * @param binding - Shared Bot and authenticated participant binding.
 * @returns Stable routing key that cannot be used as a principal id.
 */
export function botPrivateConversationKey(binding: BotPrivateConversationBinding): BotPrivateConversationKey {
  return brandString<BotPrivateConversationKey>(
    `shared-bot-private-v1:${encodeURIComponent(String(binding.botId))}:${encodeURIComponent(String(binding.principalId))}`,
  )
}

function deny(reason: BotShareDenialReason): BotShareDecision {
  return { allowed: false, reason }
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validMemberships(roster: SharedBotRoster): boolean {
  if (roster.memberships.length === 0) return false
  const principalIds = new Set<string>()
  let owners = 0
  let ownerId: string | undefined
  for (const membership of roster.memberships) {
    if (String(membership.botId) !== String(roster.botId)) return false
    const principalId = String(membership.principalId)
    if (principalId.length === 0 || principalId.length > 256 || principalId.trim() !== principalId
      || principalIds.has(principalId)) return false
    principalIds.add(principalId)
    if (!BOT_SHARE_ROLES.includes(membership.role)) return false
    if (!validTimestamp(membership.createdAt) || !validTimestamp(membership.updatedAt)
      || membership.updatedAt < membership.createdAt) return false
    if (membership.role === 'owner') {
      owners += 1
      ownerId = principalId
      if (String(membership.grantedBy) !== principalId) return false
    }
  }
  if (owners !== 1 || ownerId === undefined) return false
  return roster.memberships.every(membership => String(membership.grantedBy) === ownerId)
}

function membershipFor(roster: SharedBotRoster, principalId: BotPrincipalId): BotShareMembership | undefined {
  return roster.memberships.find(membership => String(membership.principalId) === String(principalId))
}

function assertNever(value: never): never {
  throw new Error(`Unknown shared Bot operation: ${String(value)}`)
}

/**
 * Evaluate one shared Bot request against its authenticated membership roster.
 *
 * Private conversations are participant-owned: even an owner or manager may
 * not read another participant's conversation. This function never accepts a
 * shared workspace token or infers the actor from a Bot or Session id.
 * @param roster - Validated shared Bot membership roster.
 * @param request - Explicit authenticated actor and operation.
 * @returns Allow or a non-sensitive denial reason.
 */
export function authorizeBotShare(roster: SharedBotRoster, request: BotShareRequest): BotShareDecision {
  if (!validMemberships(roster)) return deny('invalid-roster')
  const actor = membershipFor(roster, request.actor)
  if (actor === undefined) return deny('not-member')

  switch (request.operation) {
    case 'read-profile':
    case 'chat':
      return { allowed: true }
    case 'manage-profile':
      return actor.role === 'owner' || actor.role === 'manager' ? { allowed: true } : deny('role-forbidden')
    case 'manage-members':
      return actor.role === 'owner' ? { allowed: true } : deny('role-forbidden')
    case 'read-private-chat':
      if (request.subject === undefined) return deny('subject-required')
      return String(request.subject) === String(request.actor)
        ? { allowed: true }
        : deny('private-chat-owner-only')
    case 'read-memory':
    case 'write-memory':
    case 'read-group':
    case 'write-group':
      return { allowed: true }
    case 'manage-memory':
      return actor.role === 'owner' || actor.role === 'manager' ? { allowed: true } : deny('role-forbidden')
    default:
      return assertNever(request.operation)
  }
}
