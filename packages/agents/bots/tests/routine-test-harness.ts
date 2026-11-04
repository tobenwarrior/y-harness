import { Context, Service } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { createScope } from '@yharness/scope'
import { Session, SessionId, type SessionEvent } from '@yharness/session'
import type { UserMessage } from '@yharness/llm'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { CredentialProvider } from '@yharness/credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@yharness/credentials'
import type { BotNativeToolHost } from '../src/native-tools.ts'
import BotService from '../src/index.ts'
import type { BotId, BotRecord } from '../src/types.ts'
import { botRecordSchema } from '../src/storage.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

interface SharedCredentialState {
  readonly records: Map<CredentialKey, CredentialRecord>
  tail: Promise<void>
}

class SharedCredentials extends CredentialProvider {
  private static readonly states = new WeakMap<Map<CredentialKey, CredentialRecord>, SharedCredentialState>()
  private readonly state: SharedCredentialState

  constructor(ctx: Context, private readonly records: Map<CredentialKey, CredentialRecord>) {
    super(ctx)
    this.state = SharedCredentials.states.get(records) ?? { records, tail: Promise.resolve() }
    SharedCredentials.states.set(records, this.state)
  }

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }
  describe(_ref: CredentialRef): Promise<CredentialInfo> { return Promise.resolve({ configured: false, writable: true }) }
  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }
  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(this.records.get(key)) }
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

interface AgentFixture {
  readonly agent: Agent
  readonly session: Session
}

export interface RoutineHarness {
  readonly ctx: Context
  readonly service: BotService
  readonly pool: MemoryMediaPool
  readonly records: Map<CredentialKey, CredentialRecord>
  readonly agent: AgentFixture
}

/** Create the smallest real BotService host needed by event-routine regressions. */
export async function routineHarness(
  pool = new MemoryMediaPool(),
  records = new Map<CredentialKey, CredentialRecord>(),
): Promise<RoutineHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })

  const session = Session.create(SessionId('routine-test-session'))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: {
      nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace() { return false }, remove() { return false }, splice() { return [] },
    },
    status: 'idle',
    ctx: new Context(),
    send() {},
    followup() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  const agents = [agent]
  ctx.provide('agents', {
    get: (sessionId: SessionId) => agents.find(candidate => candidate.id === sessionId),
    list: () => [...agents],
    withoutInitiator: async <T>(operation: () => Promise<T>) => operation(),
  } as never)
  ctx.provide('sessions', {
    get: (sessionId: SessionId) => agents.find(candidate => candidate.id === sessionId)?.session,
    flush: async () => true,
  } as never)
  ctx.provide('sessionController', {
    create: async (request: { readonly sessionId?: string }) => ({ sessionId: request.sessionId }),
    inspect: async (sessionId: SessionId) => ({
      events: agents.find(candidate => candidate.id === sessionId)?.session.snapshotEvents() ?? [],
    }),
    resolveAgent: async (sessionId: SessionId) => {
      const found = agents.find(candidate => candidate.id === sessionId)
      return found === undefined ? { error: new Error('session not found') } : { agent: found }
    },
  } as never)
  ctx.provide('attachments', {
    readImage: async () => { throw new Error('image fixture unavailable') },
    saveImages: async () => [],
    saveImage: async () => { throw new Error('image fixture unavailable') },
    validateImage: async () => undefined,
  } as never)
  new SharedCredentials(ctx, records)
  const service = new BotService(ctx, { ownerId: 'routine-test-owner' })
  await service[Service.init]()
  return { ctx, service, pool, records, agent: { agent, session } }
}

/** Dispose a regression harness without hiding service cleanup failures. */
export async function closeRoutineHarness(harness: RoutineHarness): Promise<void> {
  await harness.ctx.fiber.dispose()
}

/** Invoke the private production routine adapter without duplicating its logic in tests. */
export async function invokeRoutine(
  service: BotService,
  action: Parameters<NonNullable<BotNativeToolHost['routine']>>[0],
  args: Record<string, unknown>,
  sessionId: SessionId,
  callId: string,
): Promise<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), 'runRoutine')
  if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Bot routine adapter is unavailable')
  type RunRoutine = (
    this: BotService,
    action: Parameters<NonNullable<BotNativeToolHost['routine']>>[0],
    args: Record<string, unknown>,
    context: Parameters<NonNullable<BotNativeToolHost['routine']>>[2],
  ) => Promise<unknown>
  const runRoutine = descriptor.value as RunRoutine
  return runRoutine.call(service, action, args, {
    callId,
    threadId: 'routine-test-thread',
    turnId: callId,
    sessionId,
    signal: new AbortController().signal,
    approvalPolicy: 'on-request',
    requestApproval: () => Promise.resolve(true),
  })
}

/** Invoke one private admission pass with a real user message and event metadata. */
export async function invokeRoutineTrigger(
  service: BotService,
  sessionId: SessionId,
  message: UserMessage,
): Promise<boolean> {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), 'triggerEventRoutines')
  if (descriptor === undefined || typeof descriptor.value !== 'function') throw new Error('Bot routine trigger is unavailable')
  type TriggerRoutine = (
    this: BotService,
    sessionId: SessionId,
    input: {
      readonly message: UserMessage
      readonly eventSeq: number
      readonly eventTime: number
      readonly source: 'user' | 'bot'
    },
  ) => Promise<boolean>
  const triggerRoutine = descriptor.value as TriggerRoutine
  return triggerRoutine.call(service, sessionId, {
    message,
    eventSeq: 1,
    eventTime: Date.now(),
    source: 'user',
  })
}

/** Read one raw Bot row from the shared medium, bypassing each process's stale domain cache. */
export function rawBotRow(pool: MemoryMediaPool, botId: BotId): BotRecord | undefined {
  const medium = pool.media.get('agent_bots')
  const rows = medium?.tables.get('bots')
  const parsed = botRecordSchema.safeParse(rows?.get(String(botId)))
  return parsed.success ? parsed.data : undefined
}

/** Build a valid completed turn event for the result-persistence regression. */
export function completedTurnEvent(session: Session): SessionEvent<'turn/end'> {
  return session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}
