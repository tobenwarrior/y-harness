/** Serialized native mirrors, conservative exclusion and explicit sequential ownership. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { codingSessionDigest } from './digest.ts'
import { codingSessionSnapshotSchema } from './record.ts'
import { codingSessionRecoveryCheckpoint } from './restart-recovery.ts'
import type { CodingSessionCapabilities, CodingSessionLibraryOptions, CodingSessionProvider, CodingSessionSource, CodingSessionProfile, CodingSessionMirror, CodingSessionMirrorSummary, CodingSessionMirrorId, CodingSessionPage, CodingSessionReadRequest, CodingSessionSnapshot, CodingSessionsState, CodingSessionClaimAcknowledgement, CodingSessionHandoff, CodingSessionOwnerToken, CodingSessionSequentialWriterLease, CodingSessionSequentialReleaseReceipt, CodingSessionRecoveryAcknowledgement, CodingSessionSequentialObserver } from './types.ts'

const releaseEvidenceSchema = z.object({
  processExited: z.literal(true), streamsDrained: z.literal(true),
  expectedPrefixPersisted: z.literal(true), noObservedPersistenceErrors: z.literal(true),
})
const capabilities: CodingSessionCapabilities = { discover: true, read: true, refresh: true, continue: false, reason: 'native-writer-handoff-unavailable' }
const profileKey = (source: CodingSessionProfile): string => JSON.stringify([source.provider, source.profileId])
const sourceKey = (source: CodingSessionSource): string => JSON.stringify([source.provider, source.profileId, source.nativeSessionId])
const reclaimable = (marker: CodingSessionHandoff): boolean => marker.phase === 'external-ready' || marker.phase === 'recovered-acknowledged'

/** Owns source registration, operation lifetimes, durable reconciliation, and refusal of unsupported writers. */
export class CodingSessionLibrary {
  private readonly providers = new Map<string, CodingSessionProvider>()
  private readonly lifetime = new AbortController()
  private active: AbortController | undefined
  private cancellationEpoch = 0
  private tail = Promise.resolve()
  private readonly sequential = new Map<CodingSessionMirrorId, {
    marker: CodingSessionHandoff
    provider: CodingSessionProvider
    lease?: CodingSessionSequentialWriterLease
  }>()
  constructor(private readonly options: CodingSessionLibraryOptions) {
    if (options.enableSequentialHandoff === true && options.handoffStore === undefined) {
      throw new Error('Sequential handoff requires durable ownership storage.')
    }
    this.tail = this.recoverMarkers()
  }

  /**
   * Register one configured native source without transferring its write authority.
   * @param provider - configured authorized native connection.
   * @returns idempotent disposer removing availability immediately and joining every retained owner release for this profile.
   */
  register(provider: CodingSessionProvider): () => Promise<void> {
    this.assertOpen()
    const key = profileKey(provider)
    if (this.providers.has(key)) throw new Error('Coding session profile is already registered.')
    this.providers.set(key, provider)
    let removal: Promise<void> | undefined
    return () => {
      if (removal !== undefined) return removal
      if (this.providers.get(key) !== provider) return removal = Promise.resolve()
      this.providers.delete(key)
      const pending = this.tail.then(async () => {
        await this.releaseAll(owner => owner.provider === provider)
      })
      // Awaiters receive the original rejection; older ignored-return callers still have a rejection handler.
      this.tail = pending.catch((_error: unknown) => { /* The retained marker exposes unconfirmed release. */ })
      return removal = pending
    }
  }

  /**
   * List bounded metadata without copying transcript bodies.
   * @returns current source capabilities and retained mirrors, including unavailable sources.
   */
  state(): CodingSessionsState {
    this.assertOpen()
    const mirrors: CodingSessionMirrorSummary[] = []
    for (const [, mirror] of this.options.store.entries()) {
      if (mirrors.length >= this.options.maxMirrors) throw new Error('Coding session inventory exceeded the configured mirror count limit.')
      const { events, ...metadata } = this.view(mirror)
      mirrors.push({ ...metadata, capabilities: this.mirrorCapabilities(mirror), eventCount: events.length })
    }
    const inventory: CodingSessionsState = {
      sources: [...this.providers.values()].map(provider => ({
        provider: provider.provider, profileId: provider.profileId, label: provider.label,
        connected: provider.connected(), capabilities: this.capabilities(provider),
      })), mirrors,
    }
    if (Buffer.byteLength(JSON.stringify(inventory), 'utf8') > this.options.maxBytes) throw new Error('Coding session inventory exceeded the complete framed byte limit.')
    return structuredClone(inventory)
  }

  /**
   * Browse native metadata within one configured source.
   * @param profile - authorized provider and profile scope.
   * @param cursor - opaque native list cursor.
   * @returns one bounded source-labelled native page.
   */
  discover(profile: CodingSessionProfile, cursor?: string): Promise<CodingSessionPage> {
    return this.operation(profile, async (provider, request) => {
      const page = await provider.discover(request, cursor)
      if (page.items.length > request.limit || Buffer.byteLength(JSON.stringify(page), 'utf8') > request.maxBytes) throw new Error('Native coding session list exceeded the configured limit.')
      if (page.items.some(item => profileKey(item.source) !== profileKey(profile))) throw new Error('Native coding session source identity does not match its authorized profile.')
      return structuredClone(page)
    })
  }

  /**
   * Import a stable snapshot while preserving its original source identity.
   * @param source - original native source identity.
   * @returns stable Y mirror; repeated import reconciles through the same record.
   */
  importSession(source: CodingSessionSource): Promise<CodingSessionMirror> {
    return this.operation(source, async (provider, request) => {
      const id = brandString<CodingSessionMirrorId>(`native:${codingSessionDigest(sourceKey(source))}`)
      const owner = this.sequential.get(id)
      const marker = this.options.handoffStore?.get(id)
      if ((owner === undefined && marker !== undefined && !reclaimable(marker))
        || (owner !== undefined && owner.marker.phase !== 'y-owned')) throw new Error('Native writer ownership is unresolved. Release it before refreshing.')
      const snapshot = owner?.lease === undefined ? await provider.read(source.nativeSessionId, request) : await owner.lease.read(request)
      return this.reconcile(source, snapshot, provider, request)
    })
  }

  private async reconcile(
    source: CodingSessionSource, value: CodingSessionSnapshot, provider: CodingSessionProvider, request: CodingSessionReadRequest,
  ): Promise<CodingSessionMirror> {
    const id = brandString<CodingSessionMirrorId>(`native:${codingSessionDigest(sourceKey(source))}`)
    const previous = this.options.store.get(id)
    let snapshot = codingSessionSnapshotSchema.parse(value)
    this.current(provider, request.signal)
    if (sourceKey(snapshot.source) !== sourceKey(source)) throw new Error('Native coding session source identity does not match the requested original session.')
    if (snapshot.writerState === 'active') throw new Error('Native coding session is active. Wait for it to become idle before importing or refreshing.')
    if (snapshot.events.length > request.maxEvents || Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > request.maxBytes) throw new Error('Native coding session history exceeded the configured limit.')
    const seen = new Map<string, string>()
    let divergent = false
    snapshot = { ...snapshot, events: snapshot.events.filter((event) => {
      const digest = seen.get(event.id)
      if (digest !== undefined) { divergent ||= digest !== event.digest; return false }
      seen.set(event.id, event.digest); return true
    }) }
    divergent ||= previous !== undefined && (snapshot.events.length < previous.events.length
      || previous.events.some((event, index) => event.id !== snapshot.events[index]?.id || event.digest !== snapshot.events[index].digest))
    if (divergent && previous === undefined) throw new Error('Native coding session history contains conflicting event identities.')
    if (divergent && previous !== undefined) {
      if (previous.status === 'conflict') return this.view(previous)
      const conflict: CodingSessionMirror = { ...previous, status: 'conflict', conflict: 'history-diverged', revision: previous.revision + 1 }
      if (Buffer.byteLength(JSON.stringify(conflict), 'utf8') > request.maxBytes) throw new Error('Coding session mirror exceeded the complete framed byte limit.')
      await this.options.store.put(id, conflict)
      return this.view(conflict)
    }
    const digest = codingSessionDigest(snapshot.events.map(event => [event.id, event.digest]))
    if (previous !== undefined && previous.digest === digest && previous.cursor === snapshot.cursor && previous.title === snapshot.title && previous.cwd === snapshot.cwd && previous.status === 'ready') return this.view(previous)
    const mirror: CodingSessionMirror = { ...snapshot, id, revision: (previous?.revision ?? 0) + 1, digest, refreshedAt: new Date().toISOString(), status: 'ready', capabilities }
    if (previous === undefined) {
      let retained = 0
      for (const _record of this.options.store.entries()) if (++retained >= this.options.maxMirrors) throw new Error('Coding session retention reached the configured mirror count limit.')
    }
    if (Buffer.byteLength(JSON.stringify(mirror), 'utf8') > request.maxBytes) throw new Error('Coding session mirror exceeded the complete framed byte limit.')
    this.current(provider, request.signal)
    await this.options.store.put(id, mirror)
    return this.view(mirror)
  }

  /**
   * Reconcile source history against the retained mirror prefix.
   * @param id - existing Y mirror identity.
   * @returns reconciled history; divergence retains the old content and cursor.
   */
  async refreshMirror(id: CodingSessionMirrorId): Promise<CodingSessionMirror> {
    return this.importSession((await this.detail(id)).source)
  }

  /**
   * Read retained history independently from source availability.
   * @param id - existing Y mirror identity.
   * @returns detached retained history with current source availability.
   */
  async detail(id: CodingSessionMirrorId): Promise<CodingSessionMirror> {
    this.assertOpen()
    const mirror = this.options.store.get(id)
    if (mirror === undefined) throw new Error('Coding session mirror was not found.')
    return Promise.resolve(this.view(mirror))
  }

  /**
   * Require native-enforced exclusion before inspecting idle state or dispatching.
   * The held provider lease owns original-ID resume, normal native approvals,
   * cancellation, settlement, and release; a Y lease cannot implement this role.
   * @param id - existing Y mirror identity.
   * @param text - human continuation text.
   * @param expectedRevision - exact mirror revision the user reviewed.
   * @returns refreshed original-source history after native settlement.
   */
  async continueSession(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<CodingSessionMirror> {
    if (text.trim().length === 0) throw new Error('Continuation requires a message.')
    if (Buffer.byteLength(JSON.stringify({ id, text, expectedRevision }), 'utf8') > this.options.maxBytes) throw new Error('Continuation message exceeded the configured byte limit.')
    const selected = await this.detail(id)
    return this.operation(selected.source, async (provider, request) => {
      const marker = this.options.handoffStore?.get(id)
      if (marker !== undefined && !reclaimable(marker)) throw new Error('Release sequential ownership before using exclusive continuation.')
      const writer = provider.writer
      if (writer === undefined) throw new Error('Continuation is unavailable: this provider cannot establish an exclusive native writer handoff. Continue in the original native app, then refresh this read-only mirror.')
      const mirror = this.options.store.get(id)
      if (mirror === undefined || mirror.revision !== expectedRevision || mirror.status !== 'ready') throw new Error('Coding session mirror changed or has a history conflict. Refresh and review it before continuing.')
      const lease = await writer.acquire(mirror.source, request)
      try {
        this.current(provider, request.signal)
        if (sourceKey(lease.source) !== sourceKey(mirror.source)) throw new Error('Native writer lease did not preserve the original source identity.')
        const before = codingSessionSnapshotSchema.parse(await lease.read(request))
        this.current(provider, request.signal)
        if (sourceKey(before.source) !== sourceKey(mirror.source) || before.writerState !== 'idle') throw new Error('Native source is active or writer ownership is unknown.')
        if (before.cursor !== mirror.cursor || codingSessionDigest(before.events.map(event => [event.id, event.digest])) !== mirror.digest) throw new Error('Native history diverged after the mirror was read. Refresh before continuing.')
        await lease.resumeOriginal({ source: mirror.source, text, signal: request.signal })
        this.current(provider, request.signal)
        return await this.reconcile(mirror.source, await lease.read(request), provider, request)
      } finally { await lease.release() }
    }, true)
  }


  /**
   * Claim a separately opted-in native owner after the human closes prior native writers.
   * @param id - reviewed mirror identity.
   * @param acknowledgement - exact reviewed source, project, execution root and closed-writer acknowledgement.
   * @returns owned original-source history without starting a model turn.
   */
  async claimSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionClaimAcknowledgement): Promise<CodingSessionMirror> {
    if (this.options.enableSequentialHandoff !== true) throw new Error('Sequential native handoff is disabled.')
    const selected = await this.detail(id)
    return this.operation(selected.source, async (provider, request) => {
      const writer = provider.sequentialWriter
      if (writer === undefined) throw new Error('This native source does not support sequential handoff.')
      const mirror = this.reviewed(id, acknowledgement.expectedRevision)
      if (!z.literal(true).safeParse(acknowledgement.externalWritersClosed).success
        || !z.literal(true).safeParse(acknowledgement.nativeProfileUnchanged).success
        || sourceKey(acknowledgement.source) !== sourceKey(mirror.source)
        || mirror.cwd === undefined || acknowledgement.project !== mirror.cwd) {
        throw new Error('Review the exact original session and project, then close its previous native writer before claiming it.')
      }
      const existing = this.options.handoffStore?.get(id)
      if (this.sequential.has(id) || (existing !== undefined && !reclaimable(existing))) {
        throw new Error('Native writer ownership is unresolved. Release the retained owner before claiming again.')
      }
      const marker: CodingSessionHandoff = {
        id, source: mirror.source, project: mirror.cwd, executionSessionId: acknowledgement.executionSessionId,
        expectedRevision: mirror.revision, ownerToken: brandString<CodingSessionOwnerToken>(randomUUID()),
        phase: 'claiming', toolMode: writer.toolMode, nativeProfileUnchanged: true, externalWritersClosed: true, dispatchedTurnCount: 0, nativeTurnIds: [],
        ...(existing?.recoveryHistory === undefined ? {} : { recoveryHistory: structuredClone(existing.recoveryHistory) }),
      }
      await this.saveMarker(marker)
      const owner: {
        marker: CodingSessionHandoff
        provider: CodingSessionProvider
        lease?: CodingSessionSequentialWriterLease
      } = { marker, provider }
      this.sequential.set(id, owner)
      try {
        owner.lease = await writer.acquire(mirror.source, { ...request, ownerToken: marker.ownerToken, nativeProfileUnchanged: true })
        this.current(provider, request.signal)
        if (sourceKey(owner.lease.source) !== sourceKey(mirror.source)) throw new Error('Native handoff did not preserve the selected original source.')
        this.freshSnapshot(mirror, await owner.lease.read(request), request)
        this.current(provider, request.signal)
        await this.transition(owner, { phase: 'y-owned' })
        return this.view(mirror)
      } catch (error) {
        if (owner.lease !== undefined) {
          try { await this.releaseHeld(id) } catch (_releaseError) { /* Uncertain ownership remains durably blocked. */ }
        } else await this.transition(owner, { phase: 'blocked-uncertain' })
        throw error
      }
    }, true)
  }

  /**
   * Continue only under the retained operational owner and freshly checked original history.
   * @param id - claimed mirror.
   * @param text - explicit human continuation message.
   * @param expectedRevision - reviewed mirror revision.
   * @param observer - optional cancellation signal and awaited admission, native-turn and native-item callbacks.
   * @returns settled original-source mirror; the owner remains held until explicit release.
   */
  async continueSequential(
    id: CodingSessionMirrorId, text: string, expectedRevision: number, observer?: CodingSessionSequentialObserver,
  ): Promise<CodingSessionMirror> {
    if (text.trim().length === 0) throw new Error('Continuation requires a message.')
    if (Buffer.byteLength(JSON.stringify({ id, text, expectedRevision }), 'utf8') > this.options.maxBytes) {
      throw new Error('Continuation message exceeded the configured byte limit.')
    }
    const selected = await this.detail(id)
    return this.operation(selected.source, async (provider, request) => {
      const liveRequest = { ...request,
        signal: observer === undefined ? request.signal : AbortSignal.any([request.signal, observer.signal]) }
      liveRequest.signal.throwIfAborted()
      const owner = this.sequential.get(id)
      if (owner?.lease === undefined || owner.provider !== provider || owner.marker.phase !== 'y-owned') {
        throw new Error('Native writer ownership is not ready. Claim or release this session before continuing.')
      }
      const mirror = this.reviewed(id, expectedRevision)
      try {
        this.freshSnapshot(mirror, await owner.lease.read(liveRequest), liveRequest)
        this.current(provider, liveRequest.signal)
        await this.transition(owner, { phase: 'continuing', expectedRevision })
        const admission = { completed: false }
        const receipt = await owner.lease.resumeOriginal({ source: mirror.source, text, signal: liveRequest.signal,
          ...observer === undefined ? {} : {
            onNativeTurn: receipt => observer.onNativeTurn(receipt),
            onNativeItem: item => observer.onNativeItem(item),
          },
          beforeDispatch: async () => {
            if (admission.completed) throw new Error('Native continuation admission was requested more than once.')
            admission.completed = true
            this.current(provider, liveRequest.signal)
            await this.transition(owner, { dispatchedTurnCount: owner.marker.dispatchedTurnCount + 1 })
            await observer?.beforeDispatch()
          } })
        if (!admission.completed) throw new Error('Native continuation did not establish its durable admission.')
        this.current(provider, liveRequest.signal)
        const snapshot = await owner.lease.read(liveRequest)
        const next = await this.reconcile(mirror.source, snapshot, provider, liveRequest)
        if (next.status !== 'ready') throw new Error('Native history changed during continuation. Release and review the original source.')
        await this.transition(owner, { phase: 'y-owned', expectedRevision: next.revision,
          nativeTurnIds: [...owner.marker.nativeTurnIds, receipt.nativeTurnId] })
        return this.view(next)
      } catch (error) {
        await this.transition(owner, { phase: 'blocked-uncertain' })
        throw error
      }
    }, true, this.options.sequentialTurnTimeoutMs ?? 600000)
  }

  /**
   * Release the retained process only after drain, exit and fresh original-history readback.
   * @param id - claimed mirror identity; a disconnected read source does not prevent release.
   * @returns the retained mirror with confirmed external-ready ownership, or blocked uncertainty.
   */
  releaseSequential(id: CodingSessionMirrorId): Promise<CodingSessionMirror> {
    const pending = this.tail.then(async () => { this.assertOpen(); await this.releaseHeld(id); return this.detail(id) })
    this.tail = pending.then(() => {}, () => {})
    return pending
  }

  /**
   * Check cold original history after the operator stops lost previous writers and reviews unresolved admissions.
   * This checkpoint permits a separate fresh claim; it does not release the original process or certify persistence.
   * @param id - retained native mirror with a lost process handle.
   * @param acknowledgement - exact reviewed source, project, revision, owner and cooperative uncertainty acceptance.
   * @returns retained conflict or a durably acknowledged recovery checkpoint; native execution remains separately gated.
   */
  async recoverSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionRecoveryAcknowledgement): Promise<CodingSessionMirror> {
    const selected = await this.detail(id)
    return this.operation(selected.source, async (provider, request) => {
      if (this.sequential.get(id)?.lease !== undefined) throw new Error('A live retained native owner must be released before restart recovery.')
      const reviewedMirror = (): CodingSessionMirror => {
        const mirror = this.options.store.get(id)
        if (mirror === undefined || mirror.revision !== acknowledgement.expectedRevision) {
          throw new Error('Coding session mirror changed. Review its current revision before recovering the lost owner.')
        }
        return mirror
      }
      const previous = structuredClone(reviewedMirror())
      const ownershipStore = this.options.handoffStore
      if (ownershipStore?.update === undefined) throw new Error('Restart recovery requires atomic ownership storage updates.')
      const retained = ownershipStore.get(id)
      if (retained === undefined || reclaimable(retained)) throw new Error('This native owner does not require restart recovery.')
      const marker = structuredClone(retained)
      if (!z.literal(true).safeParse(acknowledgement.externalWritersClosed).success
        || !z.literal(true).safeParse(acknowledgement.nativeProfileUnchanged).success
        || sourceKey(acknowledgement.source) !== sourceKey(previous.source)
        || sourceKey(marker.source) !== sourceKey(previous.source)
        || marker.ownerToken !== acknowledgement.expectedOwnerToken
        || previous.cwd === undefined || acknowledgement.project !== previous.cwd || marker.project !== previous.cwd) {
        throw new Error('Review the exact lost owner, original session and project, then stop previous writers and keep the native profile unchanged.')
      }
      const unchangedMarker = (): void => {
        const current = this.options.handoffStore?.get(id)
        if (current === undefined || codingSessionDigest(current) !== codingSessionDigest(marker)) {
          throw new Error('Native ownership marker changed during recovery. Review its current owner before trying again.')
        }
      }
      // Refuse unknown admissions before reading or publishing a replacement source snapshot.
      codingSessionRecoveryCheckpoint(marker, previous, previous, acknowledgement)
      const snapshot = codingSessionSnapshotSchema.parse(await provider.read(previous.source.nativeSessionId, request))
      this.current(provider, request.signal); unchangedMarker()
      if (sourceKey(snapshot.source) !== sourceKey(previous.source) || snapshot.cwd !== previous.cwd || snapshot.writerState === 'active') {
        throw new Error('Original native source, project or writer state changed during recovery.')
      }
      if (new Set(snapshot.events.map(event => event.id)).size !== snapshot.events.length) {
        throw new Error('Original native history contains repeated event identities. Review the source before recovering.')
      }
      if (codingSessionDigest(reviewedMirror()) !== codingSessionDigest(previous)) {
        throw new Error('Coding session mirror changed during recovery. Review its current history before trying again.')
      }
      const current = await this.reconcile(previous.source, snapshot, provider, request)
      unchangedMarker(); this.current(provider, request.signal)
      if (current.status === 'conflict') return current
      const checkpoint = codingSessionRecoveryCheckpoint(marker, previous, current, acknowledgement)
      const nextMarker: CodingSessionHandoff = { ...marker, phase: 'recovered-acknowledged', expectedRevision: current.revision,
        recoveryHistory: [...(marker.recoveryHistory ?? []), checkpoint] }
      this.markerWithinLimits(nextMarker); this.view(current, nextMarker)
      await ownershipStore.update(id, (retained) => {
        if (codingSessionDigest(retained) !== codingSessionDigest(marker)) {
          throw new Error('Native ownership marker changed before recovery publication. Review its current owner before trying again.')
        }
        return structuredClone(nextMarker)
      })
      this.sequential.delete(id)
      return this.view(current)
    })
  }

  private async recoverMarkers(): Promise<void> {
    let count = 0
    for (const [, marker] of this.options.handoffStore?.entries() ?? []) {
      if (++count > this.options.maxMirrors) throw new Error('Native handoff ownership exceeded the configured marker limit.')
      const phase = marker.phase
      if (phase !== 'external-ready' && phase !== 'recovered-acknowledged') await this.saveMarker({ ...marker,
        interruptedPhase: marker.interruptedPhase ?? phase, phase: 'blocked-uncertain' })
    }
  }
  private reviewed(id: CodingSessionMirrorId, expectedRevision: number): CodingSessionMirror {
    const mirror = this.options.store.get(id)
    if (mirror === undefined || mirror.revision !== expectedRevision || mirror.status !== 'ready') {
      throw new Error('Coding session mirror changed or has a history conflict. Refresh and review it before continuing.')
    }
    return mirror
  }
  private freshSnapshot(
    mirror: CodingSessionMirror, value: CodingSessionSnapshot, request: CodingSessionReadRequest,
  ): CodingSessionSnapshot {
    const snapshot = codingSessionSnapshotSchema.parse(value)
    if (sourceKey(snapshot.source) !== sourceKey(mirror.source) || snapshot.cwd !== mirror.cwd || snapshot.writerState === 'active'
      || snapshot.cursor !== mirror.cursor
      || codingSessionDigest(snapshot.events.map(event => [event.id, event.digest])) !== mirror.digest) {
      throw new Error('Native history or project changed. Refresh and review the original source before continuing.')
    }
    if (snapshot.events.length > request.maxEvents || Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > request.maxBytes) {
      throw new Error('Native handoff history exceeded the configured limit.')
    }
    return snapshot
  }
  private markerWithinLimits(marker: CodingSessionHandoff): void {
    if (Buffer.byteLength(JSON.stringify(marker), 'utf8') > this.options.maxBytes
      || marker.nativeTurnIds.length > this.options.maxEvents || marker.dispatchedTurnCount > this.options.maxEvents
      || (marker.recoveryHistory?.length ?? 0) > this.options.maxEvents
      || (marker.recoveryHistory?.reduce(
        (count, checkpoint) => count + checkpoint.nativeTurnIds.length, 0) ?? 0) > this.options.maxEvents) {
      throw new Error('Native handoff ownership exceeded the configured limit.')
    }
  }
  private async saveMarker(marker: CodingSessionHandoff): Promise<void> {
    this.markerWithinLimits(marker)
    const store = this.options.handoffStore
    if (store === undefined) throw new Error('Native handoff ownership storage is not available.')
    await store.put(marker.id, structuredClone(marker))
  }
  private async transition(owner: { marker: CodingSessionHandoff }, change: Partial<CodingSessionHandoff>): Promise<void> {
    const next = { ...owner.marker, ...change }
    await this.saveMarker(next); owner.marker = next
  }
  private async releaseAll(accept: (owner: { provider: CodingSessionProvider }) => boolean = () => true): Promise<void> {
    const errors: unknown[] = []
    for (const [id, owner] of this.sequential) if (owner.lease !== undefined && accept(owner)) {
      try { await this.releaseHeld(id) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Native writer release remains uncertain.')
  }
  private async releaseHeld(id: CodingSessionMirrorId): Promise<void> {
    const owner = this.sequential.get(id)
    if (owner?.lease === undefined) {
      if (this.options.handoffStore?.get(id)?.phase === 'external-ready') return
      throw new Error('Native writer ownership is unresolved after restart. Its original process handle is unavailable.')
    }
    let markerFailure: Error | undefined
    try { await this.transition(owner, { phase: 'releasing' }) } catch (error) {
      markerFailure = error instanceof Error ? error : new Error('Native ownership journal failed.', { cause: error })
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(new Error('Native release readback exceeded its time limit.')) }, this.options.timeoutMs)
      let receipt: CodingSessionSequentialReleaseReceipt
      try {
        receipt = await owner.lease.release({ signal: controller.signal, limit: this.options.pageSize,
          maxEvents: this.options.maxEvents, maxBytes: this.options.maxBytes })
        controller.signal.throwIfAborted()
      } finally { clearTimeout(timer) }
      // Native release evidence crosses the adapter admission point before any retained state can advance.
      releaseEvidenceSchema.parse(receipt)
      if (sourceKey(receipt.source) !== sourceKey(owner.marker.source)
        || sourceKey(receipt.snapshot.source) !== sourceKey(owner.marker.source)
        || receipt.snapshot.cwd !== owner.marker.project
        || (owner.marker.dispatchedTurnCount > 0 && (!receipt.completedTurnPersisted
          || new Set(receipt.nativeTurnIds).size < owner.marker.dispatchedTurnCount
          || owner.marker.nativeTurnIds.some(id => !receipt.nativeTurnIds.includes(id))))) {
        throw new Error('Original native persistence could not be confirmed after release.')
      }
      const mirror = this.options.store.get(id)
      if (mirror === undefined) throw new Error('Coding session mirror was not found.')
      const snapshot = codingSessionSnapshotSchema.parse(receipt.snapshot)
      if (snapshot.events.length > this.options.maxEvents || Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.options.maxBytes
        || snapshot.events.length < mirror.events.length
        || mirror.events.some((event, index) => event.id !== snapshot.events[index]?.id
          || event.digest !== snapshot.events[index].digest)) {
        throw new Error('Original native history could not be confirmed after release.')
      }
      const digest = codingSessionDigest(snapshot.events.map(event => [event.id, event.digest]))
      if (mirror.digest !== digest || mirror.cursor !== snapshot.cursor || mirror.title !== snapshot.title) {
        const released: CodingSessionMirror = { ...snapshot, id, digest, revision: mirror.revision + 1,
          refreshedAt: new Date().toISOString(), status: mirror.status, capabilities,
          ...(mirror.conflict === undefined ? {} : { conflict: mirror.conflict }) }
        if (Buffer.byteLength(JSON.stringify(released), 'utf8') > this.options.maxBytes) {
          throw new Error('Coding session mirror exceeded the complete framed byte limit.')
        }
        await this.options.store.put(id, released)
      }
      if (markerFailure !== undefined) throw markerFailure
      await this.transition(owner, { phase: 'external-ready' })
      this.sequential.delete(id)
    } catch (error) {
      owner.marker = { ...owner.marker, phase: 'blocked-uncertain' }
      try { await this.saveMarker(owner.marker) } catch (markerError) {
        throw new AggregateError([error, markerError], 'Native writer release or its ownership journal remains uncertain.')
      }
      throw error
    }
  }

  /**
   * Refuse new operations and drain underlying reads, writes, and held native resources.
   * @returns quiescence after queued operations reject or commit; late native reads cannot publish.
   */
  async close(): Promise<void> {
    this.providers.clear(); this.lifetime.abort(new Error('Coding sessions are closed.'))
    await this.tail
    await this.releaseAll()
  }

  /**
   * Cancel admitted operations and invalidate queued requests from their generation.
   * @returns cancellation and quiescence of current reads/writes; queued old requests also reject.
   */
  async cancelPending(): Promise<void> {
    this.cancellationEpoch++
    this.active?.abort(new Error('Coding session operation was cancelled.'))
    const pending = this.tail.then(async () => {
      await this.releaseAll()
    })
    this.tail = pending.then(() => {}, () => {})
    await pending
  }

  private view(mirror: CodingSessionMirror, proposedHandoff?: CodingSessionHandoff): CodingSessionMirror {
    const provider = this.providers.get(profileKey(mirror.source))
    const marker = this.options.handoffStore?.get(mirror.id)
    const live = this.sequential.get(mirror.id)
    const handoff = proposedHandoff ?? live?.marker ?? (marker === undefined ? undefined : {
      ...marker, phase: reclaimable(marker) ? marker.phase : 'blocked-uncertain' as const,
    })
    const complete = structuredClone({ ...mirror, capabilities: this.mirrorCapabilities(mirror),
      sequentialReleaseAvailable: live?.lease !== undefined,
      sequentialAvailable: this.options.enableSequentialHandoff === true && provider?.connected() === true
        && provider.sequentialWriter !== undefined && mirror.status === 'ready',
      ...(provider?.sequentialWriter === undefined ? {} : { sequentialToolMode: provider.sequentialWriter.toolMode }),
      ...(handoff === undefined ? {} : { handoff }),
    })
    if (Buffer.byteLength(JSON.stringify(complete), 'utf8') > this.options.maxBytes) {
      throw new Error('Coding session detail exceeded the complete framed byte limit.')
    }
    return complete
  }
  private mirrorCapabilities(mirror: CodingSessionMirror): CodingSessionCapabilities {
    const provider = this.providers.get(profileKey(mirror.source))
    const current = this.capabilities(provider)
    const marker = this.options.handoffStore?.get(mirror.id)
    return { ...current, read: true, continue: mirror.status === 'ready' && current.continue
      && (marker === undefined || reclaimable(marker)) }
  }
  private capabilities(provider: CodingSessionProvider | undefined): CodingSessionCapabilities {
    const connected = provider?.connected() === true
    const writable = connected && provider.writer !== undefined
    return {
      ...capabilities, discover: connected, read: connected, refresh: connected, continue: writable,
      reason: !connected ? 'source-disconnected' : writable ? 'exclusive-native-writer' : 'native-writer-handoff-unavailable',
    }
  }

  private assertOpen(): void { if (this.lifetime.signal.aborted) throw new Error('Coding sessions are closed.') }
  private current(provider: CodingSessionProvider, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.providers.get(profileKey(provider)) !== provider || !provider.connected()) throw new Error('Native coding session connection changed. Refresh the source before trying again.')
  }
  private operation<T>(
    profile: CodingSessionProfile, read: (provider: CodingSessionProvider, request: CodingSessionReadRequest) => Promise<T>,
    nativeWriter = false, timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    const epoch = this.cancellationEpoch
    let work: Promise<T> | undefined
    const operation = this.tail.then(async () => {
      this.assertOpen()
      if (epoch !== this.cancellationEpoch) throw new Error('Coding session operation was cancelled.')
      const provider = this.providers.get(profileKey(profile))
      if (provider === undefined || !provider.connected()) throw new Error('Native coding session source is not connected.')
      const controller = new AbortController(); this.active = controller
      const timer = setTimeout(() => {
        controller.abort(new Error('Native coding session read exceeded its time limit.'))
      }, timeoutMs)
      const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
      let onAbort = (): void => {}
      try {
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            const reason: unknown = signal.reason
            reject(reason instanceof Error ? reason : new Error('Coding session operation was cancelled.'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
        })
        if (nativeWriter) void aborted.catch((_error: unknown) => {
          /* The writer observes this same abort signal and owns settlement. */
        })
        const pending = read(provider, {
          signal, limit: this.options.pageSize, maxEvents: this.options.maxEvents, maxBytes: this.options.maxBytes,
        })
        work = pending
        // A writer owns native resources and must settle/release before teardown completes.
        const result = nativeWriter ? await pending : await Promise.race([pending, aborted])
        this.current(provider, signal)
        return result
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', onAbort)
        if (this.active === controller) this.active = undefined
      }
    })
    const drain = async (): Promise<void> => {
      await work?.catch((_error: unknown) => { /* Failure was returned to its caller; the queue still drains underlying work. */ })
    }
    this.tail = operation.then(drain, drain)
    return operation
  }
}
