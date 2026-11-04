import { createHash } from 'node:crypto'
import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ApiSessionNotFound } from '@yharness/api-session-controller'
import { BotPrincipalId } from '../src/sharing.ts'
import { SharedAccessAuthority, SharedInviteCode, sharedInviteDigest, sharedPrincipalOf, type SharedAccessEnrollment } from '@yharness/client-connection'
import type { UserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import Storage from '@yharness/storage'
import { credentialKey, CredentialProvider } from '@yharness/credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@yharness/credentials'
import { DomainFacility } from '@yharness/storage-domain'
import type { StorageBackend } from '@yharness/storage'
import { RemoteError } from '@yharness/typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import z from 'zod'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { BotId, type BotView } from '../src/types.ts'
import {
  BotGroupId,
  BotGroupMessageId,
} from '../src/group-chat.ts'
import { SharedBotService, SHARED_BOT_ENDPOINTS, type SharedBotHost } from '../src/shared-service.ts'
import { sharedGroupSnapshotSchema, type SharedGroupSessionBinding } from '../src/shared-group.ts'
import {
  sharedInviteSchema,
  sharedMemorySnapshotSchema,
  sharedMembershipSnapshotSchema,
  sharedPrivateSessionSchema,
} from '../src/storage.ts'

interface KeyedCredentialState {
  readonly records: Map<CredentialKey, CredentialRecord>
  tail: Promise<void>
}

class KeyedCredentials extends CredentialProvider {
  private static readonly states = new WeakMap<Map<CredentialKey, CredentialRecord>, KeyedCredentialState>()
  private readonly state: KeyedCredentialState

  constructor(ctx: Context, private readonly records = new Map<CredentialKey, CredentialRecord>()) {
    super(ctx)
    this.state = KeyedCredentials.states.get(records) ?? { records, tail: Promise.resolve() }
    KeyedCredentials.states.set(records, this.state)
  }

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }

  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const run = this.state.tail.then(async () => {
      const next = await mutate(this.records.get(key))
      if (next !== undefined) this.records.set(key, next)
      return this.records.get(key)
    })
    this.state.tail = run.then(() => undefined, () => undefined)
    return run
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    const run = this.state.tail.then(() => { this.records.delete(key) })
    this.state.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

interface Fixture {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly pool: MemoryMediaPool
  readonly records: Map<CredentialKey, CredentialRecord>
  readonly credentials: KeyedCredentials
  readonly authority: SharedAccessAuthority
  readonly service: SharedBotService
  readonly host: SharedBotHostFixture
  readonly clock: { value: number }
  readonly close: () => Promise<void>
}

class SharedBotHostFixture implements SharedBotHost {
  readonly sessions = new Map<string, { readonly botId: string; readonly principalId: string }>()
  readonly sharedGroupMessages = new Set<string>()
  readonly sharedGroupBindings: SharedGroupSessionBinding[][] = []
  readonly messages = new Map<string, UserMessage[]>()
  readonly followups = vi.fn<(sessionId: SessionId, message: UserMessage) => void>((sessionId, message) => {
    const messages = this.messages.get(String(sessionId)) ?? []
    messages.push(message)
    this.messages.set(String(sessionId), messages)
  })
  readonly cancellations = vi.fn<(sessionId: SessionId) => void>()
  private readonly bots: BotView[]

  constructor(includeSecondBot = false, includeThirdBot = false) {
    this.bots = [{
      id: BotId('bot-chief'),
      sessionId: SessionId('bot-session-chief'),
      name: 'Chief of staff',
      description: 'Coordinates the work',
      identity: 'agent',
      accent: 'violet',
      cwd: '/tmp',
      state: 'active',
      availability: 'idle',
      pinned: false,
      hidden: false,
      createdAt: 1,
      updatedAt: 1,
    }, ...(includeSecondBot ? [{
      id: BotId('bot-second'),
      sessionId: SessionId('bot-session-second'),
      name: 'Second bot',
      description: 'A second shared Bot',
      identity: 'sparkle' as const,
      accent: 'teal' as const,
      cwd: '/tmp',
      state: 'active' as const,
      availability: 'idle' as const,
      pinned: false,
      hidden: false,
      createdAt: 2,
      updatedAt: 2,
    }] : []), ...(includeThirdBot ? [{
      id: BotId('bot-third'),
      sessionId: SessionId('bot-session-third'),
      name: 'Third bot',
      description: 'A third shared Bot',
      identity: 'robot' as const,
      accent: 'amber' as const,
      cwd: '/tmp',
      state: 'active' as const,
      availability: 'idle' as const,
      pinned: false,
      hidden: false,
      createdAt: 3,
      updatedAt: 3,
    }] : [])]
  }

  listBots = async (_signal?: AbortSignal): Promise<readonly BotView[]> => [...this.bots]

  findBot = async (botId: BotId, _signal?: AbortSignal): Promise<BotView | undefined> => this.bots.find(bot => bot.id === botId)

  withBot = async <T>(
    botId: BotId,
    signal: AbortSignal | undefined,
    operation: (bot: BotView) => Promise<T>,
  ): Promise<{ readonly found: true; readonly value: T } | { readonly found: false }> => {
    signal?.throwIfAborted()
    const bot = await this.findBot(botId, signal)
    signal?.throwIfAborted()
    if (bot === undefined) return { found: false }
    const current = this.bots.find(candidate => candidate.id === botId)
    if (current === undefined) return { found: false }
    return { found: true, value: await operation(current) }
  }

  createPrivateSession = async (
    bot: BotView,
    sessionId: SessionId,
    principalId: string,
    _signal?: AbortSignal,
  ): Promise<Pick<Agent, 'id' | 'cancel' | 'whenIdle'>> => {
    this.sessions.set(String(sessionId), { botId: String(bot.id), principalId })
    this.messages.set(String(sessionId), [])
    return {
      id: sessionId,
      cancel: () => { this.cancellations(sessionId) },
      whenIdle: async () => {},
    }
  }

  createSharedGroupSession = async (_bot: BotView, sessionId: SessionId, _groupId: BotGroupId): Promise<Pick<Agent, 'id' | 'cancel' | 'whenIdle'>> => ({
    id: sessionId,
    cancel: () => { this.cancellations(sessionId) },
    whenIdle: async () => {},
  })

  resolveSharedGroupAgent = async (sessionId: SessionId, _groupId: BotGroupId, _botId: BotId, _signal: AbortSignal): Promise<{ readonly agent: Pick<Agent, 'id' | 'followup' | 'cancel' | 'whenIdle'> }> => ({
    agent: {
      id: sessionId,
      followup: (message) => { this.followups(sessionId, message) },
      cancel: () => { this.cancellations(sessionId) },
      whenIdle: async () => {},
    },
  })

  inspectSharedGroupSession = async (
    _sessionId: SessionId,
    _signal: AbortSignal,
  ): Promise<{ readonly events: readonly never[] }> => ({ events: [] })

  flushSharedGroupSession = async (_sessionId: SessionId, _signal?: AbortSignal): Promise<boolean> => true

  resolvePrivateAgent = async (sessionId: SessionId, signal: AbortSignal): Promise<{ agent: Pick<Agent, 'id' | 'followup' | 'cancel' | 'whenIdle'> } | { error: Error }> => {
    signal.throwIfAborted()
    return {
      agent: {
        id: sessionId,
        followup: (message) => { this.followups(sessionId, message) },
        cancel: () => { this.cancellations(sessionId) },
        whenIdle: async () => {},
      },
    }
  }

  inspectPrivateSession = async (_sessionId: SessionId, _signal: AbortSignal): Promise<{ events: readonly never[] }> => ({
    events: [],
  })

  flushPrivateSession = async (_sessionId: SessionId, _signal?: AbortSignal): Promise<void> => {}

  registerSharedGroupSessions = (bindings: readonly SharedGroupSessionBinding[]): void => {
    this.sharedGroupBindings.push([...bindings])
  }

  deliverSharedGroup = vi.fn<NonNullable<SharedBotHost['deliverSharedGroup']>>(async (request) => {
    const registered = this.sharedGroupBindings.at(-1)?.some(
      binding => binding.sessionId === request.sessionId && binding.botId === request.targetBotId,
    )
    if (!registered) throw new Error('shared group Session binding was not registered')
    const key = `${String(request.messageId)}:${String(request.targetBotId)}`
    if (this.sharedGroupMessages.has(key)) return 'duplicate'
    this.sharedGroupMessages.add(key)
    return 'accepted'
  })

  renameBot = async (botId: BotId, name: string): Promise<BotView> => {
    const index = this.bots.findIndex(bot => bot.id === botId)
    const current = this.bots[index]
    if (current === undefined) throw new Error('missing bot')
    const updated = { ...current, name, updatedAt: current.updatedAt + 1 }
    this.bots[index] = updated
    return updated
  }

  updateAppearance = async (botId: BotId, identity: BotView['identity'] | undefined, accent: BotView['accent'] | undefined): Promise<BotView> => {
    const index = this.bots.findIndex(bot => bot.id === botId)
    const current = this.bots[index]
    if (current === undefined) throw new Error('missing bot')
    const updated = {
      ...current,
      ...(identity === undefined ? {} : { identity }),
      ...(accent === undefined ? {} : { accent }),
      updatedAt: current.updatedAt + 1,
    }
    this.bots[index] = updated
    return updated
  }

  updateProfile = async (
    botId: BotId,
    update: { readonly name?: string; readonly identity?: BotView['identity']; readonly accent?: BotView['accent'] },
    _signal?: AbortSignal,
    expectedUpdatedAt?: number,
  ): Promise<BotView> => {
    const index = this.bots.findIndex(bot => bot.id === botId)
    const current = this.bots[index]
    if (current === undefined) throw new Error('missing bot')
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      throw new RemoteError('gateway/conflict', 'Bot profile changed during update', { botId })
    }
    const updated = {
      ...current,
      ...(update.name === undefined ? {} : { name: update.name }),
      ...(update.identity === undefined ? {} : { identity: update.identity }),
      ...(update.accent === undefined ? {} : { accent: update.accent }),
      updatedAt: current.updatedAt + 1,
    }
    this.bots[index] = updated
    return updated
  }

  removeBot(botId: BotId): void {
    const index = this.bots.findIndex(bot => bot.id === botId)
    if (index >= 0) this.bots.splice(index, 1)
  }
}

async function fixture(
  membershipPollIntervalMs = 10,
  includeSecondBot = false,
  includeThirdBot = false,
  clock: { value: number } = { value: 1_000 },
): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const records = new Map<CredentialKey, CredentialRecord>()
  const credentials = new KeyedCredentials(ctx, records)
  const authority = await SharedAccessAuthority.create(ctx, credentials, {
    sessionMaxAgeMs: 60_000,
    inviteMaxAgeMs: 60_000,
    now: () => clock.value,
  })
  const host = new SharedBotHostFixture(includeSecondBot, includeThirdBot)
  const service = await SharedBotService.create(ctx, facility, authority, host, {
    now: () => clock.value,
    membershipPollIntervalMs,
  })
  return {
    ctx, facility, pool, records, credentials, authority, service, host, clock,
    close: async () => { await service.dispose(); await authority.dispose(); await ctx.fiber.dispose() },
  }
}

interface SecondaryFixture {
  readonly ctx: Context
  readonly authority: SharedAccessAuthority
  readonly service: SharedBotService
  readonly host: SharedBotHostFixture
  readonly close: () => Promise<void>
}

async function secondaryFixture(value: Fixture, includeSecondBot = false, includeThirdBot = false): Promise<SecondaryFixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(value.pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const credentials = new KeyedCredentials(ctx, value.records)
  const authority = await SharedAccessAuthority.create(ctx, credentials, {
    sessionMaxAgeMs: 60_000,
    inviteMaxAgeMs: 60_000,
    now: () => value.clock.value,
  })
  const host = new SharedBotHostFixture(includeSecondBot, includeThirdBot)
  const service = await SharedBotService.create(ctx, facility, authority, host, {
    now: () => value.clock.value,
    membershipPollIntervalMs: 10,
  })
  return {
    ctx, authority, service, host,
    close: async () => { await service.dispose(); await authority.dispose(); await ctx.fiber.dispose() },
  }
}

function cookie(enrollment: SharedAccessEnrollment): string {
  return enrollment.setCookie.split(';', 1)[0]!
}

function request(cookieValue: string): { headers: Record<string, string> } {
  return { headers: { host: '127.0.0.1:3080', cookie: cookieValue } }
}

function enrollmentRequest(): { headers: Record<string, string> } {
  return { headers: { host: '127.0.0.1:3080' } }
}

function pendingInviteCount(record: CredentialRecord | undefined): number {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null
    || !('invites' in record.payload) || !Array.isArray(record.payload.invites)) return 0
  return record.payload.invites.length
}

const privateSessionSnapshotSchema = z.object({
  version: z.literal(1),
  bindings: z.array(sharedPrivateSessionSchema),
}).strict()

async function replacePrivateSessionBinding(
  authority: SharedAccessAuthority,
  predicate: (binding: z.infer<typeof sharedPrivateSessionSchema>) => boolean,
  sessionId: SessionId,
): Promise<void> {
  await authority.mutateExtension('agent-bots/shared-private-sessions', (current) => {
    const snapshot = privateSessionSnapshotSchema.parse(current)
    return {
      value: undefined,
      next: {
        version: snapshot.version,
        bindings: snapshot.bindings.map(binding => predicate(binding)
          ? { ...binding, sessionId, updatedAt: Math.max(binding.updatedAt, 1_001) }
          : binding),
      },
    }
  })
}

async function principal(fixtureValue: Fixture, enrollment: SharedAccessEnrollment) {
  const admitted = await fixtureValue.authority.admit(request(cookie(enrollment)))
  if (!('peer' in admitted)) throw new Error(`admission rejected: ${String(admitted.rejection)}`)
  const principalId = sharedPrincipalOf(admitted.peer)
  if (principalId === undefined) throw new Error('missing shared principal')
  return { peer: admitted.peer, principalId, botPrincipalId: BotPrincipalId(String(principalId)) }
}

function groupIdFromResult(result: Awaited<ReturnType<SharedBotService['handle']>>): BotGroupId {
  if (!result.ok) throw new Error('shared group operation failed')
  const value = result.value
  if (value === null || typeof value !== 'object' || !('group' in value)) {
    throw new Error('shared group operation did not return a group')
  }
  const group = value.group
  if (group === null || typeof group !== 'object' || !('id' in group) || typeof group.id !== 'string') {
    throw new Error('shared group operation returned an invalid group')
  }
  return BotGroupId(group.id)
}

function groupInviteCodeFromResult(result: Awaited<ReturnType<SharedBotService['handle']>>): SharedInviteCode {
  if (!result.ok) throw new Error('shared group invite operation failed')
  const value = result.value
  if (value === null || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string') {
    throw new Error('shared group invite operation did not return a code')
  }
  return SharedInviteCode(value.code)
}

describe('shared Bot snapshot validation', () => {
  it('rejects dangling delivery, response, and reservation references', () => {
    const valid = {
      version: 1 as const,
      revision: 1,
      groups: [{
        id: 'bot-group-reference-validation',
        name: 'Reference validation room',
        botIds: ['bot-chief', 'bot-second'],
        createdAt: 1,
        updatedAt: 1,
        ownerPrincipalId: 'principal-owner',
        memberPrincipalIds: ['principal-owner'],
        revision: 1,
      }],
      messages: [{
        id: 'bot-group-message-reference-validation',
        groupId: 'bot-group-reference-validation',
        sender: { kind: 'user' as const, principalId: 'principal-owner' },
        text: 'Reference validation.',
        targetBotIds: ['bot-chief', 'bot-second'],
        createdAt: 1,
      }],
      deliveries: [{
        id: 'delivery-02925ba9144d5f4f18db58870af2de23877e6103186ad2471cd4b999518d099c',
        groupId: 'bot-group-reference-validation',
        messageId: 'bot-group-message-reference-validation',
        botId: 'bot-chief',
        status: 'pending' as const,
        authorizationRevision: 1,
        senderPrincipalId: 'principal-owner',
        updatedAt: 1,
      }],
      sessions: [{
        groupId: 'bot-group-reference-validation',
        botId: 'bot-chief',
        sessionId: 'shared-session-group-reference-validation',
        createdAt: 1,
        updatedAt: 1,
      }],
      invites: [],
      responseReservations: ['delivery-02925ba9144d5f4f18db58870af2de23877e6103186ad2471cd4b999518d099c'],
    }
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], messageId: 'bot-group-message-missing' }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], groupId: 'bot-group-missing' }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], botId: 'bot-not-in-group' }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], id: 'delivery-noncanonical' }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{
        ...valid.deliveries[0],
        status: 'responded' as const,
        responseMessageId: 'bot-group-message-missing-response',
      }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      responseReservations: ['delivery-missing'],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      sessions: [],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      sessions: [...valid.sessions, {
        groupId: valid.groups[0].id,
        botId: 'bot-not-in-group',
        sessionId: 'shared-session-group-dangling',
        createdAt: 1,
        updatedAt: 1,
      }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], status: 'failed' as const }],
      responseReservations: [valid.deliveries[0].id],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{ ...valid.deliveries[0], dispatchToken: 'attempt-without-lease' }],
    })).toThrow()
    expect(() => sharedGroupSnapshotSchema.parse({
      ...valid,
      deliveries: [{
        ...valid.deliveries[0],
        status: 'accepted' as const,
        dispatchToken: 'terminal-attempt',
        dispatchLeaseUntil: 30_000,
      }],
    })).toThrow()
  })

  it('restores reservations for a pre-reservation v1 snapshot with an active delivery', () => {
    const deliveryId = `delivery-${createHash('sha256').update('bot-group-message-legacy-reservations:bot-chief').digest('hex')}`
    const legacy = {
      version: 1 as const,
      revision: 1,
      groups: [{
        id: 'bot-group-legacy-reservations',
        name: 'Legacy reservations room',
        botIds: ['bot-chief', 'bot-second'],
        createdAt: 1,
        updatedAt: 1,
        ownerPrincipalId: 'principal-owner',
        memberPrincipalIds: ['principal-owner'],
        revision: 1,
      }],
      messages: [{
        id: 'bot-group-message-legacy-reservations',
        groupId: 'bot-group-legacy-reservations',
        sender: { kind: 'user' as const, principalId: 'principal-owner' },
        text: 'Legacy active delivery.',
        targetBotIds: ['bot-chief'],
        createdAt: 1,
      }],
      deliveries: [{
        id: deliveryId,
        groupId: 'bot-group-legacy-reservations',
        messageId: 'bot-group-message-legacy-reservations',
        botId: 'bot-chief',
        status: 'pending' as const,
        authorizationRevision: 1,
        senderPrincipalId: 'principal-owner',
        updatedAt: 1,
      }],
      sessions: [{
        groupId: 'bot-group-legacy-reservations',
        botId: 'bot-chief',
        sessionId: 'shared-session-group-legacy-reservations',
        createdAt: 1,
        updatedAt: 1,
      }],
      invites: [],
    }
    const parsed = sharedGroupSnapshotSchema.parse(legacy)
    expect(parsed.responseReservations).toEqual([deliveryId])
  })
})

describe('shared Bot service', () => {
  it('uses explicit shared-group state instead of a pre-existing owner-local group transcript', async () => {
    const value = await fixture(10, true)
    try {
      expect(SHARED_BOT_ENDPOINTS).toEqual(expect.arrayContaining([
        'bots/share/list-groups',
        'bots/share/create-group',
        'bots/share/update-group',
        'bots/share/inspect-group',
        'bots/share/send-group-message',
      ]))
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        enrollmentRequest(),
      )
      const collaboratorEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        enrollmentRequest(),
      )
      const secondEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'collaborator')).code,
        request(cookie(collaboratorEnrollment)),
      )
      const collaborator = await principal(value, collaboratorEnrollment)
      expect((await principal(value, secondEnrollment)).botPrincipalId).toBe(collaborator.botPrincipalId)

      const localList = vi.fn(async () => ({ groups: [{ name: 'Owner-only room' }] }))
      Object.assign(value.host, { listGroups: localList })
      const created = await value.service.handle(
        'bots/share/create-group',
        { name: 'Shared room', botIds: ['bot-chief', 'bot-second'] },
        new AbortController().signal,
        collaborator.peer,
      )
      expect(created).toMatchObject({ ok: true, value: { group: { name: 'Shared room' } } })
      const listed = await value.service.handle(
        'bots/share/list-groups', {}, new AbortController().signal, collaborator.peer,
      )
      expect(listed).toMatchObject({ ok: true, value: { groups: [{ name: 'Shared room' }] } })
      expect(JSON.stringify(listed)).not.toContain('Owner-only room')
      expect(localList).not.toHaveBeenCalled()
    } finally {
      await value.close()
    }
  })

  it('delivers shared-group messages through stable isolated bindings and retries idempotently', async () => {
    const value = await fixture(10, true)
    try {
      const chiefOwner = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const secondOwner = await value.service.enroll((await value.service.createInvite(BotId('bot-second'), 'owner')).code, request(cookie(chiefOwner)))
      const collaborator = await principal(value, chiefOwner)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Durable room',
        botIds: ['bot-chief', 'bot-second'],
      }, new AbortController().signal, collaborator.peer)
      expect(created).toMatchObject({ ok: true, value: { group: { name: 'Durable room' } } })
      if (!created.ok) throw new Error('group creation failed')
      const groupId = groupIdFromResult(created)
      const requestValue = {
        groupId,
        text: 'Shared request.',
        messageId: BotGroupMessageId('bot-group-message-shared-retry'),
      }
      await expect(value.service.handle('bots/share/send-group-message', requestValue, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true,
        value: { messageId: requestValue.messageId, status: 'accepted', deliveries: [{ status: 'accepted' }, { status: 'accepted' }] },
      })
      await expect(value.service.handle('bots/share/send-group-message', requestValue, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true,
        value: { messageId: requestValue.messageId, status: 'duplicate', deliveries: [{ status: 'duplicate' }, { status: 'duplicate' }] },
      })
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(2)
      await expect(value.service.handle('bots/share/inspect-group', { groupId }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true,
        value: { messages: [{ id: requestValue.messageId, text: 'Shared request.' }] },
      })
      void secondOwner
    } finally {
      await value.close()
    }
  })

  it('persists shared-group ACLs across Hosts and revokes an explicit group member', async () => {
    const value = await fixture(10, true)
    let secondary: SecondaryFixture | undefined
    try {
      const chiefOwner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      const owner = await principal(value, chiefOwner)
      const created = await value.service.handle('bots/share/create-group', {
        id: BotGroupId('bot-group-cross-host'),
        name: 'Cross-host room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      expect(created).toMatchObject({ ok: true, value: { group: { id: 'bot-group-cross-host' } } })
      const bindings = value.host.sharedGroupBindings.at(-1) ?? []
      expect(bindings).toHaveLength(2)
      expect(bindings.map(binding => String(binding.groupId))).toEqual([
        'bot-group-cross-host',
        'bot-group-cross-host',
      ])
      expect(bindings.map(binding => String(binding.botId)).sort()).toEqual(['bot-chief', 'bot-second'])
      expect(bindings.every(binding => /^shared-session-group-/.test(String(binding.sessionId)))).toBe(true)

      const chiefMemberInvite = await value.service.createInvite(BotId('bot-chief'), 'collaborator')
      const chiefMember = await value.service.enroll(chiefMemberInvite.code, enrollmentRequest())
      const secondMemberInvite = await value.service.createInvite(BotId('bot-second'), 'collaborator')
      const secondMember = await value.service.enroll(secondMemberInvite.code, request(cookie(chiefMember)))
      const member = await principal(value, secondMember)
      const groupInvite = await value.service.handle('bots/share/manage-group-members', {
        groupId: BotGroupId('bot-group-cross-host'),
        action: 'create-invite',
      }, new AbortController().signal, owner.peer)
      const groupInviteCode = groupInviteCodeFromResult(groupInvite)
      await expect(value.service.enroll(
        groupInviteCode,
        enrollmentRequest(),
      )).rejects.toThrow('active shared Bot membership')
      const groupEnrollment = await value.service.enroll(
        groupInviteCode,
        request(cookie(secondMember)),
      )
      const groupMember = await principal(value, groupEnrollment)
      await expect(value.service.handle('bots/share/list-groups', {}, new AbortController().signal, groupMember.peer)).resolves.toMatchObject({
        ok: true,
        value: { groups: [{ id: 'bot-group-cross-host' }] },
      })

      secondary = await secondaryFixture(value, true)
      const admitted = await secondary.authority.admit(request(cookie(chiefOwner)))
      if (!('peer' in admitted)) throw new Error('secondary Host rejected an active shared principal')
      await expect(secondary.service.handle('bots/share/list-groups', {}, new AbortController().signal, admitted.peer)).resolves.toMatchObject({
        ok: true,
        value: { groups: [{ id: 'bot-group-cross-host' }] },
      })
      await expect(secondary.service.sharedGroupSessionBindings()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ groupId: BotGroupId('bot-group-cross-host'), botId: BotId('bot-chief') }),
        expect.objectContaining({ groupId: BotGroupId('bot-group-cross-host'), botId: BotId('bot-second') }),
      ]))
      const concurrent = await Promise.all([
        value.service.handle('bots/share/create-group', {
          id: BotGroupId('bot-group-concurrent'),
          name: 'First metadata',
          botIds: [BotId('bot-chief'), BotId('bot-second')],
        }, new AbortController().signal, owner.peer),
        secondary.service.handle('bots/share/create-group', {
          id: BotGroupId('bot-group-concurrent'),
          name: 'Conflicting metadata',
          botIds: [BotId('bot-chief'), BotId('bot-second')],
        }, new AbortController().signal, admitted.peer),
      ])
      expect(concurrent.filter(result => result.ok)).toHaveLength(1)
      expect(concurrent.filter(result => !result.ok)).toMatchObject([
        { ok: false, error: { code: 'gateway/conflict' } },
      ])
      await expect(secondary.service.handle('bots/share/send-group-message', {
        groupId: BotGroupId('bot-group-cross-host'),
        text: 'Delivered by the second Host.',
        messageId: BotGroupMessageId('bot-group-message-second-host'),
      }, new AbortController().signal, admitted.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'accepted', deliveries: [{ status: 'accepted' }, { status: 'accepted' }] },
      })

      await expect(value.service.handle('bots/share/manage-group-members', {
        groupId: BotGroupId('bot-group-cross-host'),
        action: 'revoke',
        principalId: member.botPrincipalId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true, value: { revoked: true } })
      await expect(value.service.handle('bots/share/inspect-group', {
        groupId: BotGroupId('bot-group-cross-host'),
      }, new AbortController().signal, groupMember.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      const revokedAdmission = await secondary.authority.admit(request(cookie(secondMember)))
      if (!('peer' in revokedAdmission)) throw new Error('secondary Host rejected the revoked member cookie unexpectedly')
      await expect(secondary.service.handle('bots/share/inspect-group', {
        groupId: BotGroupId('bot-group-cross-host'),
      }, new AbortController().signal, revokedAdmission.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('claims a pending delivery before fan-out so two Hosts do not dispatch it twice', async () => {
    const value = await fixture(10, true)
    let secondary: SecondaryFixture | undefined
    try {
      const chiefOwner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      const owner = await principal(value, chiefOwner)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Cross-host delivery claim room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      secondary = await secondaryFixture(value, true)
      const admitted = await secondary.authority.admit(request(cookie(chiefOwner)))
      if (!('peer' in admitted)) throw new Error('secondary Host rejected an active shared principal')
      const entered = Promise.withResolvers<boolean>()
      const release = Promise.withResolvers<boolean>()
      value.host.deliverSharedGroup.mockImplementation(async () => {
        entered.resolve(true)
        await release.promise
        return 'accepted'
      })
      const payload = {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Dispatch this once.',
        messageId: BotGroupMessageId('bot-group-message-cross-host-claim'),
      }
      const first = value.service.handle('bots/share/send-group-message', payload, new AbortController().signal, owner.peer)
      await entered.promise
      const second = await secondary.service.handle(
        'bots/share/send-group-message', payload, new AbortController().signal, admitted.peer,
      )
      expect(second).toMatchObject({
        ok: true,
        value: {
          status: 'partial',
          deliveries: [{ botId: 'bot-chief', status: 'failed', error: 'Shared Bot group delivery is already in progress' }],
        },
      })
      expect(secondary.host.deliverSharedGroup).not.toHaveBeenCalled()
      release.resolve(true)
      await expect(first).resolves.toMatchObject({ ok: true, value: { status: 'accepted' } })
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('cleans pending deliveries and response reservations when a Bot leaves the roster', async () => {
    const value = await fixture(10, true, true)
    try {
      const chiefOwner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-third'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      const owner = await principal(value, chiefOwner)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Roster cleanup room',
        botIds: [BotId('bot-chief'), BotId('bot-second'), BotId('bot-third')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const secondary = await secondaryFixture(value, true, true)
      try {
        const admitted = await secondary.authority.admit(request(cookie(chiefOwner)))
        if (!('peer' in admitted)) throw new Error('secondary Host rejected an active shared principal')
        const entered = Promise.withResolvers<boolean>()
        const release = Promise.withResolvers<boolean>()
        value.host.deliverSharedGroup.mockImplementation(async () => {
          entered.resolve(true)
          await release.promise
          return 'accepted'
        })
        const messageId = BotGroupMessageId('bot-group-message-roster-removal')
        const send = value.service.handle('bots/share/send-group-message', {
          groupId,
          targetBotIds: [BotId('bot-chief')],
          text: 'Remove the target while it is in flight.',
          messageId,
        }, new AbortController().signal, owner.peer)
        await entered.promise
        const updateResult = await secondary.service.handle('bots/share/update-group', {
          groupId,
          name: 'Roster cleanup room without chief',
          botIds: [BotId('bot-second'), BotId('bot-third')],
        }, new AbortController().signal, admitted.peer)
        expect(updateResult).toMatchObject({
          ok: true,
          value: { group: { botIds: ['bot-second', 'bot-third'] } },
        })
        release.resolve(true)
        await expect(send).resolves.toMatchObject({ ok: true })
        const inspected = await value.service.handle('bots/share/inspect-group', {
          groupId,
        }, new AbortController().signal, owner.peer)
        expect(inspected).toMatchObject({
          ok: true,
          value: { deliveries: [{ botId: 'bot-chief', status: 'failed', error: 'Shared Bot group Bot was removed from the roster' }] },
        })
        const extension = await value.authority.readExtension('agent-bots/shared-memberships')
        const membership = sharedMembershipSnapshotSchema.parse(extension.value)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const delivery = groups.deliveries.find(candidate => candidate.messageId === messageId)
        expect(delivery?.status).toBe('failed')
        expect(groups.responseReservations).not.toContain(delivery?.id)
      } finally {
        await secondary.close()
      }
    } finally {
      await value.close()
    }
  })

  it('replays a committed pending delivery after a Host restart', async () => {
    const value = await fixture(10, true)
    let secondary: SecondaryFixture | undefined
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Restart recovery room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageId = BotGroupMessageId('bot-group-message-restart-recovery')
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Recover this committed pending delivery.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      })
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const delivery = groups.deliveries.find(candidate => candidate.messageId === messageId && candidate.botId === BotId('bot-chief'))
        if (delivery === undefined) throw new Error('missing delivery fixture')
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: {
              ...groups,
              deliveries: groups.deliveries.map(candidate => candidate.id === delivery.id
                ? {
                  ...candidate,
                  status: 'pending' as const,
                  dispatchToken: 'crashed-attempt',
                  dispatchLeaseUntil: 0,
                }
                : candidate),
              responseReservations: groups.responseReservations.includes(delivery.id)
                ? groups.responseReservations
                : [...groups.responseReservations, delivery.id],
            },
          },
        }
      })
      secondary = await secondaryFixture(value, true)
      const admitted = await secondary.authority.admit(request(cookie(ownerEnrollment)))
      if (!('peer' in admitted)) throw new Error('secondary Host rejected an active shared principal')
      await secondary.service.recoverSharedGroupDeliveries()
      expect(secondary.host.deliverSharedGroup).toHaveBeenCalledTimes(1)
      await expect(value.service.handle('bots/share/inspect-group', { groupId }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { deliveries: [{ botId: 'bot-chief', status: 'accepted' }] },
      })
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('does not recover a delivery after its source loses active Bot membership', async () => {
    const value = await fixture(10, true)
    let secondary: SecondaryFixture | undefined
    try {
      const chiefOwner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      const chiefCollaborator = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        enrollmentRequest(),
      )
      const secondCollaborator = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'collaborator')).code,
        request(cookie(chiefCollaborator)),
      )
      const owner = await principal(value, chiefOwner)
      const groupCreated = await value.service.handle('bots/share/create-group', {
        name: 'Recovery authorization room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(groupCreated)
      const groupInvite = await value.service.handle('bots/share/manage-group-members', {
        groupId,
        action: 'create-invite',
      }, new AbortController().signal, owner.peer)
      const groupEnrollment = await value.service.enroll(
        groupInviteCodeFromResult(groupInvite),
        request(cookie(secondCollaborator)),
      )
      const collaborator = await principal(value, groupEnrollment)
      const messageId = BotGroupMessageId('bot-group-message-recovery-membership-revoked')
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'This must not recover after membership revocation.',
        messageId,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      })
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const delivery = groups.deliveries.find(candidate => candidate.messageId === messageId)
        if (delivery === undefined) throw new Error('missing recovery authorization delivery')
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: {
              ...groups,
              deliveries: groups.deliveries.map(candidate => candidate.id === delivery.id
                ? {
                  ...candidate,
                  status: 'pending' as const,
                  dispatchToken: 'recovery-membership-stale',
                  dispatchLeaseUntil: 0,
                }
                : candidate),
              responseReservations: groups.responseReservations.includes(delivery.id)
                ? groups.responseReservations
                : [...groups.responseReservations, delivery.id],
            },
          },
        }
      })
      await expect(value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.principalId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true, value: { revoked: true } })
      secondary = await secondaryFixture(value, true)
      const admitted = await secondary.authority.admit(request(cookie(groupEnrollment)))
      if (!('peer' in admitted)) throw new Error('secondary Host rejected the still-active shared principal')
      await secondary.service.recoverSharedGroupDeliveries()
      expect(secondary.host.deliverSharedGroup).not.toHaveBeenCalled()
      await expect(value.service.handle('bots/share/inspect-group', { groupId }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { deliveries: [{ botId: 'bot-chief', status: 'failed', error: 'Shared Bot group authorization changed before delivery' }] },
      })
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('does not dispatch a second recipient while the first lease is renewed', async () => {
    vi.useFakeTimers()
    const clock = { value: 1_000 }
    const value = await fixture(10, true, false, clock)
    let secondary: SecondaryFixture | undefined
    try {
      const chiefOwner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(chiefOwner)),
      )
      const owner = await principal(value, chiefOwner)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Lease renewal room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      secondary = await secondaryFixture(value, true)
      const admitted = await secondary.authority.admit(request(cookie(chiefOwner)))
      if (!('peer' in admitted)) throw new Error('secondary Host rejected an active shared principal')
      const entered = Promise.withResolvers<boolean>()
      const release = Promise.withResolvers<boolean>()
      value.host.deliverSharedGroup.mockImplementation(async () => {
        entered.resolve(true)
        await release.promise
        return 'accepted'
      })
      const payload = {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Keep this recipient fence alive.',
        messageId: BotGroupMessageId('bot-group-message-lease-renewal'),
      }
      const first = value.service.handle('bots/share/send-group-message', payload, new AbortController().signal, owner.peer)
      await entered.promise
      clock.value += 10_001
      await vi.advanceTimersByTimeAsync(10_001)
      clock.value += 10_001
      await vi.advanceTimersByTimeAsync(10_001)
      clock.value += 10_001
      const second = await secondary.service.handle('bots/share/send-group-message', payload, new AbortController().signal, admitted.peer)
      expect(second).toMatchObject({ ok: true })
      expect(secondary.host.deliverSharedGroup).not.toHaveBeenCalled()
      release.resolve(true)
      await expect(first).resolves.toMatchObject({ ok: true, value: { status: 'accepted' } })
    } finally {
      await secondary?.close()
      await value.close()
      vi.useRealTimers()
    }
  })

  it('does not accept an authority delivery after its matching dispatch lease expires', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Expired authority lease room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageId = BotGroupMessageId('bot-group-message-expired-authority-lease')
      value.host.deliverSharedGroup.mockImplementationOnce(async () => {
        await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
          const membership = sharedMembershipSnapshotSchema.parse(current)
          const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
          const deliveries = groups.deliveries.map(delivery => delivery.messageId === messageId
            ? { ...delivery, dispatchLeaseUntil: value.clock.value - 1 }
            : delivery)
          return {
            value: undefined,
            next: { ...membership, sharedGroups: { ...groups, deliveries } },
          }
        })
        return 'accepted'
      })
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'This must remain retryable after lease takeover.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'partial',
          deliveries: [{ status: 'failed', error: 'Shared Bot group delivery is pending retry after its lease ended' }],
        },
      })
    } finally {
      await value.close()
    }
  })

  it('coalesces duplicate pending-delivery recovery timers', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true, false, { value: 1_000 })
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Recovery timer room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageId = BotGroupMessageId('bot-group-message-recovery-timer-dedupe')
      value.host.deliverSharedGroup.mockImplementation(async () => ({
        kind: 'busy' as const,
        retryAt: value.clock.value + 1_000,
      }))
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Retry this delivery once per timer.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true })
      value.clock.value = 31_001
      await value.service.recoverSharedGroupDeliveries()
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(1)
      value.clock.value = 62_000
      await vi.advanceTimersByTimeAsync(30_001)
      await Promise.resolve()
      await Promise.resolve()
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(2)
    } finally {
      await value.close()
      vi.useRealTimers()
    }
  })

  it('surfaces operator-required recipient recovery without scheduling an endless retry', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true, false, { value: 1_000 })
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Operator recovery room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      value.host.deliverSharedGroup.mockImplementation(async () => ({
        kind: 'busy' as const,
        retryAt: value.clock.value,
        recovery: 'operator-required' as const,
      }))
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Show the recovery status.',
        messageId: BotGroupMessageId('bot-group-message-operator-recovery'),
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'partial',
          deliveries: [{
            status: 'failed',
            error: 'Shared Bot recipient admission needs owner recovery after every Host is quiesced; confirmQuiescent is not verified',
          }],
        },
      })
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(1)
      const stored = await value.authority.readExtension('agent-bots/shared-memberships')
      const membership = sharedMembershipSnapshotSchema.parse(stored.value)
      const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
      expect(groups.deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          messageId: BotGroupMessageId('bot-group-message-operator-recovery'),
          botId: BotId('bot-chief'),
          status: 'failed',
          error: 'Shared Bot recipient admission needs owner recovery after every Host is quiesced; confirmQuiescent is not verified',
        }),
      ]))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(1)
      value.host.deliverSharedGroup.mockImplementation(async () => 'accepted')
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Show the recovery status.',
        messageId: BotGroupMessageId('bot-group-message-operator-recovery'),
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'accepted',
          deliveries: [{ status: 'accepted' }],
        },
      })
    } finally {
      await value.close()
      vi.useRealTimers()
    }
  })

  it('keeps a pending delivery recoverable when operator outcome writes fail twice', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true, false, { value: 1_000 })
    let restoreMutation: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Durable operator recovery room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      value.host.deliverSharedGroup.mockImplementation(async () => ({
        kind: 'busy' as const,
        retryAt: value.clock.value,
        recovery: 'operator-required' as const,
      }))
      const originalMutation = value.authority.mutateExtension.bind(value.authority)
      let outcomeFailures = 2
      const mutation = vi.spyOn(value.authority, 'mutateExtension')
      restoreMutation = () => { mutation.mockRestore() }
      mutation.mockImplementation(async (...args) => {
        if (value.host.deliverSharedGroup.mock.calls.length > 0 && outcomeFailures > 0) {
          outcomeFailures -= 1
          throw new Error('outcome write unavailable')
        }
        return originalMutation(...args)
      })

      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Recover this after two outcome write failures.',
        messageId: BotGroupMessageId('bot-group-message-double-outcome-failure'),
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'partial',
          deliveries: [{ status: 'failed' }],
        },
      })
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(1)

      value.host.deliverSharedGroup.mockImplementation(async () => 'accepted')
      value.clock.value = 31_001
      await vi.advanceTimersByTimeAsync(30_001)
      await Promise.resolve()
      await Promise.resolve()

      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(2)
      const stored = await value.authority.readExtension('agent-bots/shared-memberships')
      const membership = sharedMembershipSnapshotSchema.parse(stored.value)
      const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
      expect(groups.deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          messageId: BotGroupMessageId('bot-group-message-double-outcome-failure'),
          botId: BotId('bot-chief'),
          status: 'accepted',
        }),
      ]))
    } finally {
      restoreMutation?.()
      await value.close()
      vi.useRealTimers()
    }
  })

  it('does not let scheduled early recovery rows starve later pending rows', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Recovery pagination room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageIds = Array.from({ length: 65 }, (_, index) => BotGroupMessageId(`bot-group-message-recovery-pagination-${String(index)}`))
      for (const messageId of messageIds) {
        await expect(value.service.handle('bots/share/send-group-message', {
          groupId,
          targetBotIds: [BotId('bot-chief')],
          text: `Recovery pagination ${String(messageId)}.`,
          messageId,
        }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true })
      }
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const messageSet = new Set(messageIds.map(String))
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: {
              ...groups,
              deliveries: groups.deliveries.map(candidate => messageSet.has(String(candidate.messageId))
                ? {
                  ...candidate,
                  status: 'pending' as const,
                  dispatchToken: `recovery-pagination-${String(candidate.messageId)}`,
                  dispatchLeaseUntil: 0,
                }
                : candidate),
            },
          },
        }
      })
      value.host.deliverSharedGroup.mockImplementation(async () => ({
        kind: 'busy' as const,
        retryAt: Date.now() + 30_000,
      }))
      value.host.deliverSharedGroup.mockClear()
      await value.service.recoverSharedGroupDeliveries()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      await Promise.resolve()
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(65)
    } finally {
      await value.close()
      vi.useRealTimers()
    }
  })

  it('recovers pending deliveries with bounded concurrency', async () => {
    const value = await fixture(10, true)
    let secondary: SecondaryFixture | undefined
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Bounded recovery room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageIds = Array.from({ length: 5 }, (_, index) => BotGroupMessageId(`bot-group-message-bounded-recovery-${String(index)}`))
      for (const messageId of messageIds) {
        await expect(value.service.handle('bots/share/send-group-message', {
          groupId,
          targetBotIds: [BotId('bot-chief')],
          text: `Bounded recovery ${String(messageId)}.`,
          messageId,
        }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true, value: { status: 'accepted' } })
      }
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const messageSet = new Set(messageIds.map(String))
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: {
              ...groups,
              deliveries: groups.deliveries.map(candidate => messageSet.has(String(candidate.messageId))
                ? {
                  ...candidate,
                  status: 'pending' as const,
                  dispatchToken: `bounded-recovery-${String(candidate.messageId)}`,
                  dispatchLeaseUntil: 0,
                }
                : candidate),
            },
          },
        }
      })
      secondary = await secondaryFixture(value, true)
      let active = 0
      let maxActive = 0
      secondary.host.deliverSharedGroup.mockImplementation(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
        return 'accepted'
      })
      await secondary.service.recoverSharedGroupDeliveries()
      expect(maxActive).toBeGreaterThan(1)
      expect(maxActive).toBeLessThanOrEqual(4)
      expect(secondary.host.deliverSharedGroup).toHaveBeenCalledTimes(5)
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('bounds the startup authority read instead of hanging recovery', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true)
    try {
      vi.spyOn(value.authority, 'readExtension').mockImplementation(() => new Promise(() => {}))
      const recovery = value.service.recoverSharedGroupDeliveries()
      const rejected = expect(recovery).rejects.toMatchObject({ code: 'gateway/unavailable' })
      await vi.advanceTimersByTimeAsync(5_001)
      await rejected
    } finally {
      await value.close()
      vi.useRealTimers()
    }
  })

  it('does not commit a late authority outcome after its mutation times out', async () => {
    vi.useFakeTimers()
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Late authority outcome room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageId = BotGroupMessageId('bot-group-message-late-authority-outcome')
      const authorityKey = credentialKey('client-connection', 'shared-access')
      const originalModifyRecord = value.credentials.modifyRecord.bind(value.credentials)
      const release = Promise.withResolvers<undefined>()
      let holdNextAuthorityMutation = false
      value.credentials.modifyRecord = (key, mutate) => {
        if (key !== authorityKey || !holdNextAuthorityMutation) return originalModifyRecord(key, mutate)
        holdNextAuthorityMutation = false
        return originalModifyRecord(key, async (stored) => {
          await release.promise
          return mutate(stored)
        })
      }
      value.host.deliverSharedGroup.mockImplementationOnce(async () => {
        holdNextAuthorityMutation = true
        throw new Error('late isolated delivery failure')
      })
      const send = value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Do not commit a late failure outcome.',
        messageId,
      }, new AbortController().signal, owner.peer)
      await vi.advanceTimersByTimeAsync(5_001)
      await expect(send).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'partial',
          deliveries: [{
            status: 'failed',
            error: 'Shared Bot group delivery outcome is pending bounded durable recovery',
          }],
        },
      })
      release.resolve(undefined)
      await Promise.resolve()
      await Promise.resolve()
      const extension = await value.authority.readExtension('agent-bots/shared-memberships')
      const membership = sharedMembershipSnapshotSchema.parse(extension.value)
      const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
      expect(groups.deliveries.find(delivery => delivery.messageId === messageId)?.status).toBe('pending')
    } finally {
      await value.close()
      vi.useRealTimers()
    }
  })

  it('keeps a partial shared-group delivery retryable by message id', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Retry room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      if (!created.ok) throw new Error('shared group creation failed')
      const groupId = groupIdFromResult(created)
      const original = value.host.deliverSharedGroup.getMockImplementation()
      let failSecond = true
      value.host.deliverSharedGroup.mockImplementation(async (request) => {
        if (request.targetBotId === BotId('bot-second') && failSecond) {
          failSecond = false
          throw new Error('injected isolated Session failure')
        }
        return original === undefined ? 'accepted' : await original(request)
      })
      const messageId = BotGroupMessageId('bot-group-message-partial-retry')
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        text: 'Retry this message.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'partial', deliveries: [{ status: 'accepted' }, { status: 'failed' }] },
      })
      await value.service.recoverSharedGroupDeliveries()
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(2)
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        text: 'Retry this message.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'accepted', deliveries: [{ status: 'duplicate' }, { status: 'accepted' }] },
      })
      expect(value.host.deliverSharedGroup).toHaveBeenCalledTimes(3)
    } finally {
      await value.close()
    }
  })

  it('does not overwrite a durable accepted delivery when isolated response fails late', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Delivery fence room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      value.host.deliverSharedGroup.mockImplementation(async (requestValue) => {
        await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
          const membership = sharedMembershipSnapshotSchema.parse(current)
          const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
          const deliveries = groups.deliveries.map(delivery => delivery.messageId === requestValue.messageId
            && delivery.botId === requestValue.targetBotId
            ? (() => {
              const { dispatchToken: _dispatchToken, dispatchLeaseUntil: _dispatchLeaseUntil, ...withoutLease } = delivery
              return { ...withoutLease, status: 'accepted' as const }
            })()
            : delivery)
          return {
            value: undefined,
            next: {
              ...membership,
              sharedGroups: {
                ...groups,
                deliveries,
                responseReservations: groups.responseReservations,
              },
            },
          }
        })
        throw new Error('late transport failure')
      })

      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Race this delivery.',
        messageId: BotGroupMessageId('bot-group-message-delivery-fence'),
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { status: 'partial' },
      })
      await expect(value.service.handle('bots/share/inspect-group', { groupId }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { deliveries: [{ status: 'accepted' }] },
      })
    } finally {
      await value.close()
    }
  })

  it('never downgrades a delivered result when accepted settlement write fails', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Accepted settlement room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const messageId = BotGroupMessageId('bot-group-message-accepted-settlement')
      value.host.deliverSharedGroup.mockImplementation(async () => 'accepted')
      const originalMutation = value.authority.mutateExtension.bind(value.authority)
      let postDeliveryMutations = 0
      const mutation = vi.spyOn(value.authority, 'mutateExtension')
      mutation.mockImplementation(async (...args) => {
        if (value.host.deliverSharedGroup.mock.calls.length > 0) {
          postDeliveryMutations += 1
          if (postDeliveryMutations === 2) throw new Error('accepted settlement write unavailable')
        }
        return originalMutation(...args)
      })

      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        targetBotIds: [BotId('bot-chief')],
        text: 'Keep this delivery accepted after settlement retry.',
        messageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: {
          status: 'accepted',
          deliveries: [{ status: 'accepted' }],
        },
      })

      const stored = await value.authority.readExtension('agent-bots/shared-memberships')
      const membership = sharedMembershipSnapshotSchema.parse(stored.value)
      const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
      const delivery = groups.deliveries.find(candidate => candidate.messageId === messageId && candidate.botId === BotId('bot-chief'))
      expect(delivery).toMatchObject({ status: 'accepted' })
      expect(delivery === undefined ? false : groups.responseReservations.includes(delivery.id)).toBe(true)
    } finally {
      await value.close()
    }
  })

  it('rejects a group send before delivery when the durable transcript has no response capacity', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Capacity room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const messages = Array.from({ length: 8_192 }, (_, index) => ({
          id: BotGroupMessageId(`bot-group-message-capacity-${String(index)}`),
          groupId,
          sender: { kind: 'user' as const, principalId: owner.botPrincipalId },
          text: 'Reserved transcript slot.',
          createdAt: index + 1,
        }))
        return {
          value: undefined,
          next: { ...membership, sharedGroups: { ...groups, messages } },
        }
      })
      value.host.deliverSharedGroup.mockClear()
      const result = await value.service.handle('bots/share/send-group-message', {
        groupId,
        text: 'This must not reach a Session.',
        messageId: BotGroupMessageId('bot-group-message-capacity-new'),
      }, new AbortController().signal, owner.peer)
      expect(result).toMatchObject({ ok: false, error: { code: 'gateway/unavailable' } })
      expect(value.host.deliverSharedGroup).not.toHaveBeenCalled()
    } finally {
      await value.close()
    }
  })

  it('turns a response into a durable failure when projection capacity is exhausted after delivery', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Projection capacity room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      const sourceMessageId = BotGroupMessageId('bot-group-message-projection-capacity')
      await expect(value.service.handle('bots/share/send-group-message', {
        groupId,
        text: 'Reserve a response slot.',
        messageId: sourceMessageId,
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({ ok: true })
      await value.service.recordSharedGroupMessageClaims(
        groupId,
        BotId('bot-chief'),
        [{ groupId, messageId: sourceMessageId }],
        1,
        1,
        true,
        false,
      )
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const fillers = Array.from({ length: 8_192 - groups.messages.length }, (_, index) => ({
          id: BotGroupMessageId(`bot-group-message-projection-filler-${String(index)}`),
          groupId,
          sender: { kind: 'user' as const, principalId: owner.botPrincipalId },
          text: 'Reserved transcript slot.',
          createdAt: 2_000 + index,
        }))
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: { ...groups, messages: [...groups.messages, ...fillers] },
          },
        }
      })

      await expect(value.service.recordSharedGroupResponse(
        groupId,
        BotId('bot-chief'),
        1,
        1,
        'The response cannot be projected.',
        'model-response-projection-capacity',
      )).resolves.toBeUndefined()

      const stored = sharedMembershipSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-memberships')).value,
      )
      const groups = sharedGroupSnapshotSchema.parse(stored.sharedGroups)
      const delivery = groups.deliveries.find(candidate => candidate.groupId === groupId
        && candidate.botId === BotId('bot-chief') && candidate.messageId === sourceMessageId)
      expect(delivery).toMatchObject({
        status: 'failed',
        error: 'Shared Bot group transcript capacity is exhausted',
      })
      expect(delivery === undefined ? true : groups.responseReservations.includes(delivery.id)).toBe(false)
      expect(groups.messages).toHaveLength(8_192)
    } finally {
      await value.close()
    }
  })

  it('prunes expired group invites and rejects a full member append before authority redemption', async () => {
    const value = await fixture(10, true)
    try {
      const ownerEnrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'owner')).code,
        request(cookie(ownerEnrollment)),
      )
      const owner = await principal(value, ownerEnrollment)
      const created = await value.service.handle('bots/share/create-group', {
        name: 'Invite capacity room',
        botIds: [BotId('bot-chief'), BotId('bot-second')],
      }, new AbortController().signal, owner.peer)
      const groupId = groupIdFromResult(created)
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const expiredInvites = Array.from({ length: 1_024 }, () => ({
          digest: 'a'.repeat(43),
          groupId,
          createdBy: owner.botPrincipalId,
          createdAt: 0,
          expiresAt: 1,
        }))
        return { value: undefined, next: { ...membership, sharedGroups: { ...groups, invites: expiredInvites } } }
      })
      const expiredInvite = await value.service.handle('bots/share/manage-group-members', {
        groupId,
        action: 'create-invite',
      }, new AbortController().signal, owner.peer)
      expect(expiredInvite).toMatchObject({ ok: true, value: { expiresAt: 61_000 } })
      let snapshot = sharedGroupSnapshotSchema.parse(
        sharedMembershipSnapshotSchema.parse(
          (await value.authority.readExtension('agent-bots/shared-memberships')).value,
        ).sharedGroups,
      )
      expect(snapshot.invites).toHaveLength(1)

      const collaboratorChief = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        enrollmentRequest(),
      )
      const collaboratorSecond = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-second'), 'collaborator')).code,
        request(cookie(collaboratorChief)),
      )
      const groupInvite = await value.service.handle('bots/share/manage-group-members', {
        groupId,
        action: 'create-invite',
      }, new AbortController().signal, owner.peer)
      const groupInviteCode = groupInviteCodeFromResult(groupInvite)
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const membership = sharedMembershipSnapshotSchema.parse(current)
        const groups = sharedGroupSnapshotSchema.parse(membership.sharedGroups)
        const group = groups.groups.find(candidate => candidate.id === groupId)
        if (group === undefined) throw new Error('group missing in member-capacity fixture')
        const members = [group.ownerPrincipalId, ...Array.from({ length: 255 }, (_, index) =>
          BotPrincipalId(`principal-full-member-${String(index)}`))]
        return {
          value: undefined,
          next: {
            ...membership,
            sharedGroups: {
              ...groups,
              groups: groups.groups.map(candidate => candidate.id === groupId
                ? { ...candidate, memberPrincipalIds: members }
                : candidate),
            },
          },
        }
      })
      await expect(value.service.enroll(groupInviteCode, request(cookie(collaboratorSecond))))
        .rejects.toMatchObject({ code: 'gateway/unavailable' })
      snapshot = sharedGroupSnapshotSchema.parse(
        sharedMembershipSnapshotSchema.parse(
          (await value.authority.readExtension('agent-bots/shared-memberships')).value,
        ).sharedGroups,
      )
      expect(snapshot.groups.find(group => group.id === groupId)?.memberPrincipalIds).toHaveLength(256)
      expect(snapshot.invites).toEqual(expect.arrayContaining([
        expect.objectContaining({ groupId, digest: sharedInviteDigest(groupInviteCode) }),
      ]))
    } finally {
      await value.close()
    }
  })

  it('caps membership polling at Node’s maximum timer delay', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const lastCall = setIntervalSpy.mock.calls.at(-1)
      expect(lastCall?.[1]).toBe(2_147_483_647)
    } finally {
      await value.close()
      setIntervalSpy.mockRestore()
    }
  })

  it('enrolls a member and exposes only that member’s Bot roster', async () => {
    const value = await fixture()
    try {
      expect(SHARED_BOT_ENDPOINTS).toContain('bots/share/list')
      expect(SHARED_BOT_ENDPOINTS).not.toContain('bots/share/manage-profile')
      const invite = await value.service.createInvite(BotId('bot-chief'), 'owner')
      expect(sharedInviteSchema.parse({
        digest: sharedInviteDigest(invite.code),
        botId: BotId('bot-chief'),
        role: 'owner',
        createdAt: 1_000,
        expiresAt: invite.expiresAt,
      })).toHaveProperty('digest', sharedInviteDigest(invite.code))
      const enrollment = await value.service.enroll(invite.code, enrollmentRequest())
      const { peer } = await principal(value, enrollment)
      await expect(value.service.handle('bots/share/list', {}, new AbortController().signal, peer)).resolves.toMatchObject({
        ok: true,
        value: { bots: [{ id: 'bot-chief', role: 'owner' }] },
      })
      await expect(value.service.handle('bots/share/read-profile', { botId: 'bot-missing' }, new AbortController().signal, peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      const outsider = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const outsiderPrincipal = await principal(value, outsider)
      await expect(value.service.handle('bots/share/read-profile', { botId: 'bot-missing' }, new AbortController().signal, outsiderPrincipal.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
    } finally {
      await value.close()
    }
  })

  it('reuses an active principal for a repeated invite without revoking its membership', async () => {
    const value = await fixture()
    try {
      await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const first = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        enrollmentRequest(),
      )
      const firstPrincipal = await principal(value, first)
      const repeated = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        request(cookie(first)),
      )
      const repeatedPrincipal = await principal(value, repeated)

      expect(repeatedPrincipal.botPrincipalId).toBe(firstPrincipal.botPrincipalId)
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ principalId: firstPrincipal.botPrincipalId, role: 'collaborator' }),
      ]))
      await expect(value.service.handle(
        'bots/share/list', {}, new AbortController().signal, repeatedPrincipal.peer,
      )).resolves.toMatchObject({ ok: true, value: { bots: [{ id: 'bot-chief', role: 'collaborator' }] } })
    } finally {
      await value.close()
    }
  })

  it('creates one durable private Session per principal and reloads its binding', async () => {
    const value = await fixture()
    try {
      const first = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const second = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const firstPeer = await principal(value, first)
      const secondPeer = await principal(value, second)
      const signal = new AbortController().signal
      await expect(value.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'hello' }, signal, firstPeer.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'private' }, signal, secondPeer.peer)).resolves.toMatchObject({ ok: true })
      expect(value.host.sessions.size).toBe(2)
      expect(new Set([...value.host.sessions.values()].map(session => session.principalId)).size).toBe(2)

      await value.service.dispose()
      const reloaded = await SharedBotService.create(value.ctx, value.facility, value.authority, value.host, {
        now: () => 1_000,
        membershipPollIntervalMs: 10,
      })
      const firstAgain = await principal(value, first)
      expect(reloaded.privateSessionBindings()).toContainEqual(expect.objectContaining({
        botId: BotId('bot-chief'),
        principalId: firstPeer.botPrincipalId,
      }))
      await expect(reloaded.handle('bots/share/chat', { botId: 'bot-chief', text: 'after restart' }, signal, firstAgain.peer)).resolves.toMatchObject({ ok: true })
      expect(reloaded.sessionFor(BotId('bot-chief'), firstPeer.botPrincipalId)).toBeDefined()
      await reloaded.dispose()
    } finally {
      await value.authority.dispose()
      await value.ctx.fiber.dispose()
    }
  })

  it('does not reattach a revoked private Session after a service restart', async () => {
    const value = await fixture()
    let reloaded: SharedBotService | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'establish a private Session',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const original = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      if (original === undefined) throw new Error('private Session binding was not created')
      await value.authority.mutateExtension('agent-bots/shared-private-sessions', (current) => {
        const snapshot = privateSessionSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: {
            ...snapshot,
            bindings: snapshot.bindings.map(binding => binding.sessionId === original.sessionId
              ? { ...binding, revokedAt: 2_000 }
              : binding),
          },
        }
      })

      await value.service.dispose()
      reloaded = await SharedBotService.create(value.ctx, value.facility, value.authority, value.host, {
        now: () => 2_000,
        membershipPollIntervalMs: 10,
      })
      expect(reloaded.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
      expect(reloaded.privateSessionBindings()).toEqual([])
      await expect(reloaded.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'start a fresh private Session',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      expect(reloaded.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)?.sessionId)
        .not.toBe(original.sessionId)
    } finally {
      await reloaded?.dispose()
      await value.authority.dispose()
      await value.ctx.fiber.dispose()
    }
  })

  it('enforces role authorization and revokes a member’s shared access', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      const signal = new AbortController().signal
      await expect(value.service.handle('bots/share/manage-profile', { botId: 'bot-chief', name: 'Changed' }, signal, collaborator.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      expect((await value.host.findBot(BotId('bot-chief')))?.name).toBe('Chief of staff')
      await expect(value.service.handle('bots/share/manage-profile', { botId: 'bot-chief', name: 'Changed' }, signal, owner.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      await expect(value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'create-invite', role: 'manager',
      }, signal, owner.peer)).resolves.toMatchObject({ ok: true, value: { role: 'manager' } })
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'keep this private',
      }, signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.principalId,
      }, signal, owner.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.handle('bots/share/list', {}, signal, collaborator.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      expect(await value.authority.admit(request(cookie(collaboratorEnrollment)))).toHaveProperty('peer')
      expect(value.host.cancellations).toHaveBeenCalledWith(expect.stringMatching(/^shared-session-/))
    } finally {
      await value.close()
    }
  })

  it('keeps private transcripts separate from explicitly enabled shared context', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      expect(SHARED_BOT_ENDPOINTS).toEqual(expect.arrayContaining([
        'bots/share/read-memory', 'bots/share/write-memory', 'bots/share/manage-memory',
      ]))
      await expect(value.service.readMemoryPolicy(BotId('bot-chief'))).resolves.toMatchObject({
        botId: BotId('bot-chief'), enabled: false,
      })
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'private note',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true, value: { enabled: false, entries: [] },
      })

      await expect(value.service.setMemoryPolicy(BotId('bot-chief'), true)).resolves.toMatchObject({ enabled: true })
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-chief', text: 'Launch notes', consent: true,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true, value: { entry: { text: 'Launch notes', principalId: collaborator.principalId } },
      })
      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-chief',
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { enabled: true, entries: [{ text: 'Launch notes', principalId: collaborator.principalId }] },
      })
      const privateTranscript = await value.service.handle('bots/share/read-private-chat', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)
      expect(privateTranscript).toMatchObject({ ok: true, value: { recent: expect.any(Array) } })
      expect(JSON.stringify([...value.host.messages.values()])).toContain('private note')
      expect(JSON.stringify(privateTranscript)).not.toContain('Launch notes')
    } finally {
      await value.close()
    }
  })

  it('authorizes shared-memory reads before Bot lookup and does not mutate authority storage', async () => {
    const value = await fixture()
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      const mutation = vi.spyOn(value.authority, 'mutateExtension')

      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-missing',
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-chief',
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true,
        value: { botId: 'bot-chief', enabled: false, entries: [] },
      })
      expect(mutation).not.toHaveBeenCalled()
      mutation.mockRestore()
    } finally {
      await value.close()
    }
  })

  it('does not return a roster after a deferred Bot deletion', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      let enteredResolve: (() => void) | undefined
      let releaseResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalListBots = value.host.listBots
      let first = true
      value.host.listBots = async (signal) => {
        const bots = await originalListBots(signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bots
      }

      const pending = value.service.handle(
        'bots/share/list',
        {},
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
    } finally {
      await value.close()
    }
  })

  it('does not return a profile after a deferred Bot deletion', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      let enteredResolve: (() => void) | undefined
      let releaseResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalFindBot = value.host.findBot
      let first = true
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const pending = value.service.handle(
        'bots/share/read-profile',
        { botId: 'bot-chief' },
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'bot/not-found' },
      })
    } finally {
      await value.close()
    }
  })

  it('does not return a private transcript after a deferred Bot deletion', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      await expect(value.service.handle(
        'bots/share/chat',
        { botId: 'bot-chief', text: 'establish a private Session' },
        new AbortController().signal,
        owner.peer,
      )).resolves.toMatchObject({ ok: true })

      let enteredResolve: (() => void) | undefined
      let releaseResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalInspect = value.host.inspectPrivateSession
      value.host.inspectPrivateSession = async (sessionId, signal) => {
        const inspection = await originalInspect(sessionId, signal)
        enteredResolve?.()
        await release
        return inspection
      }

      const pending = value.service.handle(
        'bots/share/read-private-chat',
        { botId: 'bot-chief' },
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'bot/not-found' },
      })
    } finally {
      await value.close()
    }
  })

  it('does not return shared memory after a deferred Bot deletion', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      let enteredResolve: (() => void) | undefined
      let releaseResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalFindBot = value.host.findBot
      let first = true
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const pending = value.service.handle(
        'bots/share/read-memory',
        { botId: 'bot-chief' },
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'bot/not-found' },
      })
    } finally {
      await value.close()
    }
  })

  it.each([
    ['write-memory', { botId: 'bot-chief', text: 'late note', consent: true }],
    ['manage-memory', { botId: 'bot-chief', enabled: true }],
  ] as const)('does not mutate shared memory for %s after a deferred Bot deletion', async (endpoint, payload) => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      if (endpoint === 'write-memory') {
        await expect(value.service.setMemoryPolicy(BotId('bot-chief'), true)).resolves.toMatchObject({ enabled: true })
      }
      let enteredResolve: (() => void) | undefined
      let releaseResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalFindBot = value.host.findBot
      let first = true
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const pending = value.service.handle(
        `bots/share/${endpoint}`,
        payload,
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'bot/not-found' },
      })
      const snapshot = sharedMembershipSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-memberships')).value,
      )
      expect(snapshot.sharedMemory?.entries ?? []).toEqual([])
      expect(snapshot.sharedMemory?.policies ?? []).toEqual(endpoint === 'write-memory' ? [
        { botId: BotId('bot-chief'), enabled: true, updatedAt: 1_000 },
      ] : [])
    } finally {
      await value.close()
    }
  })

  it('does not persist an operator policy after a deferred Bot deletion', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      await value.service.createInvite(BotId('bot-chief'), 'owner')
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalFindBot = value.host.findBot
      let first = true
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const pending = value.service.setMemoryPolicy(BotId('bot-chief'), true)
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).rejects.toMatchObject({ code: 'bot/not-found' })
      const snapshot = sharedMembershipSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-memberships')).value,
      )
      expect(snapshot.sharedMemory?.policies ?? []).toEqual([])
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not issue an invite after a Bot is deleted during the existence fence', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      const owner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const before = pendingInviteCount(value.records.get(credentialKey('client-connection', 'shared-access')))
      const originalFindBot = value.host.findBot
      let first = true
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const ownerPrincipal = await principal(value, owner)
      const pending = value.service.createInvite(BotId('bot-chief'), 'collaborator', ownerPrincipal.botPrincipalId)
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).rejects.toMatchObject({ code: 'bot/not-found' })
      expect(pendingInviteCount(value.records.get(credentialKey('client-connection', 'shared-access')))).toBe(before)
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not redeem an invite after a Bot is deleted during the existence fence', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      const invite = await value.service.createInvite(BotId('bot-chief'), 'owner')
      const originalFindBot = value.host.findBot
      let first = true
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const pending = value.service.enroll(invite.code, enrollmentRequest())
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).rejects.toMatchObject({ code: 'bot/not-found' })
      expect(pendingInviteCount(value.records.get(credentialKey('client-connection', 'shared-access')))).toBe(1)
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not revoke a member after a Bot is deleted during the existence fence', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      const owner = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const collaborator = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code,
        enrollmentRequest(),
      )
      const originalFindBot = value.host.findBot
      let first = true
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.findBot = async (botId, signal) => {
        const bot = await originalFindBot(botId, signal)
        if (first) {
          first = false
          enteredResolve?.()
          await release
        }
        return bot
      }

      const ownerPrincipal = await principal(value, owner)
      const collaboratorPrincipal = await principal(value, collaborator)
      const pending = value.service.revokeMember(
        BotId('bot-chief'), collaboratorPrincipal.botPrincipalId, ownerPrincipal.botPrincipalId,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).rejects.toMatchObject({ code: 'bot/not-found' })
      const snapshot = sharedMembershipSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-memberships')).value,
      )
      expect(snapshot.memberships.filter(member => member.botId === BotId('bot-chief'))).toHaveLength(2)
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not create a private Session after a Bot is deleted during the existence fence', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      const originalWithBot = value.host.withBot
      let first = true
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.withBot = async (botId, signal, operation) => {
        if (first) {
          first = false
          enteredResolve?.()
          await release
          return { found: false }
        }
        return originalWithBot(botId, signal, operation)
      }

      const pending = value.service.handle(
        'bots/share/chat',
        { botId: 'bot-chief', text: 'must not create a Session' },
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'bot/not-found' } })
      expect(value.host.sessions).toEqual(new Map())
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not inspect Bot storage while an authority mutation is held', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    try {
      const originalFindBot = value.host.findBot
      let authorityMutationActive = false
      const originalMutation = value.authority.mutateExtension.bind(value.authority)
      const mutation = vi.spyOn(value.authority, 'mutateExtension')
      mutation.mockImplementation(async (...args) => {
        authorityMutationActive = true
        try {
          return await originalMutation(...args)
        } finally {
          authorityMutationActive = false
        }
      })
      value.host.findBot = async (botId, signal) => {
        if (authorityMutationActive) throw new Error('nested Bot lookup while authority mutation is held')
        return originalFindBot(botId, signal)
      }

      await expect(value.service.setMemoryPolicy(BotId('bot-chief'), true)).resolves.toMatchObject({ enabled: true })
      mutation.mockRestore()
    } finally {
      await value.close()
    }
  })

  it('checks Bot existence before emitting a private chat follow-up', async () => {
    const value = await fixture(Number.MAX_SAFE_INTEGER)
    let releaseResolve: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll(
        (await value.service.createInvite(BotId('bot-chief'), 'owner')).code,
        enrollmentRequest(),
      )
      const owner = await principal(value, enrollment)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const originalResolve = value.host.resolvePrivateAgent
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        const resolved = await originalResolve(sessionId, signal)
        enteredResolve?.()
        await release
        return resolved
      }

      const pending = value.service.handle(
        'bots/share/chat',
        { botId: 'bot-chief', text: 'late follow-up' },
        new AbortController().signal,
        owner.peer,
      )
      await entered
      value.host.removeBot(BotId('bot-chief'))
      releaseResolve?.()

      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'bot/not-found' },
      })
      expect(value.host.followups).not.toHaveBeenCalled()
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('requires consent for shared writes and clears entries when shared context is disabled', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-chief', text: 'without consent', consent: false,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/bad-request' },
      })
      await value.service.setMemoryPolicy(BotId('bot-chief'), true)
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-chief', text: 'shared note', consent: true,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.setMemoryPolicy(BotId('bot-chief'), false)).resolves.toMatchObject({ enabled: false })
      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-chief',
      }, new AbortController().signal, owner.peer)).resolves.toMatchObject({
        ok: true, value: { enabled: false, entries: [] },
      })
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-chief', text: 'after disable', consent: true,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
    } finally {
      await value.close()
    }
  })

  it('applies shared-context entry quotas per Bot', async () => {
    const value = await fixture(10, true)
    try {
      const chiefOwnerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const secondOwnerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-second'), 'owner')).code, enrollmentRequest())
      const chiefOwner = await principal(value, chiefOwnerEnrollment)
      const secondOwner = await principal(value, secondOwnerEnrollment)
      const entries = Array.from({ length: 512 }, (_, index) => ({
        id: `memory-chief-${String(index)}`,
        botId: BotId('bot-chief'),
        principalId: chiefOwner.botPrincipalId,
        text: `Chief note ${String(index)}`,
        createdAt: 1_000,
      }))
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const snapshot = sharedMembershipSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: {
            ...snapshot,
            sharedMemory: sharedMemorySnapshotSchema.parse({
              policies: [
                { botId: BotId('bot-chief'), enabled: true, updatedAt: 1_000 },
                { botId: BotId('bot-second'), enabled: true, updatedAt: 1_000 },
              ],
              entries,
            }),
          },
        }
      })
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-second', text: 'Second Bot note', consent: true,
      }, new AbortController().signal, secondOwner.peer)).resolves.toMatchObject({
        ok: true, value: { entry: { text: 'Second Bot note' } },
      })
    } finally {
      await value.close()
    }
  })

  it('rejects shared-context policy mutations beyond the policy limit', async () => {
    const value = await fixture(10, true)
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-second'), 'owner')).code, enrollmentRequest())
      const policies = Array.from({ length: 256 }, (_, index) => ({
        botId: BotId(`bot-policy-${String(index)}`),
        enabled: true,
        updatedAt: 1_000,
      }))
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const snapshot = sharedMembershipSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: {
            ...snapshot,
            sharedMemory: sharedMemorySnapshotSchema.parse({ policies, entries: [] }),
          },
        }
      })
      await expect(value.service.setMemoryPolicy(BotId('bot-second'), true)).rejects.toMatchObject({
        code: 'gateway/unavailable',
      })
      const persisted = sharedMembershipSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-memberships')).value,
      )
      expect(persisted.sharedMemory?.policies).toHaveLength(256)
    } finally {
      await value.close()
    }
  })

  it('scopes shared-context permissions to managers and revocation', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const managerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'manager')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const manager = await principal(value, managerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/manage-memory', {
        botId: 'bot-chief', enabled: true,
      }, new AbortController().signal, manager.peer)).resolves.toMatchObject({
        ok: true, value: { enabled: true },
      })
      await expect(value.service.handle('bots/share/write-memory', {
        botId: 'bot-chief', text: 'manager context', consent: true,
      }, new AbortController().signal, manager.peer)).resolves.toMatchObject({ ok: true })
      await expect(value.service.handle('bots/share/manage-memory', {
        botId: 'bot-chief', enabled: false,
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      await expect(value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId, owner.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await expect(value.service.handle('bots/share/read-memory', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
    } finally {
      await value.close()
    }
  })

  it('lists members for the owner and scopes direct revocation to one Bot', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      const members = await value.service.listMembers(BotId('bot-chief'))
      expect(members.map(member => member.role)).toEqual(['owner', 'collaborator'])
      await expect(value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId)).resolves.toMatchObject({
        botId: BotId('bot-chief'), principalId: collaborator.botPrincipalId, revoked: true,
      })
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(1)
      await expect(value.service.revokeMember(BotId('bot-chief'), owner.botPrincipalId)).rejects.toThrow(/owner cannot be revoked/)
    } finally {
      await value.close()
    }
  })

  it('keeps one owner when separate services redeem owner invites concurrently', async () => {
    const value = await fixture()
    let secondary: SecondaryFixture | undefined
    try {
      const firstInvite = await value.service.createInvite(BotId('bot-chief'), 'owner')
      const secondInvite = await value.service.createInvite(BotId('bot-chief'), 'owner')
      secondary = await secondaryFixture(value)
      const [first, second] = await Promise.allSettled([
        value.service.enroll(firstInvite.code, enrollmentRequest()),
        secondary.service.enroll(secondInvite.code, enrollmentRequest()),
      ])
      expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
      const rejected = first.status === 'rejected' ? first : second
      if (rejected.status !== 'rejected') throw new Error('owner invite race did not reject one enrollment')
      expect(rejected.reason).toMatchObject({ code: 'gateway/bad-request' })
      const members = await value.service.listMembers(BotId('bot-chief'))
      expect(members.filter(member => member.role === 'owner')).toHaveLength(1)
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('rechecks durable membership before private chat and transcript reads in another service process', async () => {
    const value = await fixture()
    let secondary: SecondaryFixture | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      secondary = await secondaryFixture(value)
      const collaborator = await principal({ ...value, authority: secondary.authority }, collaboratorEnrollment)
      await expect(secondary.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'before revoke',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })

      await expect(value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await expect(secondary.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'after revoke',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      await expect(secondary.service.handle('bots/share/read-private-chat', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      await expect(secondary.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(1)
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('cancels an active Agent in another service after durable membership revocation', async () => {
    const value = await fixture()
    let secondary: SecondaryFixture | undefined
    let releaseResolve: (() => void) | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      secondary = await secondaryFixture(value)
      const collaborator = await principal({ ...value, authority: secondary.authority }, collaboratorEnrollment)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      secondary.host.flushPrivateSession = async () => {
        enteredResolve?.()
        await release
      }
      secondary.host.cancellations.mockImplementation(() => { releaseResolve?.() })

      const active = secondary.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'cross-process turn',
      }, new AbortController().signal, collaborator.peer)
      await entered
      await expect(value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await vi.waitFor(() => { expect(secondary?.host.cancellations).toHaveBeenCalledWith(expect.stringMatching(/^shared-session-/)) })
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })

      await secondary.close()
      secondary = await secondaryFixture(value)
      await expect(secondary.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(1)
    } finally {
      releaseResolve?.()
      await secondary?.close()
      await value.close()
    }
  })

  it('does not let one stalled Agent resolution block another removed member', async () => {
    const value = await fixture()
    let secondary: SecondaryFixture | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const firstEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const secondEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      secondary = await secondaryFixture(value)
      const first = await principal({ ...value, authority: secondary.authority }, firstEnrollment)
      const second = await principal({ ...value, authority: secondary.authority }, secondEnrollment)
      await expect(secondary.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'first' }, new AbortController().signal, first.peer)).resolves.toMatchObject({ ok: true })
      await expect(secondary.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'second' }, new AbortController().signal, second.peer)).resolves.toMatchObject({ ok: true })
      const firstBinding = secondary.service.sessionFor(BotId('bot-chief'), first.botPrincipalId)
      const secondBinding = secondary.service.sessionFor(BotId('bot-chief'), second.botPrincipalId)
      expect(firstBinding).toBeDefined()
      expect(secondBinding).toBeDefined()
      const originalResolve = secondary.host.resolvePrivateAgent
      secondary.host.resolvePrivateAgent = async (sessionId, signal) => {
        if (sessionId === firstBinding?.sessionId) await new Promise<void>(() => {})
        return originalResolve(sessionId, signal)
      }

      await expect(value.service.revokeMember(BotId('bot-chief'), first.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await expect(value.service.revokeMember(BotId('bot-chief'), second.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await vi.waitFor(() => { expect(secondary?.host.cancellations).toHaveBeenCalledWith(secondBinding?.sessionId) })
    } finally {
      await secondary?.close()
      await value.close()
    }
  })

  it('aborts bounded Agent resolution when the shared service is disposed', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'keep a session',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const originalResolve = value.host.resolvePrivateAgent
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        enteredResolve?.()
        await release
        return originalResolve(sessionId, signal)
      }

      const revoke = value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId)
      await entered
      await value.close()
      releaseResolve?.()
      await expect(revoke).rejects.toMatchObject({
        name: 'SharedServiceFault',
        code: 'gateway/unavailable',
      })
      expect(value.host.cancellations).not.toHaveBeenCalled()
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('aborts active shared requests before disposal drains the queue', async () => {
    const value = await fixture()
    let releaseFlush: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      let enteredFlush: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredFlush = resolve })
      const release = new Promise<void>((resolve) => { releaseFlush = resolve })
      let requestSignal: AbortSignal | undefined
      let flushSignal: AbortSignal | undefined
      const originalResolve = value.host.resolvePrivateAgent
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        requestSignal = signal
        return originalResolve(sessionId, signal)
      }
      value.host.flushPrivateSession = async (_sessionId, signal) => {
        flushSignal = signal
        enteredFlush?.()
        await release
      }
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'dispose me',
      }, new AbortController().signal, participant.peer)
      await entered
      const disposed = value.service.dispose()
      await vi.waitFor(() => { expect(requestSignal?.aborted).toBe(true) })
      expect(flushSignal?.aborted).toBe(true)
      releaseFlush?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      releaseFlush?.()
      await value.close()
    }
  })

  it('bounds disposal when a private flush never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    const flushGate = Promise.withResolvers<undefined>()
    const flushStarted = Promise.withResolvers<undefined>()
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      value.host.flushPrivateSession = async () => {
        flushStarted.resolve(undefined)
        await flushGate.promise
      }
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'flush timeout',
      }, new AbortController().signal, participant.peer)
      await flushStarted.promise
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/unavailable' } })

      let disposed = false
      const closing = value.service.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(closing).resolves.toBeUndefined()
    } finally {
      flushGate.resolve(undefined)
      vi.useRealTimers()
      await value.close()
    }
  })

  it('does not let a stalled membership read block service disposal', async () => {
    const value = await fixture(60_000)
    let enteredRead: (() => void) | undefined
    const entered = new Promise<void>((resolve) => { enteredRead = resolve })
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      value.authority.readExtension = async () => {
        enteredRead?.()
        await new Promise<void>(() => {})
        return { value: undefined, state: { principals: [] } }
      }
      const active = value.service.handle('bots/share/list', {}, new AbortController().signal, participant.peer)
      await entered
      const disposed = value.service.dispose()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      await value.close()
    }
  })

  it('aborts a shared request before a host list starts during disposal', async () => {
    const value = await fixture()
    let releaseList: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      let enteredList: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredList = resolve })
      const release = new Promise<void>((resolve) => { releaseList = resolve })
      let listSignal: AbortSignal | undefined
      value.host.listBots = async (signal) => {
        listSignal = signal
        enteredList?.()
        await release
        signal?.throwIfAborted()
        return []
      }

      const active = value.service.handle('bots/share/list', {}, new AbortController().signal, participant.peer)
      await entered
      const disposed = value.service.dispose()
      await vi.waitFor(() => { expect(listSignal?.aborted).toBe(true) })
      releaseList?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      releaseList?.()
      await value.close()
    }
  })

  it('waits for a live shared Agent to become idle during disposal', async () => {
    const value = await fixture()
    let releaseFlush: (() => void) | undefined
    let releaseIdle: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      let enteredFlush: (() => void) | undefined
      const flushStarted = new Promise<void>((resolve) => { enteredFlush = resolve })
      const flush = new Promise<void>((resolve) => { releaseFlush = resolve })
      let enteredIdle: (() => void) | undefined
      const idleStarted = new Promise<void>((resolve) => { enteredIdle = resolve })
      const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
      let cancelled = false
      let idleWaited = false
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        return {
          agent: {
            id: sessionId,
            followup: () => {},
            cancel: () => { cancelled = true },
            whenIdle: async () => {
              idleWaited = cancelled
              enteredIdle?.()
              await idle
            },
          },
        }
      }
      value.host.flushPrivateSession = async (_sessionId, signal) => {
        enteredFlush?.()
        await flush
        signal?.throwIfAborted()
      }

      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'dispose idle',
      }, new AbortController().signal, participant.peer)
      await flushStarted
      const disposed = value.service.dispose()
      const idleRace = await Promise.race([
        idleStarted.then(() => true),
        new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 100) }),
      ])
      expect(idleRace).toBe(true)
      expect(cancelled).toBe(true)
      expect(idleWaited).toBe(true)
      releaseFlush?.()
      let activeSettled = false
      void active.then(() => { activeSettled = true })
      let disposedSettled = false
      void disposed.then(() => { disposedSettled = true })
      await Promise.resolve()
      expect(activeSettled).toBe(false)
      expect(disposedSettled).toBe(false)
      releaseIdle?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      releaseFlush?.()
      releaseIdle?.()
      await value.close()
    }
  })

  it('cancels an Agent returned after a shared request was aborted', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      const cancel = vi.fn()
      const whenIdle = vi.fn(async () => {})
      value.host.resolvePrivateAgent = async (sessionId) => {
        enteredResolve?.()
        await release
        return {
          agent: {
            id: sessionId,
            followup: () => {},
            cancel,
            whenIdle,
          },
        }
      }

      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'late Agent',
      }, new AbortController().signal, participant.peer)
      await entered
      const disposed = value.service.dispose()
      releaseResolve?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
      expect(whenIdle).toHaveBeenCalledOnce()
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('cancels a revoked member’s active private turn before serialized revocation completes', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      const signal = new AbortController().signal
      await value.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'start' }, signal, collaborator.peer)

      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      let releaseResolve: (() => void) | undefined
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.flushPrivateSession = async () => {
        enteredResolve?.()
        await release
      }
      value.host.cancellations.mockImplementation(() => { releaseResolve?.() })
      const active = value.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'long turn' }, signal, collaborator.peer)
      await entered
      const revoked = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.principalId,
      }, signal, owner.peer)
      await expect(revoked).resolves.toMatchObject({ ok: true })
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(value.host.cancellations).toHaveBeenCalledWith(expect.stringMatching(/^shared-session-/))
    } finally {
      await value.close()
    }
  })

  it('does not retain revocation cleanup when a member has no private Session', async () => {
    const value = await fixture()
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      const membership = (await value.service.listMembers(BotId('bot-chief')))
        .find(member => member.principalId === collaborator.botPrincipalId)
      if (membership === undefined) throw new Error('collaborator membership was not created')

      await expect(value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId)).resolves.toMatchObject({ revoked: true })
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const snapshot = sharedMembershipSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: { ...snapshot, memberships: [...snapshot.memberships, membership] },
        }
      })
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create a session after re-enrollment',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
    } finally {
      await value.close()
    }
  })

  it('does not resurrect a revocation tombstone after a concurrent private chat flush', async () => {
    const value = await fixture()
    let releaseFlush: (() => void) | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'establish a private Session',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      if (binding === undefined) throw new Error('private Session binding was not created')

      let enteredFlush: (() => void) | undefined
      const flushStarted = new Promise<void>((resolve) => { enteredFlush = resolve })
      const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
      value.host.flushPrivateSession = async () => {
        enteredFlush?.()
        await flushGate
      }
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'chat during revocation',
      }, new AbortController().signal, collaborator.peer)
      await flushStarted
      await value.authority.mutateExtension('agent-bots/shared-private-sessions', (current) => {
        const snapshot = privateSessionSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: {
            ...snapshot,
            bindings: snapshot.bindings.map(candidate => candidate.sessionId === binding.sessionId
              ? { ...candidate, revokedAt: 2_000 }
              : candidate),
          },
        }
      })
      releaseFlush?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/conflict' } })
      const persisted = privateSessionSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-private-sessions')).value,
      )
      expect(persisted.bindings).toContainEqual(expect.objectContaining({
        sessionId: binding.sessionId,
        revokedAt: 2_000,
      }))
    } finally {
      releaseFlush?.()
      await value.close()
    }
  })

  it('waits for a cancelled Agent to become idle before completing revocation', async () => {
    const value = await fixture()
    let releaseIdle: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create binding',
      }, new AbortController().signal, collaborator.peer)
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(binding).toBeDefined()

      const originalResolve = value.host.resolvePrivateAgent
      let enteredIdle: (() => void) | undefined
      const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
      const entered = new Promise<void>((resolve) => { enteredIdle = resolve })
      let cancelled = false
      let idleSawCancelled = false
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        const resolved = await originalResolve(sessionId, signal)
        if ('error' in resolved) return resolved
        return {
          agent: {
            ...resolved.agent,
            cancel: () => { cancelled = true; resolved.agent.cancel({ kind: 'parent' }) },
            whenIdle: async () => {
              idleSawCancelled = cancelled
              enteredIdle?.()
              await idle
            },
          },
        }
      }

      const revoked = value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId, owner.botPrincipalId)
      await entered
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
      releaseIdle?.()
      await expect(revoked).resolves.toMatchObject({ revoked: true })
      expect(idleSawCancelled).toBe(true)
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
    } finally {
      releaseIdle?.()
      await value.close()
    }
  })

  it('bounds revocation when a cancelled Agent never becomes idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    let releaseIdle: (() => void) | undefined
    let revoked: Promise<unknown> | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      const collaboratorMembership = (await value.service.listMembers(BotId('bot-chief')))
        .find(member => member.principalId === collaborator.botPrincipalId)
      expect(collaboratorMembership).toBeDefined()
      await value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create binding',
      }, new AbortController().signal, collaborator.peer)
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(binding).toBeDefined()
      let enteredIdle: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredIdle = resolve })
      const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        return {
          agent: {
            id: sessionId,
            followup: () => {},
            cancel: () => {},
            whenIdle: async () => {
              enteredIdle?.()
              await idle
            },
          },
        }
      }

      revoked = value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId, owner.botPrincipalId)
      void revoked.catch(() => undefined)
      await entered
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(revoked).rejects.toMatchObject({
        name: 'SharedServiceFault',
        code: 'gateway/unavailable',
      })
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
      const persisted = privateSessionSnapshotSchema.parse(
        (await value.authority.readExtension('agent-bots/shared-private-sessions')).value,
      )
      expect(persisted.bindings).toHaveLength(1)
      expect(persisted.bindings[0]?.revokedAt).toBeDefined()
      releaseIdle?.()
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(1)
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
      await value.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const snapshot = sharedMembershipSnapshotSchema.parse(current)
        return {
          value: undefined,
          next: {
            ...snapshot,
            memberships: collaboratorMembership === undefined
              ? snapshot.memberships
              : [...snapshot.memberships, collaboratorMembership],
          },
        }
      })
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'fresh session after revoke',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const freshBinding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(freshBinding).toBeDefined()
      expect(freshBinding?.sessionId).not.toBe(binding?.sessionId)
    } finally {
      releaseIdle?.()
      vi.useRealTimers()
      await revoked?.catch(() => undefined)
      await value.close()
    }
  })

  it('cancels an Agent that resolves after the shared cancellation deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    let revoked: Promise<unknown> | undefined
    const cancel = vi.fn()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create binding',
      }, new AbortController().signal, collaborator.peer)
      const pending = new Promise<void>((resolve) => { releaseResolve = resolve })
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      value.host.resolvePrivateAgent = async (sessionId) => {
        enteredResolve?.()
        await pending
        return {
          agent: {
            id: sessionId,
            followup: () => {},
            cancel,
            whenIdle: async () => {},
          },
        }
      }

      revoked = value.service.revokeMember(BotId('bot-chief'), collaborator.botPrincipalId, owner.botPrincipalId)
      void revoked.catch(() => undefined)
      await entered
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(revoked).rejects.toMatchObject({
        name: 'SharedServiceFault',
        code: 'gateway/unavailable',
      })
      releaseResolve?.()
      await Promise.resolve()
      await Promise.resolve()
      expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
    } finally {
      releaseResolve?.()
      vi.useRealTimers()
      await revoked?.catch(() => undefined)
      await value.close()
    }
  })

  it('cancels an Agent when authority revocation aborts its active shared turn', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.flushPrivateSession = async () => {
        enteredResolve?.()
        await release
      }
      value.host.cancellations.mockImplementation(() => { releaseResolve?.() })

      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'authority revoke',
      }, new AbortController().signal, collaborator.peer)
      await entered
      await value.authority.revokePrincipal(collaborator.principalId)
      releaseResolve?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(value.host.cancellations).toHaveBeenCalledWith(expect.stringMatching(/^shared-session-/))
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not return a private transcript after authority revocation during inspection', async () => {
    const value = await fixture()
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'seed transcript',
      }, new AbortController().signal, collaborator.peer)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      let inspectionSignal: AbortSignal | undefined
      value.host.inspectPrivateSession = async (_sessionId, signal) => {
        inspectionSignal = signal
        enteredResolve?.()
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        throw new Error('inspection cancelled')
      }

      const read = value.service.handle('bots/share/read-private-chat', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)
      await entered
      await value.authority.revokePrincipal(collaborator.principalId)
      await expect(read).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(inspectionSignal?.aborted).toBe(true)
    } finally {
      await value.close()
    }
  })

  it('repairs a missing private Session binding before sending the next chat', async () => {
    const value = await fixture()
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create the original binding',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const original = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      if (original === undefined) throw new Error('original private Session binding was not created')
      let resolves = 0
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        resolves += 1
        if (resolves === 1) {
          return { error: new ApiSessionNotFound('private Session is missing') }
        }
        return {
          agent: {
            id: sessionId,
            followup: (message) => { value.host.followups(sessionId, message) },
            cancel: () => {},
            whenIdle: async () => {},
          },
        }
      }

      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'recreate the missing binding',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const repaired = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(repaired?.sessionId).not.toBe(original.sessionId)
      expect(resolves).toBe(2)
    } finally {
      await value.close()
    }
  })

  it('keeps a newer private Session binding when stale repair loses the CAS race', async () => {
    const value = await fixture()
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create the original binding',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const original = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      if (original === undefined) throw new Error('original private Session binding was not created')
      const replacement = SessionId('shared-session-newer')
      const originalResolve = value.host.resolvePrivateAgent
      let firstResolve = true
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        if (firstResolve) {
          firstResolve = false
          expect(sessionId).toBe(original.sessionId)
          await replacePrivateSessionBinding(
            value.authority,
            binding => binding.botId === BotId('bot-chief') && binding.principalId === collaborator.botPrincipalId,
            replacement,
          )
          return { error: new ApiSessionNotFound('stale private Session binding') }
        }
        expect(sessionId).toBe(replacement)
        return originalResolve(sessionId, signal)
      }

      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'keep the newer binding',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)?.sessionId).toBe(replacement)
      const extension = await value.authority.readExtension('agent-bots/shared-private-sessions')
      const snapshot = privateSessionSnapshotSchema.parse(extension.value)
      expect(snapshot.bindings).toContainEqual(expect.objectContaining({
        botId: BotId('bot-chief'),
        principalId: collaborator.botPrincipalId,
        sessionId: replacement,
      }))
    } finally {
      await value.close()
    }
  })

  it('removes a missing private Session binding before returning an empty transcript', async () => {
    const value = await fixture()
    try {
      await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const collaborator = await principal(value, collaboratorEnrollment)
      await value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create a binding to remove',
      }, new AbortController().signal, collaborator.peer)
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeDefined()
      value.host.inspectPrivateSession = async () => {
        throw new ApiSessionNotFound('private Session is missing')
      }

      await expect(value.service.handle('bots/share/read-private-chat', {
        botId: 'bot-chief',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({
        ok: true,
        value: { botId: 'bot-chief', recent: [] },
      })
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
    } finally {
      await value.close()
    }
  })

  it('does not return a Bot list after authority revocation during Host reads', async () => {
    const value = await fixture(60_000)
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const originalListBots = value.host.listBots
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.listBots = async () => {
        enteredResolve?.()
        await release
        return originalListBots()
      }

      const read = value.service.handle('bots/share/list', {}, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()
      await expect(read).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not return a Bot profile after authority revocation during Host reads', async () => {
    const value = await fixture(60_000)
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const originalFindBot = value.host.findBot
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.findBot = async (botId) => {
        enteredResolve?.()
        await release
        return originalFindBot(botId)
      }

      const read = value.service.handle('bots/share/read-profile', { botId: 'bot-chief' }, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()
      await expect(read).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not expose shared profile mutation until its durable authorization transaction is available', async () => {
    const value = await fixture()
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const updateProfile = vi.spyOn(value.host, 'updateProfile')
      const result = await value.service.handle('bots/share/manage-profile', {
        botId: 'bot-chief', name: 'disabled profile write',
      }, new AbortController().signal, owner.peer)
      expect(result).toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
      expect(updateProfile).not.toHaveBeenCalled()
      expect((await value.host.findBot(BotId('bot-chief')))?.name).toBe('Chief of staff')
    } finally {
      await value.close()
    }
  })

  it('checks owner invite authorization against the authority after a stale local read', async () => {
    const value = await fixture()
    let secondary: SecondaryFixture | undefined
    let releaseFind: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      secondary = await secondaryFixture(value)
      const ownerInSecondary = await principal({ ...value, authority: secondary.authority }, ownerEnrollment)
      const sharedAccessKey = credentialKey('client-connection', 'shared-access')
      const invitesBefore = pendingInviteCount(value.records.get(sharedAccessKey))
      const originalFind = value.host.findBot
      let enteredFind: (() => void) | undefined
      const findStarted = new Promise<void>((resolve) => { enteredFind = resolve })
      const findGate = new Promise<void>((resolve) => { releaseFind = resolve })
      value.host.findBot = async (botId, signal) => {
        enteredFind?.()
        await findGate
        return originalFind(botId, signal)
      }

      const invite = value.service.createInvite(BotId('bot-chief'), 'collaborator', owner.botPrincipalId)
      await findStarted
      await secondary.authority.revokePrincipal(ownerInSecondary.principalId)
      releaseFind?.()
      await expect(invite).rejects.toMatchObject({ code: 'gateway/forbidden' })
      expect(pendingInviteCount(value.records.get(sharedAccessKey))).toBe(invitesBefore)
    } finally {
      releaseFind?.()
      await secondary?.close()
      await value.close()
    }
  })

  it('does not pre-cancel a member when the revoking authority is revoked during preparation', async () => {
    const value = await fixture(60_000)
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await value.service.handle('bots/share/chat', { botId: 'bot-chief', text: 'keep session' }, new AbortController().signal, collaborator.peer)
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(binding).toBeDefined()

      const originalModify = value.credentials.modifyRecord.bind(value.credentials)
      let membershipReads = 0
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.credentials.modifyRecord = async (key, mutate) => {
        if (String(key) === 'client-connection/shared-access') {
          membershipReads += 1
          if (membershipReads === 2) {
            enteredResolve?.()
            await release
          }
        }
        return originalModify(key, mutate)
      }

      const revoke = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.botPrincipalId,
      }, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()
      await expect(revoke).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(value.host.cancellations).not.toHaveBeenCalledWith(binding?.sessionId)
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(2)
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not commit a member revocation after authority aborts before the atomic mutation', async () => {
    const value = await fixture(60_000)
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'keep the private session',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(binding).toBeDefined()
      value.host.resolvePrivateAgent = async (_sessionId, signal) => {
        signal.throwIfAborted()
        return { error: new Error('test Agent unavailable') }
      }
      const originalModify = value.credentials.modifyRecord.bind(value.credentials)
      let membershipReads = 0
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.credentials.modifyRecord = async (key, mutate) => {
        if (String(key) === 'client-connection/shared-access') {
          membershipReads += 1
          if (membershipReads === 4) {
            enteredResolve?.()
            await release
          }
        }
        return originalModify(key, mutate)
      }

      const revoke = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.botPrincipalId,
      }, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()
      await expect(revoke).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(2)
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toEqual(binding)
      expect(value.host.cancellations).not.toHaveBeenCalled()
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('cleans private metadata when the revoking authority aborts after commit', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'create private binding',
      }, new AbortController().signal, collaborator.peer)).resolves.toMatchObject({ ok: true })
      const binding = value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)
      expect(binding).toBeDefined()

      const originalResolve = value.host.resolvePrivateAgent
      let resolveCalls = 0
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        resolveCalls += 1
        if (resolveCalls === 2) {
          enteredResolve?.()
          await release
        }
        return originalResolve(sessionId, signal)
      }

      const revoked = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.principalId,
      }, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()

      await expect(revoked).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await expect(value.service.listMembers(BotId('bot-chief'))).resolves.toHaveLength(1)
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
      expect(value.host.cancellations).toHaveBeenCalledWith(binding?.sessionId)
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('does not create a member invite after authority revocation', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const originalFindBot = value.host.findBot
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      value.host.findBot = async (botId) => {
        enteredResolve?.()
        await release
        return originalFindBot(botId)
      }

      const active = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'create-invite', role: 'collaborator',
      }, new AbortController().signal, owner.peer)
      await entered
      await value.authority.revokePrincipal(owner.principalId)
      releaseResolve?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('cancels a private Agent created just before first-turn revocation is persisted', async () => {
    const value = await fixture()
    let releaseResolve: (() => void) | undefined
    try {
      const ownerEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const collaboratorEnrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'collaborator')).code, enrollmentRequest())
      const owner = await principal(value, ownerEnrollment)
      const collaborator = await principal(value, collaboratorEnrollment)
      let enteredResolve: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve })
      const release = new Promise<void>((resolve) => { releaseResolve = resolve })
      let createSignal: AbortSignal | undefined
      const createdCancel = vi.fn()
      const createdWhenIdle = vi.fn(async () => {})
      value.host.createPrivateSession = async (bot, sessionId, principalId, signal) => {
        createSignal = signal
        enteredResolve?.()
        await release
        value.host.sessions.set(String(sessionId), { botId: String(bot.id), principalId })
        value.host.messages.set(String(sessionId), [])
        return { id: sessionId, cancel: createdCancel, whenIdle: createdWhenIdle }
      }

      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'first turn',
      }, new AbortController().signal, collaborator.peer)
      await entered
      const originalReadExtension = value.authority.readExtension.bind(value.authority)
      let authorityReads = 0
      let preparationComplete: (() => void) | undefined
      const prepared = new Promise<void>((resolve) => { preparationComplete = resolve })
      value.authority.readExtension = async (key) => {
        const result = await originalReadExtension(key)
        authorityReads += 1
        // The active chat has read the shared membership twice. The revoke
        // request reads it once before preparation and once before aborting
        // active requests, so this resolves at that pre-serialization point.
        if (authorityReads === 4) preparationComplete?.()
        return result
      }
      const revoked = value.service.handle('bots/share/manage-members', {
        botId: 'bot-chief', action: 'revoke', principalId: collaborator.principalId,
      }, new AbortController().signal, owner.peer)
      await prepared
      releaseResolve?.()
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(createSignal?.aborted).toBe(true)
      await expect(revoked).resolves.toMatchObject({ ok: true, value: { revoked: true } })
      expect(value.host.followups).not.toHaveBeenCalled()
      expect(createdCancel).toHaveBeenCalledWith({ kind: 'parent' })
      expect(createdWhenIdle).toHaveBeenCalledOnce()
      expect(value.service.sessionFor(BotId('bot-chief'), collaborator.botPrincipalId)).toBeUndefined()
    } finally {
      releaseResolve?.()
      await value.close()
    }
  })

  it('bounds cleanup for an exact Agent returned after first-chat cancellation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    let releaseCreate: (() => void) | undefined
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      let enteredCreate: (() => void) | undefined
      const entered = new Promise<void>((resolve) => { enteredCreate = resolve })
      const release = new Promise<void>((resolve) => { releaseCreate = resolve })
      const cancel = vi.fn()
      const whenIdle = vi.fn(async () => { await new Promise<void>(() => {}) })
      let createdSessionId: SessionId | undefined
      value.host.createPrivateSession = async (bot, sessionId, principalId) => {
        createdSessionId = sessionId
        enteredCreate?.()
        await release
        value.host.sessions.set(String(sessionId), { botId: String(bot.id), principalId })
        value.host.messages.set(String(sessionId), [])
        return { id: sessionId, cancel, whenIdle }
      }

      const request = new AbortController()
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'cancel during first session',
      }, request.signal, participant.peer)
      await entered
      request.abort(new Error('caller cancelled'))
      releaseCreate?.()
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
      expect(whenIdle).toHaveBeenCalledOnce()
      expect(createdSessionId).toBeDefined()
      expect(value.service.sessionFor(BotId('bot-chief'), participant.botPrincipalId)).toEqual(expect.objectContaining({
        sessionId: createdSessionId,
      }))
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'must wait for the first Agent to quiesce',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/unavailable' },
      })
    } finally {
      releaseCreate?.()
      vi.useRealTimers()
      await value.close()
    }
  })

  it('bounds an active chat cancellation and quarantines its non-idle binding', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'establish the private Session',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({ ok: true })

      const binding = value.service.sessionFor(BotId('bot-chief'), participant.botPrincipalId)
      if (binding === undefined) throw new Error('private Session binding was not created')
      const flushStarted = Promise.withResolvers<undefined>()
      const flushGate = Promise.withResolvers<undefined>()
      const idleStarted = Promise.withResolvers<undefined>()
      const idleGate = Promise.withResolvers<undefined>()
      const cancel = vi.fn()
      const followup = vi.fn()
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        return {
          agent: {
            id: sessionId,
            followup,
            cancel,
            whenIdle: async () => {
              idleStarted.resolve(undefined)
              await idleGate.promise
            },
          },
        }
      }
      value.host.flushPrivateSession = async (_sessionId, signal) => {
        flushStarted.resolve(undefined)
        await flushGate.promise
        signal?.throwIfAborted()
      }

      const request = new AbortController()
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'cancel while the Agent is working',
      }, request.signal, participant.peer)
      await flushStarted.promise
      request.abort(new Error('caller cancelled'))
      flushGate.resolve(undefined)
      await idleStarted.promise
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })
      expect(value.service.sessionFor(BotId('bot-chief'), participant.botPrincipalId)).toEqual(binding)

      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'must not reuse a non-idle Agent',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/unavailable' },
      })

      idleGate.resolve(undefined)
      await Promise.resolve()
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'resume after quiescence',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({ ok: true })
      expect(followup).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      await value.close()
    }
  })

  it('bounds disposal when a quarantined Agent never becomes idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const value = await fixture()
    const idleGate = Promise.withResolvers<undefined>()
    const idleStarted = Promise.withResolvers<undefined>()
    const resolveStarted = Promise.withResolvers<undefined>()
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'establish the private Session',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({ ok: true })
      const cancel = vi.fn()
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        resolveStarted.resolve(undefined)
        return {
          agent: {
            id: sessionId,
            followup: () => {},
            cancel,
            whenIdle: async () => {
              idleStarted.resolve(undefined)
              await idleGate.promise
            },
          },
        }
      }

      const request = new AbortController()
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'cancel before idle',
      }, request.signal, participant.peer)
      await resolveStarted.promise
      request.abort(new Error('caller cancelled'))
      await idleStarted.promise
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      expect(cancel).toHaveBeenCalledWith({ kind: 'parent' })

      const disposed = value.service.dispose()
      await vi.advanceTimersByTimeAsync(1_001)
      await expect(disposed).resolves.toBeUndefined()
    } finally {
      idleGate.resolve(undefined)
      vi.useRealTimers()
      await value.close()
    }
  })

  it('retries a failed quiescence quarantine before reusing its binding', async () => {
    const value = await fixture()
    const flushGate = Promise.withResolvers<undefined>()
    const flushStarted = Promise.withResolvers<undefined>()
    let idleAttempts = 0
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => {
      idleAttempts += 1
      if (idleAttempts === 1) throw new Error('idle check failed')
    })
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'establish the private Session',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({ ok: true })
      value.host.resolvePrivateAgent = async (sessionId, signal) => {
        signal.throwIfAborted()
        return {
          agent: {
            id: sessionId,
            followup: (message) => { value.host.followups(sessionId, message) },
            cancel,
            whenIdle,
          },
        }
      }
      value.host.flushPrivateSession = async (_sessionId, signal) => {
        flushStarted.resolve(undefined)
        await flushGate.promise
        signal?.throwIfAborted()
      }
      const request = new AbortController()
      const active = value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'first cancellation fails to prove idle',
      }, request.signal, participant.peer)
      await flushStarted.promise
      request.abort(new Error('caller cancelled'))
      flushGate.resolve(undefined)
      await expect(active).resolves.toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
      await Promise.resolve()
      await Promise.resolve()

      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'retry after failed idle check',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({ ok: true })
      expect(idleAttempts).toBe(2)
      expect(cancel).toHaveBeenCalledTimes(2)
    } finally {
      flushGate.resolve(undefined)
      await value.close()
    }
  })

  it('does not start a private turn for a peer revoked before dispatch', async () => {
    const value = await fixture()
    try {
      const enrollment = await value.service.enroll((await value.service.createInvite(BotId('bot-chief'), 'owner')).code, enrollmentRequest())
      const participant = await principal(value, enrollment)
      await value.authority.revokePrincipal(enrollment.principalId)
      await expect(value.service.handle('bots/share/chat', {
        botId: 'bot-chief', text: 'must not run',
      }, new AbortController().signal, participant.peer)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/forbidden' },
      })
      expect(value.host.sessions.size).toBe(0)
      expect(value.host.followups).not.toHaveBeenCalled()
    } finally {
      await value.close()
    }
  })
})
