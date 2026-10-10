/** Cancellable sequential tasks retain current native facts separately from ordinary turns and imported history. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SkillLearningRuntimeController } from './learning-runtime.ts'
import type { SkillLearningEvidence, SkillLearningNativeAction, SkillLearningNativeIdentity, SkillLearningNativeItem,
  SkillSequentialTaskHooks, SkillSequentialTaskId, SkillSequentialTaskSource } from './learning-types.ts'
import { nativeObservationInstructions } from './native-observation.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only fresh task admission; historical native messages cannot produce this event. */
    'skill/sequential-task-start': { readonly taskId: SkillSequentialTaskId; readonly source: SkillSequentialTaskSource; readonly task: string }
    /** Log-only native identity reported by this admitted continuation. */
    'skill/sequential-task-native-turn': { readonly taskId: SkillSequentialTaskId; readonly nativeTurnId: string }
    /** Log-only sanitized current-task action metadata; never model history. */
    'skill/sequential-native-item': { readonly taskId: SkillSequentialTaskId; readonly item: SkillLearningNativeItem }
    /** Native task settlement and its separate learning eligibility; neither establishes correctness. */
    'skill/sequential-task-end': {
      readonly taskId: SkillSequentialTaskId
      readonly nativeTurnId?: string
      readonly outcome: 'completed' | 'failed' | 'cancelled'
      readonly learning: 'eligible' | 'unsupported' | 'insufficient' | 'unavailable'
    }
  }
}

/** Deployment-owned collection and complete durability bounds. */
export interface SequentialLearningBounds {
  readonly maxItems: number
  readonly maxTaskBytes: number
  readonly maxInputBytes: number
  readonly timeoutMs: number
}
interface Task {
  readonly id: SkillSequentialTaskId
  readonly source: SkillSequentialTaskSource
  readonly text: string
  readonly refs: string[]
  readonly starts: Map<string, { readonly item: SkillLearningNativeItem; readonly ref: string }>
  readonly actions: Map<string, SkillLearningNativeAction>
  native?: SkillLearningNativeIdentity
  turn?: string
  admitted: boolean
  settled: boolean
  bytes: number
}
type SequentialEventType = 'skill/sequential-task-start' | 'skill/sequential-task-native-turn'
  | 'skill/sequential-native-item' | 'skill/sequential-task-end'
type SequentialEventArgs = { [T in SequentialEventType]: [type: T, data: SessionEventMap[T]] }[SequentialEventType]
function framedBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }
const credential =
  /(?:api[_ -]?key|access[_ -]?token|secret|password|authorization)\s*[:=]|\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_)[a-z0-9_-]{8,}/i
function sanitizedTask(value: string, limit: number): string {
  const text = value.slice(0, limit).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, '[redacted private key]')
    .split(/\r?\n/).map(line => credential.test(line) ? '[redacted credential-shaped line]' : line).join('\n').trim()
  return Buffer.from(text).subarray(0, limit).toString('utf8').replace(/\uFFFD$/, '')
}
function hasPatchKind(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'patch'
}
function paired(left: SkillLearningNativeItem, right: SkillLearningNativeItem): boolean {
  return left.kind === right.kind && left.name === right.name && left.skillReadPath === right.skillReadPath
    && left.sourceMessageId === right.sourceMessageId && JSON.stringify(left.procedure) === JSON.stringify(right.procedure)
    && JSON.stringify(left.patchProcedure) === JSON.stringify(right.patchProcedure)
}

/** Live service-owned captures; disposal cancels native work and joins durability before evidence storage closes. */
export class SequentialSkillLearning {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly storage = new Set<Promise<unknown>>()
  /**
   * @param ctx - exact live root/session registry.
   * @param controller - existing evidence and approved-policy owner.
   * @param bounds - complete capture limits.
   */
  constructor(
    private readonly ctx: Context,
    private readonly controller: SkillLearningRuntimeController,
    private readonly bounds: SequentialLearningBounds,
  ) {}

  /**
   * Own one actual idle Agent task, without synthesizing an AgentLoop turn or replaying old native history.
   * @param agent - exact selected live root whose current policy authorizes continuation.
   * @param source - exact original source and disclosed native tool mode.
   * @param text - current human continuation, sanitized before evidence retention.
   * @param operation - native admission, live metadata, settlement and mirror reconciliation.
   * @returns the native operation result after fresh task settlement and policy-controlled learning.
   */
  run<T>(
    agent: Agent,
    source: SkillSequentialTaskSource,
    text: string,
    operation: (hooks: SkillSequentialTaskHooks) => Promise<T>,
  ): Promise<T> {
    this.assertLive(agent)
    if (this.lifetime.signal.aborted) throw new Error('Sequential skill learning is disposed.')
    const project = this.ctx.get('workspaceRegistry')?.list().find(value => value.path === agent.session.header.cwd)
    if (project === undefined) throw new Error('Sequential tasks require an exact registered project.')
    if ([source.profileId, source.nativeSessionId].some(value => value.length === 0 || value.length > 256)
      || text.trim().length === 0) throw new Error('Sequential task source or input is unavailable.')
    const captured = structuredClone(source)
    const task: Task = { id: brandString<SkillSequentialTaskId>(randomUUID()), source: captured,
      text: sanitizedTask(text, this.bounds.maxTaskBytes),
      refs: [], starts: new Map(), actions: new Map(), admitted: false, settled: false, bytes: 0 }
    const work = agent.runMaintenance(async (maintenanceSignal) => {
      // Publish the joined operation before source or Session callbacks can begin disposal.
      await Promise.resolve()
      const signal = AbortSignal.any([maintenanceSignal, this.lifetime.signal])
      const current = () => { signal.throwIfAborted(); this.assertLive(agent) }
      const flush = async () => { await this.flush(agent.session); current() }
      const hooks: SkillSequentialTaskHooks = {
        signal,
        beforeDispatch: async () => {
          current()
          if (task.admitted || task.settled) throw new Error('Sequential task admission was repeated or already settled.')
          this.append(agent.session, task, 'skill/sequential-task-start', { taskId: task.id, source: captured, task: task.text })
          task.admitted = true
          await flush()
        },
        onNativeTurn: async (nativeTurnId) => {
          current()
          if (!task.admitted || task.settled || task.turn !== undefined || nativeTurnId.length === 0 || nativeTurnId.length > 256) {
            throw new Error('Sequential task has an invalid or duplicate current native turn.')
          }
          this.append(agent.session, task, 'skill/sequential-task-native-turn', { taskId: task.id, nativeTurnId })
          task.turn = nativeTurnId
          await flush()
        },
        onNativeItem: async (observed) => {
          current()
          if (!task.admitted || task.settled || task.turn === undefined || captured.provider !== 'codex' || observed.provider !== 'codex'
            || observed.connectionId !== captured.profileId || observed.sessionId !== captured.nativeSessionId
            || observed.turnId !== task.turn
            || observed.phase === 'invalidated') throw new Error('Sequential native item lacks its exact live source and current turn.')
          const { procedure, patchProcedure, ...metadata } = structuredClone(observed)
          if (patchProcedure !== undefined && (procedure !== undefined || metadata.kind !== 'file-change'
            || !hasPatchKind(patchProcedure))) throw new Error('Sequential native item has conflicting or unsupported procedure fields.')
          // Project-file mode supplies safe read or patch metadata only, without shell/check authority.
          const allowed = procedure !== undefined && (captured.toolMode !== 'project-files'
            || metadata.kind === 'read' && procedure.kind === 'read')
          const item = { ...metadata, ...allowed ? { procedure } : {}, ...patchProcedure === undefined ? {} : { patchProcedure } }
          if (task.starts.size >= this.bounds.maxItems && item.phase === 'started') {
            throw new Error('Sequential native observations exceeded their complete bound.')
          }
          const start = task.starts.get(item.itemId)
          if (item.phase === 'started' && start !== undefined || item.phase === 'settled' && (start === undefined || task.actions.has(item.itemId)
            || !paired(start.item, item))) throw new Error('Sequential native item has a duplicate or mismatched settlement.')
          const identity: SkillLearningNativeIdentity = { provider: item.provider, connectionId: item.connectionId,
            sessionId: item.sessionId, turnId: item.turnId }
          if (task.native !== undefined && JSON.stringify(task.native) !== JSON.stringify(identity)) throw new Error('Sequential native item identity changed.')
          const event = this.append(agent.session, task, 'skill/sequential-native-item', { taskId: task.id, item })
          const ref = `${agent.id}:${event.seq}`; task.native = identity
          const fact = item.patchProcedure ?? item.procedure
          if (item.phase === 'started') task.starts.set(item.itemId, { item, ref })
          else if (start !== undefined) task.actions.set(item.itemId, { itemId: item.itemId, kind: item.kind, name: item.name,
            outcome: item.outcome ?? 'unknown', startedEventRef: start.ref, settledEventRef: ref,
            ...item.skillReadPath === undefined ? {} : { skillReadPath: item.skillReadPath },
            ...fact === undefined ? {} : { procedure: fact } })
          await flush()
        },
      }
      let result: T
      try {
        current(); result = await operation(hooks); current()
        if (!task.admitted || task.turn === undefined) throw new Error('Sequential continuation did not establish fresh task and native turn admission.')
        if (task.starts.size !== task.actions.size) throw new Error('Sequential native items lack complete paired settlements.')
      } catch (error) {
        this.controller.setLearningAvailability(project.id, { state: 'unavailable', reason: 'The current sequential task failed, was cancelled or lacks durable paired current-turn observations.' })
        if (task.admitted) {
          try { await this.end(agent.session, task, signal.aborted ? 'cancelled' : 'failed', 'unavailable') }
          catch (settlementError) { throw new AggregateError([error, settlementError], 'Sequential task failed and its durable settlement is unavailable.') }
        }
        throw error
      }
      const actions = [...task.starts.keys()].flatMap((id) => {
        const value = task.actions.get(id); return value === undefined ? [] : [value]
      })
      const observation = { projectId: project.id, sessionId: agent.id, task: task.text, completed: true, substantial: actions.length >= 2,
        eventRefs: task.refs, observations: ['Current sequential task settled; task quality, skill application and native result delivery remain unverified.'], checks: [],
        sequentialTask: { taskId: task.id, source: captured, nativeTurnId: task.turn },
        ...task.native === undefined ? {} : { native: { ...task.native, actions } } }
      const preview: SkillLearningEvidence = { ...observation, eventRefs: [...task.refs, `${agent.id}:${agent.session.seq}`],
        id: brandString<SkillLearningEvidence['id']>(task.id), createdAt: new Date().toISOString() }
      const eligible = nativeObservationInstructions(preview) !== undefined
        && actions.every(action => action.procedure === undefined || action.outcome === 'reported-success')
      const eligibility = captured.provider === 'claude' || captured.toolMode === 'conversation' ? 'unsupported'
        : !eligible ? 'insufficient' : framedBytes(preview) > this.bounds.maxInputBytes ? 'unavailable' : 'eligible'
      await this.end(agent.session, task, 'completed', eligibility); current()
      if (eligibility !== 'eligible') {
        this.controller.setLearningAvailability(project.id, { state: 'unavailable', reason: eligibility === 'unsupported'
          ? 'This sequential conversation-only provider exposes no supported paired project procedure facts; no automatic Skill can be learned.'
          : eligibility === 'unavailable' ? 'The current native task completed, but its complete evidence and event references exceed the learning input budget; no Skill evidence was admitted.'
            : 'The current sequential task lacks two distinct safe paired project procedure facts; no automatic Skill can be learned.' })
        return result
      }
      try {
        const evidence = await this.controller.recordLearningEvidence(observation); current()
        if (evidence.sequentialTask?.taskId !== task.id || evidence.sessionId !== agent.id) throw new Error('A prior native task cannot supply evidence for a fresh sequential continuation.')
        this.controller.setLearningAvailability(project.id, { state: 'available', reason: 'This fresh sequential task supports bounded observed procedure learning under the existing project policy; task quality and successful Skill use remain unverified.' })
        if (this.controller.autoLearnEvidence !== undefined) await this.controller.autoLearnEvidence(evidence)
        else await this.controller.proposeLearning({ projectId: project.id, operation: 'learn', evidenceIds: [evidence.id], generatorId: 'native-observation' })
      } catch (_error: unknown) {
        // Native settlement stands independently; unavailable learning cannot invent or undo its receipt.
        this.controller.setLearningAvailability(project.id, { state: 'unavailable', reason: 'Sequential procedure learning could not complete under current durability, bounds, source protections or policy.' })
      }
      return result
    })
    this.pending.add(work); void work.then(() => { this.pending.delete(work) }, () => { this.pending.delete(work) })
    return work
  }
  /**
   * Cancel sequential learning and drain admitted native work and durability checkpoints.
   * @returns completion after cancellation, admitted native work and every underlying durability checkpoint drain.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Sequential learning disposed.'))
    await Promise.allSettled([...this.pending])
    while (this.storage.size > 0) await Promise.allSettled([...this.storage])
  }
  private assertLive(agent: Agent): void {
    const agents = this.ctx.get('agents')
    if (agents?.get(agent.id) !== agent || !agents.roots().includes(agent) || this.ctx.get('sessions')?.get(agent.id) !== agent.session) {
      throw new Error('Sequential tasks require the exact live root and Session lifecycle.')
    }
  }
  private async end(
    session: Session,
    task: Task,
    outcome: 'completed' | 'failed' | 'cancelled',
    learning: 'eligible' | 'unsupported' | 'insufficient' | 'unavailable',
  ): Promise<void> {
    if (task.settled) return
    this.append(session, task, 'skill/sequential-task-end', { taskId: task.id, ...task.turn === undefined ? {} : { nativeTurnId: task.turn }, outcome, learning })
    task.settled = true
    await this.flush(session)
  }
  private append(session: Session, task: Task, ...input: SequentialEventArgs): SessionEvent<SequentialEventType> {
    const [type, data] = input
    // Timestamps and future settlement sequence reserve their complete numeric widths.
    const bytes = framedBytes({ type, seq: session.seq, time: Number.MAX_SAFE_INTEGER, data, ignorable: true }) + 1
    const reserve = type === 'skill/sequential-task-end' ? 0 : framedBytes({ type: 'skill/sequential-task-end',
      seq: Number.MAX_SAFE_INTEGER, time: Number.MAX_SAFE_INTEGER,
      data: { taskId: task.id, nativeTurnId: '\u0000'.repeat(256), outcome: 'completed', learning: 'unavailable' }, ignorable: true }) + 1
    if (task.bytes + bytes + reserve > this.bounds.maxInputBytes) throw new Error('Sequential task complete event capture and settlement exceeded its input bound.')
    let event: SessionEvent<SequentialEventType>
    switch (type) {
      case 'skill/sequential-task-start': event = session.append(type, data, { ignorable: true }); break
      case 'skill/sequential-task-native-turn': event = session.append(type, data, { ignorable: true }); break
      case 'skill/sequential-native-item': event = session.append(type, data, { ignorable: true }); break
      case 'skill/sequential-task-end': event = session.append(type, data, { ignorable: true }); break
      default: return assertNever(type)
    }
    task.bytes += bytes; task.refs.push(`${session.id}:${event.seq}`)
    return event
  }
  private async flush(session: Session): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('Sequential task durability is unavailable.')
    const underlying = sessions.flush(session)
    this.storage.add(underlying); void underlying.then(() => { this.storage.delete(underlying) }, () => { this.storage.delete(underlying) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Sequential task durability timed out.')) }, this.bounds.timeoutMs) })
    try { if (!await Promise.race([underlying, timeout])) throw new Error('Sequential task requires participating durable Session storage.') }
    finally { clearTimeout(timer) }
  }
}
