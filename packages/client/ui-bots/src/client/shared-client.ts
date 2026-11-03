/** Browser client for the isolated shared-Bot enrollment and chat route. */

import { brandString } from '@yharness/brand'
import type {
  BotAccent,
  BotIdentity,
  BotId as BotIdType,
  BotPrincipalId as BotPrincipalIdType,
  BotShareMemoryId as BotShareMemoryIdType,
  BotShareProfile,
  BotShareRosterEntry,
  BotShareMemoryEntry,
  BotShareMemoryValue,
  BotShareMemoryWriteValue,
  BotShareTranscriptEntry,
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupInspectValue,
  BotGroupListValue,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
} from '@yharness/bots/client'
import type { ClientConnectionRpc, ConnectionRpcFailure } from '@yharness/client-connection/client'

const SHARED_BOTS_PATH = '/shared-bots' as const

const BOT_IDENTITIES = [
  'agent',
  'sparkle',
  'goal',
  'browse',
  'skill',
  'workspace',
  'round',
  'cloud',
  'tile',
  'clover',
  'heart',
  'drop',
  'oval',
  'triangle',
] as const satisfies readonly BotIdentity[]

const BOT_ACCENTS = ['blue', 'teal', 'amber', 'violet', 'rose', 'lime'] as const satisfies readonly BotAccent[]

/** Safe result returned by a shared-Bot client operation. */
export type SharedBotClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Shared Bot enrollment response after the HttpOnly cookie is stored. */
export interface SharedBotEnrollmentValue {
  /** Newly minted collaborator principal. */
  readonly principalId: string
  /** Absolute cookie expiry. */
  readonly expiresAt: number
}
/** Private transcript response for one Bot and the current collaborator. */
export interface SharedBotPrivateChatValue {
  /** Bot whose private conversation was read. */
  readonly botId: string
  /** Backing private Session id after the first chat. */
  readonly sessionId?: string
  /** Bounded visible transcript entries. */
  readonly recent: readonly BotShareTranscriptEntry[]
}

/** Explicit shared context returned for one shared Bot. */
export type SharedBotMemoryValue = BotShareMemoryValue

/** Shared-context write response after explicit publication consent. */
export type SharedBotMemoryWriteValue = BotShareMemoryWriteValue

/** Chat response after the Host accepts one message. */
export interface SharedBotChatValue {
  /** Current Bot profile. */
  readonly bot: BotShareProfile
  /** Private Session backing this collaborator's conversation. */
  readonly sessionId: string
  /** True once the message has passed the durability barrier. */
  readonly accepted: true
}

/** Invite response for a collaborator who can manage membership. */
export interface SharedBotInviteValue {
  /** One-time invite code. */
  readonly code: string
  /** Absolute invite expiry. */
  readonly expiresAt: number
  /** Role granted when redeemed. */
  readonly role: 'owner' | 'manager' | 'collaborator'
}

/** Revoke response for one Bot-scoped membership deletion. */
export interface SharedBotRevokeValue {
  /** True after the membership and private binding are removed. */
  readonly revoked: true
  /** Removed principal. */
  readonly principalId: string
}

/** Group catalog visible to the authenticated collaborator. */
export type SharedBotGroupListValue = BotGroupListValue
/** Group transcript visible to the authenticated collaborator. */
export type SharedBotGroupInspectValue = BotGroupInspectValue
/** Group message delivery result. */
export type SharedBotGroupSendValue = BotGroupSendValue

/** Browser operations exposed by the isolated `/shared-bots` route. */
export interface SharedBotsClient {
  /** Redeem an owner-issued invite; the response stores an HttpOnly cookie. */
  readonly enroll: (code: string) => Promise<SharedBotClientResult<SharedBotEnrollmentValue>>
  /** Discover Bots visible to the authenticated collaborator. */
  readonly list: () => Promise<SharedBotClientResult<{ readonly bots: readonly BotShareRosterEntry[] }>>
  /** Read one safe shared Bot profile. */
  readonly readProfile: (botId: string) => Promise<SharedBotClientResult<{ readonly bot: BotShareProfile }>>
  /** Read only the current collaborator's private transcript. */
  readonly readPrivateChat: (botId: string) => Promise<SharedBotClientResult<SharedBotPrivateChatValue>>
  /** Read the explicit shared context; this never includes the private transcript. */
  readonly readMemory: (botId: string) => Promise<SharedBotClientResult<SharedBotMemoryValue>>
  /** Send one message to the current collaborator's private Bot Session. */
  readonly chat: (botId: string, text: string) => Promise<SharedBotClientResult<SharedBotChatValue>>
  /** Publish one explicitly consented note to shared context. */
  readonly writeMemory: (botId: string, text: string) => Promise<SharedBotClientResult<SharedBotMemoryWriteValue>>
  /** Create one invite when the current membership role permits it. */
  readonly createInvite: (botId: string, role: SharedBotInviteValue['role']) => Promise<SharedBotClientResult<SharedBotInviteValue>>
  /** Revoke one member from one Bot when the current membership role permits it. */
  readonly revokeMember: (botId: string, principalId: string) => Promise<SharedBotClientResult<SharedBotRevokeValue>>
  /** List groups whose every Bot is shared with the current principal. */
  readonly listGroups?: () => Promise<SharedBotClientResult<SharedBotGroupListValue>>
  /** Create a group from Bots shared with the current principal. */
  readonly createGroup?: (request: BotGroupCreateRequest) => Promise<SharedBotClientResult<BotGroupCreateValue>>
  /** Update a group while retaining principal-derived membership access. */
  readonly updateGroup?: (request: BotGroupUpdateRequest) => Promise<SharedBotClientResult<BotGroupUpdateValue>>
  /** Read a shared group transcript without private Session events. */
  readonly inspectGroup?: (groupId: string) => Promise<SharedBotClientResult<SharedBotGroupInspectValue>>
  /** Send an idempotent shared group message attributed by the server. */
  readonly sendGroupMessage?: (request: BotGroupSendRemoteRequest) => Promise<SharedBotClientResult<SharedBotGroupSendValue>>
}

/**
 * Build a typed caller for the collaborator-only route.
 * @param rpc - Connection RPC carrier from the active Client generation.
 * @returns shared-Bot operations using the dedicated channel only.
 */
export function createSharedBotsClient(rpc: ClientConnectionRpc): SharedBotsClient {
  const call = async <T>(
    endpoint: string,
    payload: unknown,
    parse: (value: unknown) => T | undefined,
  ): Promise<SharedBotClientResult<T>> => {
    let result
    try {
      result = await rpc.call(SHARED_BOTS_PATH, endpoint, payload)
    } catch (error: unknown) {
      return { ok: false, error: { code: 'gateway/transport', message: error instanceof Error ? error.message : 'Shared Bot transport failed', details: {} } }
    }
    if (!result.ok) return result
    const value = parse(result.value)
    if (value === undefined) {
      return { ok: false, error: { code: 'gateway/invalid-response', message: 'Shared Bot returned an invalid response', details: {} } }
    }
    return { ok: true, value }
  }

  return {
    enroll: code => call('bots/share/enroll', { code }, parseEnrollment),
    list: () => call('bots/share/list', {}, parseRoster),
    readProfile: botId => call('bots/share/read-profile', { botId }, parseProfileValue),
    readPrivateChat: botId => call('bots/share/read-private-chat', { botId }, parsePrivateChat),
    readMemory: botId => call('bots/share/read-memory', { botId }, parseMemoryValue),
    chat: (botId, text) => call('bots/share/chat', { botId, text }, parseChat),
    writeMemory: (botId, text) => call('bots/share/write-memory', { botId, text, consent: true }, parseMemoryWrite),
    createInvite: (botId, role) => call('bots/share/manage-members', { botId, action: 'create-invite', role }, parseInvite),
    revokeMember: (botId, principalId) => call('bots/share/manage-members', { botId, action: 'revoke', principalId }, parseRevoke),
  }
}

function parseEnrollment(value: unknown): SharedBotEnrollmentValue | undefined {
  if (!isRecord(value) || typeof value.principalId !== 'string' || !isSafeInteger(value.expiresAt)) return undefined
  return { principalId: value.principalId, expiresAt: value.expiresAt }
}

function parseRoster(value: unknown): { readonly bots: readonly BotShareRosterEntry[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.bots)) return undefined
  const bots = value.bots.map(parseRosterEntry)
  return bots.some(bot => bot === undefined)
    ? undefined
    : { bots: bots as readonly BotShareRosterEntry[] }
}

function parseRosterEntry(value: unknown): BotShareRosterEntry | undefined {
  const profile = parseProfile(value)
  if (profile === undefined || !isRecord(value) || typeof value.role !== 'string'
    || !['owner', 'manager', 'collaborator'].includes(value.role)) return undefined
  return { ...profile, role: value.role as BotShareRosterEntry['role'] }
}

function parseProfileValue(value: unknown): { readonly bot: BotShareProfile } | undefined {
  if (!isRecord(value)) return undefined
  const bot = parseProfile(value.bot)
  return bot === undefined ? undefined : { bot }
}

function parseProfile(value: unknown): BotShareProfile | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.id)
    || typeof value.name !== 'string' || typeof value.state !== 'string' || !['provisioning', 'active'].includes(value.state)
    || typeof value.availability !== 'string' || !['running', 'idle', 'offline'].includes(value.availability)) return undefined
  const identity = enumValue(value.identity, BOT_IDENTITIES)
  const accent = enumValue(value.accent, BOT_ACCENTS)
  if (identity === undefined || accent === undefined) return undefined
  return {
    id: brandString<BotIdType>(value.id),
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    identity,
    accent,
    state: value.state as BotShareProfile['state'],
    availability: value.availability as BotShareProfile['availability'],
  }
}

function parsePrivateChat(value: unknown): SharedBotPrivateChatValue | undefined {
  if (!isRecord(value) || typeof value.botId !== 'string' || !Array.isArray(value.recent)) return undefined
  const recent = value.recent.map(parseTranscript)
  if (recent.some(entry => entry === undefined)) return undefined
  return {
    botId: value.botId,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    recent: recent as readonly BotShareTranscriptEntry[],
  }
}

function parseMemoryValue(value: unknown): SharedBotMemoryValue | undefined {
  if (!isRecord(value) || typeof value.botId !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId)
    || typeof value.enabled !== 'boolean' || !isSafeInteger(value.updatedAt) || !Array.isArray(value.entries)) return undefined
  const entries = value.entries.map(parseMemoryEntry)
  return entries.some(entry => entry === undefined)
    ? undefined
    : {
      botId: brandString<BotIdType>(value.botId),
      enabled: value.enabled,
      updatedAt: value.updatedAt,
      entries: entries as readonly BotShareMemoryEntry[],
    }
}

function parseMemoryEntry(value: unknown): BotShareMemoryEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^memory-[A-Za-z0-9-]+$/.test(value.id)
    || typeof value.principalId !== 'string' || !/^principal-[A-Za-z0-9-]+$/.test(value.principalId)
    || typeof value.text !== 'string' || !isSafeInteger(value.createdAt)) return undefined
  return {
    id: brandString<BotShareMemoryIdType>(value.id),
    principalId: brandString<BotPrincipalIdType>(value.principalId),
    text: value.text,
    createdAt: value.createdAt,
  }
}

function parseMemoryWrite(value: unknown): SharedBotMemoryWriteValue | undefined {
  if (!isRecord(value)) return undefined
  const entry = parseMemoryEntry(value.entry)
  return entry === undefined ? undefined : { entry }
}

function parseTranscript(value: unknown): BotShareTranscriptEntry | undefined {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.text !== 'string') return undefined
  return { role: value.role, text: value.text }
}

function parseChat(value: unknown): SharedBotChatValue | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.accepted !== true) return undefined
  const profile = parseProfile(value.bot)
  return profile === undefined ? undefined : { bot: profile, sessionId: value.sessionId, accepted: true }
}

function parseInvite(value: unknown): SharedBotInviteValue | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || !isSafeInteger(value.expiresAt)
    || typeof value.role !== 'string' || !['owner', 'manager', 'collaborator'].includes(value.role)) return undefined
  return { code: value.code, expiresAt: value.expiresAt, role: value.role as SharedBotInviteValue['role'] }
}

function parseRevoke(value: unknown): SharedBotRevokeValue | undefined {
  if (!isRecord(value) || value.revoked !== true || typeof value.principalId !== 'string') return undefined
  return { revoked: true, principalId: value.principalId }
}

function enumValue<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === 'string' && choices.some(choice => choice === value) ? value as T : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
