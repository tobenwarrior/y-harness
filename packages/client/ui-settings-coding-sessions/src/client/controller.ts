/** Remote coding-session queries and user actions with retained state across Settings navigation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CodingSessionProfile, CodingSessionSource, CodingSessionMirrorId, CodingSessionMirror, CodingSessionPage, CodingSessionSummary, CodingSessionsState, CodingSessionClaimAcknowledgement, CodingSessionRecoveryAcknowledgement } from '@deepseek-ai/dsh-coding-session/types'

import type { CodingSessionLinkId, CodingSessionLinkRecord, CodingSessionDestinationRevision, CodingSessionImportAcknowledgement, CodingSessionRollbackAcknowledgement } from '@deepseek-ai/dsh-coding-session/types'
type SessionId = CodingSessionImportAcknowledgement['destinationSessionId']

/** Transport-free method face supplied by the owning generated Remote. */
export interface CodingSessionsApi {
  getState(): Promise<RemoteResult<CodingSessionsState>>
  discover(profile: CodingSessionProfile, cursor?: string): Promise<RemoteResult<CodingSessionPage>>
  importSession(source: CodingSessionSource): Promise<RemoteResult<CodingSessionMirror>>
  refreshMirror(id: CodingSessionMirrorId): Promise<RemoteResult<CodingSessionMirror>>
  detail(id: CodingSessionMirrorId): Promise<RemoteResult<CodingSessionMirror>>
  continueSession(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<RemoteResult<CodingSessionMirror>>
  claimSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionClaimAcknowledgement): Promise<RemoteResult<CodingSessionMirror>>
  continueSequential(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<RemoteResult<CodingSessionMirror>>
  releaseSequential(id: CodingSessionMirrorId): Promise<RemoteResult<CodingSessionMirror>>
  recoverSequential?(
    id: CodingSessionMirrorId, acknowledgement: CodingSessionRecoveryAcknowledgement,
  ): Promise<RemoteResult<CodingSessionMirror>>
  createImportDestination?(id: CodingSessionMirrorId): Promise<RemoteResult<{
    destinationSessionId: SessionId
    revision: CodingSessionDestinationRevision
  }>>
  inspectImportDestination?(id: SessionId): Promise<RemoteResult<{
    destinationSessionId: SessionId
    revision: CodingSessionDestinationRevision
  }>>
  importIntoSession?(
    id: CodingSessionMirrorId, acknowledgement: CodingSessionImportAcknowledgement,
  ): Promise<RemoteResult<CodingSessionLinkRecord>>
  linkedDetail?(id: CodingSessionLinkId): Promise<RemoteResult<CodingSessionLinkRecord>>
  rollbackImport?(
    id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement,
  ): Promise<RemoteResult<CodingSessionLinkRecord>>
  recoverImport?(id: CodingSessionLinkId): Promise<RemoteResult<CodingSessionLinkRecord>>
  abandonImport?(
    id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement,
  ): Promise<RemoteResult<CodingSessionLinkRecord>>
  cancelPending(): Promise<RemoteResult<void>>
}
/** One settled user-operation notice rendered by the persistent shell overlay. */
export interface CodingSessionsNotice { seq: number; kind: 'imported' | 'refreshed' | 'continued' | 'claimed' | 'released' | 'recovered' | 'linked' | 'compensated' | 'importRecovered' | 'importAbandoned' | 'destinationCreated' | 'failed' }
/** Canonical destination read bound to the exact selected mirror and optional mapping. */
export interface CodingSessionDestinationReview {
  destinationSessionId: SessionId
  revision: CodingSessionDestinationRevision
  mirrorId: CodingSessionMirrorId
  mirrorRevision: number
  linkId?: CodingSessionLinkId
  linkRevision?: number
}
/** Browser state retains visible data when a source query or operation fails. */
export interface CodingSessionsUiState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  inventory: CodingSessionsState | null
  discovered: CodingSessionSummary[]
  profile: CodingSessionProfile | null
  cursor: string | null
  selected: CodingSessionMirror | null
  selectedLink: CodingSessionLinkRecord | null
  reviewedDestination: CodingSessionDestinationReview | null
  recoverySupported: boolean
  busy: boolean
  queryError: boolean
  notice: CodingSessionsNotice | null
}
/** Registration-side derived props; no transport or other client-plugin values reach the component. */
export interface CodingSessionsFace {
  hooks: { sessions: HostObservable<CodingSessionsUiState> }
  ensure(): void
  refreshState(): void
  discover(profile: CodingSessionProfile, more?: boolean): void
  importSession(source: CodingSessionSource): void
  refreshMirror(id: CodingSessionMirrorId): void
  select(id: CodingSessionMirrorId): void
  continueSession(id: CodingSessionMirrorId, text: string, expectedRevision: number): void
  claimSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionClaimAcknowledgement): void
  continueSequential(id: CodingSessionMirrorId, text: string, expectedRevision: number): void
  releaseSequential(id: CodingSessionMirrorId): void
  recoverSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionRecoveryAcknowledgement): void
  createImportDestination(id: CodingSessionMirrorId): void
  reviewImportDestination(id: SessionId): void
  selectLink(id: CodingSessionLinkId): void
  importIntoSession(id: CodingSessionMirrorId, acknowledgement: CodingSessionImportAcknowledgement): void
  rollbackImport(id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement): void
  recoverImport(id: CodingSessionLinkId): void
  abandonImport(id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement): void
  cancelPending(): void
  dismissNotice(): void
}
async function valueOf<T>(promise: Promise<RemoteResult<T>>): Promise<T> { const result = await promise; if (!result.ok) throw new Error('Native coding session operation did not complete.'); return result.value }
/** Owns query generations, operation feedback, and reconnect/dispose invalidation. */
export class CodingSessionsController {
  /** Current query and viewing state shared by the Settings section and persistent notice overlay. */
  readonly source = createSnapshotStore<CodingSessionsUiState>({ status: 'idle', inventory: null, discovered: [], profile: null, cursor: null, selected: null, selectedLink: null, reviewedDestination: null, recoverySupported: false, busy: false, queryError: false, notice: null })
  private generation = 0
  private disposed = false
  private noticeSequence = 0
  constructor(private readonly api: CodingSessionsApi) { this.patch({ recoverySupported: api.recoverSequential !== undefined }) }
  /**
   * Bind query and action callbacks to this controller's lifetime.
   * @returns the callbacks and observable input consumed by this plugin's own components.
   */
  face(): CodingSessionsFace { return { hooks: { sessions: this.source }, ensure: () => { if (this.source.getSnapshot().status === 'idle') void this.refreshState() }, refreshState: () => { void this.refreshState() }, discover: (profile, more) => { void this.discover(profile, more) }, importSession: (source) => { void this.importSession(source) }, refreshMirror: (id) => { void this.refreshMirror(id) }, select: (id) => { void this.select(id) }, continueSession: (id, text, revision) => { void this.continueSession(id, text, revision) }, claimSequential: (id, acknowledgement) => { void this.claimSequential(id, acknowledgement) }, continueSequential: (id, text, revision) => { void this.continueSequential(id, text, revision) }, releaseSequential: (id) => { void this.releaseSequential(id) }, recoverSequential: (id, ack) => { void this.recoverSequential(id, ack) }, createImportDestination: (id) => { void this.createImportDestination(id) }, reviewImportDestination: (id) => { void this.reviewImportDestination(id) }, selectLink: (id) => { void this.selectLink(id) }, importIntoSession: (id, ack) => { void this.importIntoSession(id, ack) }, rollbackImport: (id, ack) => { void this.rollbackImport(id, ack) }, recoverImport: (id) => { void this.recoverImport(id) }, abandonImport: (id, ack) => { void this.abandonImport(id, ack) }, cancelPending: () => { void this.cancelPending() }, dismissNotice: () => { this.patch({ notice: null }) } } }
  /**
   * Reload metadata, update source capabilities, and invalidate a changed selected revision.
   * @returns completion after inventory publication or a retained query failure.
   */
  async refreshState(): Promise<void> {
    await this.query(async () => {
      const inventory = await valueOf(this.api.getState())
      const before = this.source.getSnapshot()
      const selected = before.selected
      const current = inventory.mirrors.find(mirror => mirror.id === selected?.id)
      const source = inventory.sources.find(value =>
        value.provider === before.profile?.provider && value.profileId === before.profile.profileId)
      const discovery = source?.connected === true && source.capabilities.discover ? {} : { profile: null, discovered: [], cursor: null }
      let retainedSelection = selected
      if (selected !== null) {
        retainedSelection = null
        if (current !== undefined && current.revision === selected.revision) {
          // Replace live optional fields; omitted values clear stale browser projections while preserving the reviewed transcript.
          const { sequentialAvailable: _available, sequentialReleaseAvailable: _releaseAvailable,
            sequentialToolMode: _toolMode, handoff: _handoff, ...retained } = selected
          retainedSelection = { ...retained, capabilities: current.capabilities,
            ...(current.sequentialAvailable === undefined ? {} : { sequentialAvailable: current.sequentialAvailable }),
            ...(current.sequentialReleaseAvailable === undefined ? {} : { sequentialReleaseAvailable: current.sequentialReleaseAvailable }),
            ...(current.sequentialToolMode === undefined ? {} : { sequentialToolMode: current.sequentialToolMode }),
            ...(current.handoff === undefined ? {} : { handoff: current.handoff }),
          }
        }
      }
      const currentLink = inventory.links?.find(link => link.id === before.selectedLink?.id)
      let selectedLink = retainedSelection === null || currentLink?.revision !== before.selectedLink?.revision ? null : before.selectedLink
      if (selectedLink !== null && currentLink !== undefined
        && (currentLink.prepared !== (selectedLink.pending !== undefined) || currentLink.status !== selectedLink.status)) {
        selectedLink = this.api.linkedDetail === undefined ? null : await valueOf(this.api.linkedDetail(selectedLink.id))
      }
      return { inventory, status: 'ready', selectedLink, reviewedDestination: null, ...(selected === null ? {} : { selected: retainedSelection }), ...discovery }
    })
  }
  /**
   * Browse a selected source without importing its history.
   * @param profile - selected native scope.
   * @param more - append its next native page.
   * @returns query completion.
   */
  async discover(profile: CodingSessionProfile, more = false): Promise<void> {
    await this.query(async () => {
      const before = this.source.getSnapshot()
      const same = before.profile?.provider === profile.provider && before.profile.profileId === profile.profileId
      const page = await valueOf(this.api.discover(profile, more && same ? before.cursor ?? undefined : undefined))
      const items = more && same ? [...before.discovered, ...page.items] : page.items
      const seen = new Set<string>()
      return { profile, discovered: items.filter((item) => { const key = JSON.stringify(item.source); if (seen.has(key)) return false; seen.add(key); return true }), cursor: page.nextCursor ?? null, status: 'ready' }
    })
  }
  /**
   * Import and select the original native history.
   * @param source - original native identity.
   * @returns settled import feedback and selected readable mirror.
   */
  async importSession(source: CodingSessionSource): Promise<void> { await this.change('imported', () => valueOf(this.api.importSession(source))) }
  /**
   * Request a source refresh with persistent operation feedback.
   * @param id - selected Y mirror.
   * @returns settled refresh feedback; failures retain the history.
   */
  async refreshMirror(id: CodingSessionMirrorId): Promise<void> { await this.change('refreshed', () => valueOf(this.api.refreshMirror(id))) }
  /**
   * Load the selected transcript through the detail operation.
   * @param id - retained Y mirror.
   * @returns selected source-labelled transcript or a retained query failure.
   */
  async select(id: CodingSessionMirrorId): Promise<void> { await this.query(async () => ({ selected: await valueOf(this.api.detail(id)), selectedLink: null, reviewedDestination: null, status: 'ready' })) }
  /**
   * Submit human continuation text under the Host's original-source ownership checks.
   * @param id - reviewed mirror.
   * @param text - human continuation.
   * @param expectedRevision - reviewed revision.
   * @returns native continuation feedback under Host capability gates.
   */
  async continueSession(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<void> { await this.change('continued', () => valueOf(this.api.continueSession(id, text, expectedRevision))) }

  /**
   * Claim original-source ownership under an explicit closed-writer acknowledgement.
   * @param id - reviewed mirror.
   * @param acknowledgement - exact reviewed source, project, revision and selected execution session.
   * @returns settled ownership feedback and retained history.
   */
  async claimSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionClaimAcknowledgement): Promise<void> {
    await this.change('claimed', () => valueOf(this.api.claimSequential(id, acknowledgement)))
  }
  /**
   * Continue under the Host's retained original-source owner.
   * @param id - claimed mirror.
   * @param text - human continuation message.
   * @param expectedRevision - reviewed history revision.
   * @returns settled continuation feedback without implying native persistence.
   */
  async continueSequential(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<void> {
    await this.change('continued', () => valueOf(this.api.continueSequential(id, text, expectedRevision)))
  }
  /**
   * Return the same original session to the native app after confirmed release.
   * @param id - claimed mirror.
   * @returns settled release feedback; uncertainty retains visible history and ownership.
   */
  async releaseSequential(id: CodingSessionMirrorId): Promise<void> {
    await this.change('released', () => valueOf(this.api.releaseSequential(id)))
  }

  /**
   * Request cold recovery for the reviewed interrupted owner.
   * @param id - exact interrupted mirror.
   * @param acknowledgement - reviewed old owner and distinct unresolved-turn acceptance.
   * @returns explicit recovery without acquisition or dispatch.
   */
  async recoverSequential(id: CodingSessionMirrorId, acknowledgement: CodingSessionRecoveryAcknowledgement): Promise<void> {
    await this.change('recovered', () => {
      const selected = this.source.getSnapshot().selected
      if (this.api.recoverSequential === undefined || selected?.id !== id || selected.revision !== acknowledgement.expectedRevision
        || selected.handoff?.ownerToken !== acknowledgement.expectedOwnerToken) throw new Error('Recovery review changed.')
      return valueOf(this.api.recoverSequential(id, acknowledgement))
    })
  }
  /**
   * Create and retain a reviewed cold Y destination for the selected native mirror.
   * @param id - reviewed native mirror.
   * @returns one explicitly created cold ordinary-Y destination and its canonical revision.
   */
  async createImportDestination(id: CodingSessionMirrorId): Promise<void> {
    await this.write('destinationCreated', async () => {
      const selected = this.requireMirror(id)
      if (this.api.createImportDestination === undefined) throw new Error('Destination creation unavailable.')
      const result = await valueOf(this.api.createImportDestination(id))
      const inventory = await valueOf(this.api.getState())
      this.requireCold(result.destinationSessionId, selected, inventory)
      return { inventory, reviewedDestination: this.review(result, selected, null), selectedLink: null }
    }, false)
  }
  /**
   * Bind a canonical destination review to the current mirror and link.
   * @param id - explicit cold exact-project destination.
   * @returns canonical review bound to the current mirror/link revisions.
   */
  async reviewImportDestination(id: SessionId): Promise<void> {
    await this.query(async () => {
      const before = this.source.getSnapshot()
      this.patch({ reviewedDestination: null })
      const selected = this.requireMirror(before.selected?.id, false)
      this.requireCold(id, selected, before.inventory)
      if (this.api.inspectImportDestination === undefined) throw new Error('Destination inspection unavailable.')
      const result = await valueOf(this.api.inspectImportDestination(id))
      if (result.destinationSessionId !== id) throw new Error('Destination identity changed.')
      return { reviewedDestination: this.review(result, selected, before.selectedLink), status: 'ready' }
    })
  }
  /**
   * Select a retained link and its latest native mirror for review.
   * @param id - explicit mapping.
   * @returns its retained intent plus the latest readable mirror, never automatic replay.
   */
  async selectLink(id: CodingSessionLinkId): Promise<void> {
    await this.query(async () => {
      if (this.api.linkedDetail === undefined) throw new Error('Linked imports unavailable.')
      const selectedLink = await valueOf(this.api.linkedDetail(id))
      const selected = await valueOf(this.api.detail(selectedLink.mirrorId))
      return { selectedLink, selected, reviewedDestination: null, status: 'ready' }
    })
  }
  /**
   * Append the reviewed native history as quoted context in the selected cold Y Session.
   * @param id - reviewed mirror.
   * @param acknowledgement - exact canonical destination and optional link revisions.
   * @returns quoted-context import and fresh inventory.
   */
  async importIntoSession(id: CodingSessionMirrorId, acknowledgement: CodingSessionImportAcknowledgement): Promise<void> {
    await this.write('linked', async () => {
      const selected = this.requireMirror(id)
      const before = this.source.getSnapshot()
      this.requireReview(acknowledgement.destinationSessionId, acknowledgement.expectedDestinationRevision)
      if (selected.revision !== acknowledgement.expectedMirrorRevision
        || before.selectedLink?.revision !== acknowledgement.expectedLinkRevision
        || before.selectedLink?.pending !== undefined
        || (before.selectedLink !== null
          && (before.selectedLink.destinationSessionId !== acknowledgement.destinationSessionId || before.selectedLink.mirrorId !== id))
        || this.api.importIntoSession === undefined) throw new Error('Import review changed.')
      const existing = before.inventory?.links?.find(link =>
        link.mirrorId === id && link.destinationSessionId === acknowledgement.destinationSessionId)
      if (existing !== undefined && before.selectedLink?.id !== existing.id) throw new Error('Review the existing mapping first.')
      const selectedLink = await valueOf(this.api.importIntoSession(id, acknowledgement))
      return { selectedLink }
    })
  }
  /**
   * Compensate the reviewed import while retaining its raw native history.
   * @param id - reviewed mapping.
   * @param acknowledgement - exact link and canonical destination revisions.
   * @returns append-only compensation, retaining raw history.
   */
  async rollbackImport(id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement): Promise<void> {
    await this.write('compensated', async () => {
      const selected = this.requireLink(id, acknowledgement)
      if (selected.pending !== undefined || this.api.rollbackImport === undefined) throw new Error('Compensation unavailable.')
      return { selectedLink: await valueOf(this.api.rollbackImport(id, acknowledgement)) }
    })
  }
  /**
   * Recover the explicitly selected prepared import after rechecking its retained intent.
   * @param id - explicitly reviewed prepared mapping.
   * @returns service-controlled recovery, never automatic replay.
   */
  async recoverImport(id: CodingSessionLinkId): Promise<void> {
    await this.write('importRecovered', async (active) => {
      const selected = this.source.getSnapshot().selectedLink
      if (selected?.id !== id || selected.pending === undefined || this.api.recoverImport === undefined || this.api.linkedDetail === undefined) throw new Error('No reviewed prepared import.')
      const current = await valueOf(this.api.linkedDetail(id))
      if (!active()) throw new Error('Prepared recovery review was cancelled.')
      if (current.revision !== selected.revision || JSON.stringify(current.pending) !== JSON.stringify(selected.pending)) throw new Error('Prepared import changed.')
      return { selectedLink: await valueOf(this.api.recoverImport(id)) }
    })
  }
  /**
   * Abandon the reviewed prepared import only when no owned payload was appended.
   * @param id - reviewed prepared mapping.
   * @param acknowledgement - exact link/canonical destination revision.
   * @returns explicit abandonment only after service proves no owned payload.
   */
  async abandonImport(id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement): Promise<void> {
    await this.write('importAbandoned', async () => {
      const selected = this.requireLink(id, acknowledgement)
      if (selected.pending === undefined || this.api.abandonImport === undefined) throw new Error('No prepared import to abandon.')
      return { selectedLink: await valueOf(this.api.abandonImport(id, acknowledgement)) }
    })
  }
  private requireMirror(id: CodingSessionMirrorId | undefined, ready = true): CodingSessionMirror {
    const selected = this.source.getSnapshot().selected
    if (selected === null || selected.id !== id || selected.cwd === undefined || (ready && selected.status !== 'ready')
      || this.source.getSnapshot().inventory?.linkedImportsAvailable !== true) throw new Error('Review a supported exact-project mirror.')
    return selected
  }
  private requireCold(id: SessionId, selected: CodingSessionMirror, inventory: CodingSessionsState | null): void {
    if (!inventory?.importDestinations?.some(destination => destination.id === id && !destination.live && destination.project === selected.cwd)) throw new Error('Select a cold destination in the exact project.')
  }
  private review(
    result: { destinationSessionId: SessionId
      revision: CodingSessionDestinationRevision },
    selected: CodingSessionMirror, link: CodingSessionLinkRecord | null,
  ): CodingSessionDestinationReview {
    return { ...result, mirrorId: selected.id, mirrorRevision: selected.revision,
      ...(link === null ? {} : { linkId: link.id, linkRevision: link.revision }) }
  }
  private requireReview(id: SessionId, revision: CodingSessionDestinationRevision): void {
    const before = this.source.getSnapshot()
    const review = before.reviewedDestination
    const selected = before.selected
    if (selected === null || review === null || review.destinationSessionId !== id
      || review.revision.eventCount !== revision.eventCount || review.revision.digest !== revision.digest
      || review.mirrorId !== selected.id || review.mirrorRevision !== selected.revision
      || review.linkId !== before.selectedLink?.id || review.linkRevision !== before.selectedLink?.revision) throw new Error('Inspect the exact destination revision before writing.')
    this.requireCold(id, selected, before.inventory)
  }
  private requireLink(id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement): CodingSessionLinkRecord {
    const selected = this.source.getSnapshot().selectedLink
    if (selected?.id !== id || selected.revision !== acknowledgement.expectedLinkRevision) throw new Error('Linked import review changed.')
    this.requireReview(selected.destinationSessionId, acknowledgement.expectedDestinationRevision)
    return selected
  }
  private async write(kind: CodingSessionsNotice['kind'], operation: (active: () => boolean) => Promise<Partial<CodingSessionsUiState>>, reload = true): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy) return
    const generation = ++this.generation
    this.patch({ busy: true, queryError: false })
    try {
      const result = await operation(() => generation === this.generation && !this.isDisposed())
      if (generation !== this.generation || this.isDisposed()) return
      let inventory = result.inventory ?? this.source.getSnapshot().inventory
      let queryError = false
      if (reload) { try { inventory = await valueOf(this.api.getState()) } catch (_error) { queryError = true } }
      if (generation !== this.generation || this.isDisposed()) return
      this.patch({ ...result, inventory, reviewedDestination: reload ? null : result.reviewedDestination ?? null, busy: false, queryError,
        notice: { seq: ++this.noticeSequence, kind: kind === 'linked' && result.selectedLink?.status === 'conflict' ? 'failed' : kind } })
    } catch (_error) {
      if (generation !== this.generation || this.isDisposed()) return
      const before = this.source.getSnapshot()
      let selected = before.selected
      let selectedLink = before.selectedLink
      let inventory = before.inventory
      try {
        if (selected !== null) selected = await valueOf(this.api.detail(selected.id))
      } catch (_detailError) { /* Retain readable history. */ }
      try {
        if (selectedLink !== null && this.api.linkedDetail !== undefined) {
          selectedLink = await valueOf(this.api.linkedDetail(selectedLink.id))
        }
      } catch (_detailError) { /* Retain reviewed mapping. */ }
      try {
        inventory = await valueOf(this.api.getState())
      } catch (_inventoryError) { /* A later explicit reload can reconcile the journal. */ }
      if (generation === this.generation) this.patch({ selected, selectedLink, inventory, reviewedDestination: null, busy: false, notice: { seq: ++this.noticeSequence, kind: 'failed' } })
    }
  }

  /**
   * Cancel source work, await admitted writes and invalidate late browser responses.
   * @returns retained mirror and mapping state after quiescence; no write is replayed or undone.
   */
  async cancelPending(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    const before = this.source.getSnapshot()
    const active = () => generation === this.generation && !this.isDisposed()
    let selected = before.selected
    let selectedLink = before.selectedLink
    let inventory = before.inventory
    let queryError = false
    let inventoryRefreshed = false
    this.patch({ busy: true, queryError: false, reviewedDestination: null })
    try { await valueOf(this.api.cancelPending()) } catch (_error) {
      queryError = true // A lost transport or unconfirmed release requires an explicit later reload.
    }
    if (!active()) return
    try { inventory = await valueOf(this.api.getState()); inventoryRefreshed = true } catch (_error) { queryError = true }
    if (!active()) return
    if (selected !== null) {
      try { selected = await valueOf(this.api.detail(selected.id)) } catch (_error) { queryError = true /* Retain readable history. */ }
    }
    if (!active()) return
    if (inventoryRefreshed) {
      const link = inventory?.links?.find(item => item.mirrorId === before.selected?.id
        && (before.selectedLink === null
          ? item.destinationSessionId === before.reviewedDestination?.destinationSessionId : item.id === before.selectedLink.id))
      if (link === undefined) selectedLink = null
      else if (selectedLink === null || link.revision !== selectedLink.revision || link.status !== selectedLink.status
        || link.prepared !== (selectedLink.pending !== undefined) || link.generationCount !== selectedLink.generations.length) {
        try {
          if (this.api.linkedDetail === undefined) throw new Error('Linked imports unavailable.')
          selectedLink = await valueOf(this.api.linkedDetail(link.id))
        } catch (_error) { queryError = true /* Retain the last readable mapping. */ }
      }
    }
    if (active()) this.patch({ selected, selectedLink, inventory, reviewedDestination: null, busy: false, queryError,
      status: inventory === null ? 'idle' : 'ready', ...(queryError ? { notice: { seq: ++this.noticeSequence, kind: 'failed' as const } } : {}) })
  }
  /** Invalidate old transport responses and refresh retained source capabilities. */
  reconnect(): void { this.generation++; this.patch({ busy: false, reviewedDestination: null }); void this.refreshState() }
  /** Prevent late Remote replies from updating a disposed client plugin. */
  dispose(): void { this.disposed = true; this.generation++ }
  private isDisposed(): boolean { return this.disposed }
  private patch(value: Partial<CodingSessionsUiState>): void {
    if (!this.disposed) this.source.set({ ...this.source.getSnapshot(), ...value })
  }
  private async query(read: () => Promise<Partial<CodingSessionsUiState>>): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy) return
    const generation = ++this.generation; this.patch({ busy: true, queryError: false, status: this.source.getSnapshot().inventory === null ? 'loading' : 'ready' })
    try { const value = await read(); if (generation === this.generation) this.patch({ ...value, busy: false, queryError: false }) }
    catch (_error) { if (generation === this.generation) this.patch({ busy: false, queryError: true, status: this.source.getSnapshot().inventory === null ? 'error' : 'ready' }) }
  }
  private async change(kind: CodingSessionsNotice['kind'], operation: () => Promise<CodingSessionMirror>): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy) return
    const generation = ++this.generation; this.patch({ busy: true })
    try {
      const selected = await operation()
      if (generation !== this.generation || this.isDisposed()) return
      const current = this.source.getSnapshot().inventory
      const { events, ...metadata } = selected
      const mirrors = [...(current?.mirrors ?? []).filter(item => item.id !== selected.id), { ...metadata, eventCount: events.length }]
      let inventory: CodingSessionsState = { ...current, sources: current?.sources ?? [], mirrors }
      let queryError = false
      try { inventory = await valueOf(this.api.getState()) } catch (_error) { queryError = true }
      if (generation !== this.generation || this.isDisposed()) return
      this.patch({
        selected, inventory, selectedLink: null, reviewedDestination: null, queryError,
        busy: false, notice: { seq: ++this.noticeSequence, kind: kind === 'recovered' && selected.handoff?.phase !== 'recovered-acknowledged' ? 'failed' : kind },
      })
    } catch (_error) {
      if (generation !== this.generation || this.isDisposed()) return
      const selected = this.source.getSnapshot().selected
      if (selected !== null) {
        try {
          const retained = await valueOf(this.api.detail(selected.id))
          if (generation === this.generation) this.patch({ selected: retained })
        } catch (_detailError) { /* A lost source keeps the last readable browser history. */ }
      }
      if (generation === this.generation) this.patch({ busy: false, reviewedDestination: null, notice: { seq: ++this.noticeSequence, kind: 'failed' } })
    }
  }
}
