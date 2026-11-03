/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@yharness/cordis'
import { installModelSelection } from '@yharness/agent'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@yharness/agent'
import type {} from '@yharness/agent-default-model'
import type {} from '@yharness/agent-preset-registry'
import { ReasoningEffortId, ServiceTierId } from '@yharness/llm'
import type { Session, SessionId } from '@yharness/session'
import type { SessionInspection } from '@yharness/session-persistence'
import { SessionQueryError, type SessionObservation } from '@yharness/session-query'
import { RemoteError } from '@yharness/typert-protocol'
import type {} from '@yharness/typert-registry'
import type { ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined, serviceTier: string | undefined): boolean
}

interface AgentResumeEntry {
  readonly controller: AbortController
  readonly promise: Promise<Agent>
  waiters: number
  settled: boolean
}

interface AgentCreationEntry {
  readonly controller: AbortController
  readonly promise: Promise<Agent>
  readonly cleanup: Promise<void>
  readonly releaseCleanup: () => void
  waiters: number
  settled: boolean
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, AgentResumeEntry>()
  private readonly creations = new Map<SessionId, AgentCreationEntry>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(private readonly ctx: Context) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @param signal - optional cancellation for cold observation and Agent resume.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId, signal?: AbortSignal): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId, undefined, signal)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @param signal - optional cancellation for Agent resume.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation, signal?: AbortSignal): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation, signal)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
    signal?: AbortSignal,
  ): Promise<ApiSessionAgentResult> {
    signal?.throwIfAborted()
    const existingResume = this.resumes.get(sessionId)
    const resumeInFlight = existingResume !== undefined && !existingResume.controller.signal.aborted
    const live = resumeInFlight ? undefined : this.liveAgent(sessionId)
    if (live !== undefined) {
      signal?.throwIfAborted()
      return live
    }
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    const resume = resumeInFlight ? existingResume : this.resumeEntry(sessionId, observation)
    resume.waiters += 1
    try {
      const agent = await raceAgent(resume.promise, signal, sessionId, false)
      signal?.throwIfAborted()
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      signal?.throwIfAborted()
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) {
        signal?.throwIfAborted()
        return raced
      }
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    } finally {
      resume.waiters -= 1
      if (resume.waiters === 0 && !resume.settled) {
        resume.controller.abort(new Error(`resume for session "${sessionId}" no longer has waiters`))
      }
    }
  }

  private resumeEntry(sessionId: SessionId, observation?: SessionObservation): AgentResumeEntry {
    const existing = this.resumes.get(sessionId)
    if (existing !== undefined) {
      if (!existing.controller.signal.aborted) return existing
      this.resumes.delete(sessionId)
    }
    const controller = new AbortController()
    const pending = this.resumeAfterCleanup(sessionId, observation, controller.signal)
    const shared = raceAgent(pending, controller.signal, sessionId, true)
    const entry: AgentResumeEntry = {
      controller,
      promise: shared,
      waiters: 0,
      settled: false,
    }
    void pending.then(() => {
      entry.settled = true
      if (this.resumes.get(sessionId) === entry) this.resumes.delete(sessionId)
    }, () => {
      entry.settled = true
      if (this.resumes.get(sessionId) === entry) this.resumes.delete(sessionId)
    })
    this.resumes.set(sessionId, entry)
    return entry
  }

  /** Wait for a prior abandoned persistence lease before opening this Session again. */
  private async resumeAfterCleanup(
    sessionId: SessionId,
    observation: SessionObservation | undefined,
    signal: AbortSignal,
  ): Promise<Agent> {
    await this.ctx.agents.waitForResumeCleanup(sessionId, signal)
    signal.throwIfAborted()
    return this.resume(sessionId, observation, signal)
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @param signal - optional caller cancellation for Session activation.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
    signal?: AbortSignal,
  ): Promise<Agent> {
    signal?.throwIfAborted()
    let creation: AgentCreationEntry
    while (true) {
      const existing = this.creations.get(sessionId)
      if (existing !== undefined) {
        if (existing.controller.signal.aborted) {
          await raceCompletion(existing.cleanup, signal, sessionId)
          if (this.creations.get(sessionId) === existing) this.creations.delete(sessionId)
          continue
        }
        creation = existing
        break
      }
      const controller = new AbortController()
      const promise = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId, controller.signal)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
      const cleanup = Promise.withResolvers<void>()
      const entry: AgentCreationEntry = {
        controller,
        promise,
        cleanup: cleanup.promise,
        releaseCleanup: cleanup.resolve,
        waiters: 0,
        settled: false,
      }
      void promise.then(() => {
        entry.settled = true
        if (!entry.controller.signal.aborted) {
          if (this.creations.get(sessionId) === entry) this.creations.delete(sessionId)
          entry.releaseCleanup()
        }
      }, () => {
        entry.settled = true
        if (this.creations.get(sessionId) === entry) this.creations.delete(sessionId)
        entry.releaseCleanup()
      })
      creation = entry
      this.creations.set(sessionId, entry)
      break
    }
    creation.waiters += 1
    try {
      const agent = await raceAgent(creation.promise, signal, sessionId, false)
      signal?.throwIfAborted()
      if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
        throw new ApiSessionSubagentOwnership(sessionId)
      }
      if (presetId !== undefined) {
        this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
      }
      if (agent.session.header.cwd !== cwd) {
        throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
      }
      return agent
    } finally {
      creation.waiters -= 1
      if (creation.waiters === 0 && !creation.settled) {
        creation.controller.abort(new Error(`creation for session "${sessionId}" no longer has waiters`))
        void creation.promise.then(async (agent) => {
          if (creation.waiters !== 0) return
          try {
            agent.cancel({ kind: 'parent' })
            await agent.whenIdle()
          } catch (error: unknown) {
            // No caller remains to observe a late cancellation failure.
            void error
          }
          if (this.creations.get(sessionId) === creation) this.creations.delete(sessionId)
          creation.releaseCleanup()
        }, () => undefined)
      }
    }
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort or tier the adapter defaulted is not a conversation choice:
          // restoring it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
          ...(logged.serviceTier === undefined
            || loggedHeader.adapterDefaults?.serviceTier === true
            ? {}
            : { serviceTier: logged.serviceTier }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined, serviceTier: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort
          || picked.serviceTier !== serviceTier) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @param serviceTier - adapter-owned service tier used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
    serviceTier: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort, serviceTier) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation, signal?: AbortSignal): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied, signal)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId, signal === undefined ? undefined : { signal })
      return await this.resumeObserved(sessionId, observation, signal)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
    signal?: AbortSignal,
  ): Promise<Agent> {
    signal?.throwIfAborted()
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    signal?.throwIfAborted()
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
      ...(signal === undefined ? {} : { signal }),
    })
    if (signal?.aborted === true) {
      handle.agent.cancel({ kind: 'parent' })
      await handle.dispose().catch(() => undefined)
      signal.throwIfAborted()
    }
    return handle.agent
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
    signal?: AbortSignal,
  ): Promise<Agent> {
    signal?.throwIfAborted()
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return live

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(
          sessionId,
          signal === undefined ? undefined : { signal },
        )
        signal?.throwIfAborted()
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        return (await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
          ...(signal === undefined ? {} : { signal }),
        })).agent
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    try {
      await mkdir(cwd, { recursive: true })
      signal?.throwIfAborted()
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    signal?.throwIfAborted()
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
      ...(signal === undefined ? {} : { signal }),
    })).agent
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
    ...(selection.serviceTier === undefined
      ? {}
      : { serviceTier: ServiceTierId(selection.serviceTier) }),
  }
}

/**
 * Wait for one Agent resume while cancelling an Agent published after the caller aborts.
 * @param pending - activation promise owned by the session controller.
 * @param signal - caller cancellation signal.
 * @param sessionId - identity used in a fallback cancellation error.
 * @param cancelOnAbort - whether this waiter owns the underlying resume.
 * @returns the resumed Agent, or a caller cancellation error.
 */
function raceAgent(
  pending: Promise<Agent>,
  signal: AbortSignal | undefined,
  sessionId: SessionId,
  cancelOnAbort: boolean,
): Promise<Agent> {
  if (signal === undefined) return pending
  const abortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`resume for session "${sessionId}" aborted`, { cause: signal.reason })
  const cancelLateAgent = (agent: Agent): void => {
    try {
      agent.cancel({ kind: 'parent' })
    } catch (error: unknown) {
      // The caller has already abandoned activation; preserve its cancellation result.
      void error
    }
  }
  if (signal.aborted) {
    if (cancelOnAbort) void pending.then(cancelLateAgent, () => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<Agent>((resolve, reject) => {
    let abandoned = false
    const onAbort = (): void => {
      abandoned = true
      if (cancelOnAbort) void pending.then(cancelLateAgent, () => undefined)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then((agent) => {
      signal.removeEventListener('abort', onAbort)
      if (abandoned && cancelOnAbort) cancelLateAgent(agent)
      else resolve(agent)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      if (!abandoned) {
        reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
      }
    })
  })
}

/** Wait for one creation cleanup barrier while preserving caller cancellation. */
function raceCompletion<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  sessionId: SessionId,
): Promise<T> {
  if (signal === undefined) return pending
  const abortError = (): Error => signal.reason instanceof Error
    ? signal.reason
    : new Error(`creation for session "${sessionId}" aborted`, { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    })
  })
}
