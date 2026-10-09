/** Remote inventory and operation state retained across panel navigation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SkillLibraryId, SkillLibraryItem, SkillLibraryList, SkillLibraryDetail, SkillCleanupProposal,
  SkillLibraryListRequest, SkillLibraryIdRequest, SkillLibraryHashRequest, SkillLibraryPinRequest,
  SkillLibraryAutomaticRequest, SkillLibraryCleanupRequest, SkillLibraryApplyRequest,
  SkillLibraryRollbackRequest, SkillLibraryItemValue, SkillLibraryApplyValue, SkillRevisionId,
  SkillLearningProposal, SkillLearningProposalSummary, SkillLearningProposalId, SkillLearningEvidence,
  SkillLearningStatus, SkillLearningProposeRequest, SkillLearningListRequest, SkillLearningProposalRequest,
  SkillLearningApplyRequest, SkillLearningPolicyRequest, SkillLearningPolicy, SkillLearningPolicyId,
  SkillLearningAutomaticRequest, SkillLearningOptIn,
} from '@deepseek-ai/dsh-skill-library/types'

type Method<Request, Value> = (request: Request) => Promise<RemoteResult<Value>>

/** Typed method face consumed without access to the transport service. */
export interface SkillLibraryApi {
  readonly list: Method<SkillLibraryListRequest, SkillLibraryList>
  readonly detail: Method<SkillLibraryIdRequest, SkillLibraryDetail>
  readonly setPinned: Method<SkillLibraryPinRequest, SkillLibraryItemValue>
  readonly adopt: Method<SkillLibraryHashRequest, SkillLibraryItemValue>
  readonly setAutomaticCleanup: Method<SkillLibraryAutomaticRequest, SkillLibraryItemValue>
  readonly archive: Method<SkillLibraryHashRequest, SkillLibraryItemValue>
  readonly restore: Method<SkillLibraryIdRequest, SkillLibraryItemValue>
  readonly previewCleanup: Method<SkillLibraryCleanupRequest, SkillCleanupProposal>
  readonly applyCleanup: Method<SkillLibraryApplyRequest, SkillLibraryApplyValue>
  readonly rollback: Method<SkillLibraryRollbackRequest, SkillLibraryItemValue>
  readonly listProposals: Method<SkillLearningListRequest, readonly SkillLearningProposalSummary[]>
  readonly detailProposal: Method<SkillLearningProposalRequest, SkillLearningProposal>
  readonly proposeLearning: Method<SkillLearningProposeRequest, SkillLearningProposal>
  readonly validateProposal: Method<SkillLearningProposalRequest, SkillLearningProposal>
  readonly applyProposal: Method<SkillLearningApplyRequest, SkillLearningProposal>
  readonly rejectProposal: Method<SkillLearningProposalRequest, SkillLearningProposal>
  readonly listLearningEvidence: Method<SkillLearningListRequest, readonly SkillLearningEvidence[]>
  readonly learningStatus: Method<Record<string, never>, SkillLearningStatus>
  readonly approveLearningPolicy: Method<SkillLearningPolicyRequest, SkillLearningPolicy>
  readonly setAutomaticLearning: Method<SkillLearningAutomaticRequest, SkillLearningOptIn>
}

/** Deliberate item actions; every source edit carries its observed hash. */
export type LibraryAction = 'pin' | 'unpin' | 'adopt' | 'archive' | 'restore' | 'automaticOn' | 'automaticOff'
/** Transient operation outcome displayed outside the main panel. */
export interface LibraryNotice { readonly seq: number; readonly kind: 'changed' | 'restored' | 'cleanupApplied' | 'actionError' }
/** Review metadata and lazy full proposal state, independent from skill bodies. */
export interface SkillLearningUiState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: boolean
  readonly reviews: readonly SkillLearningProposalSummary[]
  readonly detail: SkillLearningProposal | null
  readonly detailId: SkillLearningProposalId | null
  readonly detailStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly evidence: readonly SkillLearningEvidence[]
  readonly providers: SkillLearningStatus | null
}
/**
 * Initialize the review query state before reading Host metadata.
 * @returns an empty UI query state without a proposal or implied verification.
 */
export function createLearningState(): SkillLearningUiState {
  return { status: 'idle', error: false, reviews: [], detail: null, detailId: null, detailStatus: 'idle', evidence: [], providers: null }
}
/** Query and operation state from the owning Remote controller. */
export interface SkillLibraryState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly inventory: SkillLibraryList | null
  readonly readError: boolean
  readonly detail: SkillLibraryDetail | null
  readonly detailId: SkillLibraryId | null
  readonly detailStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly busy: boolean
  readonly cleanupOpen: boolean
  readonly previewLoading: boolean
  readonly previewError: boolean
  readonly proposal: SkillCleanupProposal | null
  readonly notice: LibraryNotice | null
  readonly learning: SkillLearningUiState
}

/** Data callbacks and the observable hook input injected at registration. */
export interface SkillLibraryFace {
  readonly hooks: { readonly library: HostObservable<SkillLibraryState> }
  readonly ensure: () => void
  readonly refresh: () => void
  readonly loadDetail: (id: SkillLibraryId) => void
  readonly act: (action: LibraryAction, item: SkillLibraryItem) => void
  readonly preview: (ids?: readonly SkillLibraryId[]) => void
  readonly closePreview: () => void
  readonly applyPreview: () => void
  readonly rollback: (item: SkillLibraryItem, revisionId: SkillRevisionId) => void
  readonly dismissNotice: () => void
  readonly refreshLearning: () => void
  readonly loadReview: (id: SkillLearningProposalId) => void
  readonly proposeLearning: (request: SkillLearningProposeRequest) => void
  readonly validateReview: (id: SkillLearningProposalId) => void
  readonly approveReview: (id: SkillLearningProposalId) => void
  readonly rejectReview: (id: SkillLearningProposalId) => void
  readonly approvePolicy: (request: SkillLearningPolicyRequest) => void
  readonly setLearningAutomatic: (item: SkillLibraryItem, policyId: SkillLearningPolicyId, enabled: boolean) => void
}

async function valueOf<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Owns query lifetimes and safe user-requested operation sequencing. */
export class SkillLibraryController {
  /** Published inventory, selected detail, and settled operation state. */
  readonly source = createSnapshotStore<SkillLibraryState>({ status: 'idle', inventory: null, readError: false,
    detail: null, detailId: null, detailStatus: 'idle', busy: false, cleanupOpen: false,
    previewLoading: false, previewError: false, proposal: null, notice: null, learning: createLearningState() })
  private disposed = false
  private pending: Promise<void> | undefined
  private detailGeneration = 0
  private previewGeneration = 0
  private noticeSequence = 0
  private learningPending: Promise<void> | undefined
  private reviewGeneration = 0

  constructor(private readonly api: SkillLibraryApi) {}

  /** Stop publishing results after the plugin unloads. */
  dispose(): void { this.disposed = true; this.detailGeneration++; this.previewGeneration++; this.reviewGeneration++ }

  /**
   * Build the registration injection with no service objects in component props.
   * @returns observable data and user-operation callbacks.
   */
  face(): SkillLibraryFace {
    return { hooks: { library: this.source },
      ensure: () => { void this.refresh(); void this.refreshLearning() },
      refresh: () => { void this.refresh(true); void this.refreshLearning() }, loadDetail: (id) => { void this.loadDetail(id) },
      act: (action, item) => { void this.act(action, item) }, preview: (ids) => { void this.preview(ids) },
      closePreview: () => { this.closePreview() }, applyPreview: () => { void this.applyPreview() },
      rollback: (item, revisionId) => { void this.rollback(item, revisionId) },
      dismissNotice: () => { this.patch({ notice: null }) },
      refreshLearning: () => { void this.refreshLearning() }, loadReview: (id) => { void this.loadReview(id) },
      proposeLearning: (request) => { void this.proposeLearning(request) }, validateReview: (id) => { void this.validateReview(id) },
      approveReview: (id) => { void this.approveReview(id) }, rejectReview: (id) => { void this.rejectReview(id) },
      approvePolicy: (request) => { void this.approvePolicy(request) },
      setLearningAutomatic: (item, policyId, enabled) => { void this.setLearningAutomatic(item, policyId, enabled) } }
  }

  /**
   * Refresh review metadata while retaining the previous snapshot on failure.
   * @returns completion of the review, provider, policy and completed-work reads.
   */
  async refreshLearning(): Promise<void> {
    if (this.disposed) return
    if (this.learningPending !== undefined) return this.learningPending
    this.patchLearning({ ...this.source.getSnapshot().learning.status === 'idle' ? { status: 'loading' } : {}, error: false })
    this.learningPending = (async () => {
      try {
        const [reviews, providers, evidence] = await Promise.all([
          valueOf(this.api.listProposals({})), valueOf(this.api.learningStatus({})), valueOf(this.api.listLearningEvidence({})),
        ])
        this.patchLearning({ reviews, providers, evidence, status: 'ready', error: false })
      } catch (_learningReadFailure) {
        this.patchLearning({ error: true, ...this.source.getSnapshot().learning.status === 'loading' ? { status: 'error' } : {} })
      }
    })().finally(() => { this.learningPending = undefined })
    return this.learningPending
  }

  /**
   * Read the selected proposal and ignore results from older selections.
   * @param id - selected immutable proposal.
   * @returns completion of its lazy detail read.
   */
  async loadReview(id: SkillLearningProposalId): Promise<void> {
    const generation = ++this.reviewGeneration
    this.patchLearning({ detailId: id, detail: null, detailStatus: 'loading' })
    try {
      const detail = await valueOf(this.api.detailProposal({ proposalId: id }))
      if (generation === this.reviewGeneration) this.patchLearning({ detail, detailStatus: 'ready' })
    } catch (_reviewReadFailure) {
      if (generation === this.reviewGeneration) this.patchLearning({ detailStatus: 'error' })
    }
  }

  /**
   * Generate a durable suggestion for review without applying source changes.
   * @param request - selected completed observations and bounded operation.
   * @returns completion of suggestion generation and metadata refresh.
   */
  async proposeLearning(request: SkillLearningProposeRequest): Promise<void> {
    await this.operation(async () => {
      const detail = await valueOf(this.api.proposeLearning(request))
      this.reviewGeneration++
      this.patchLearning({ detail, detailId: detail.id, detailStatus: 'ready' })
    }, 'changed')
  }

  /**
   * Request independent checks for the exact selected proposal.
   * @param id - exact proposal to check independently.
   * @returns completion of its validation report and metadata refresh.
   */
  async validateReview(id: SkillLearningProposalId): Promise<void> {
    await this.reviewOperation(() => valueOf(this.api.validateProposal({ proposalId: id })))
  }

  /**
   * Apply the changes explicitly approved in the review panel.
   * @param id - proposal whose complete changes were shown.
   * @returns completion of reviewed application and metadata refresh.
   */
  async approveReview(id: SkillLearningProposalId): Promise<void> {
    await this.reviewOperation(() => valueOf(this.api.applyProposal({ proposalId: id, mode: 'reviewed' })))
  }

  /**
   * Retain an explicit rejection in the durable proposal history.
   * @param id - selected proposal to retain as rejected.
   * @returns completion of the decision and metadata refresh.
   */
  async rejectReview(id: SkillLearningProposalId): Promise<void> {
    await this.reviewOperation(() => valueOf(this.api.rejectProposal({ proposalId: id })))
  }

  /**
   * Approve a semantic policy separately from consent for individual files.
   * @param request - registered trusted validator and explicit allowed operations.
   * @returns completion of policy approval without enabling files.
   */
  async approvePolicy(request: SkillLearningPolicyRequest): Promise<void> {
    await this.operation(() => valueOf(this.api.approveLearningPolicy(request)), 'changed')
  }

  /**
   * Set explicit semantic consent for the observed skill version.
   * @param item - observed managed source.
   * @param policyId - separately approved policy.
   * @param enabled - requested file consent state.
   * @returns completion of the hash-bound consent update and metadata refresh.
   */
  async setLearningAutomatic(item: SkillLibraryItem, policyId: SkillLearningPolicyId, enabled: boolean): Promise<void> {
    await this.operation(() => valueOf(this.api.setAutomaticLearning({ id: item.id, expectedHash: item.contentHash, policyId, enabled })), 'changed')
  }

  private async reviewOperation(run: () => Promise<SkillLearningProposal>): Promise<void> {
    const generation = this.reviewGeneration
    await this.operation(async () => {
      const detail = await run()
      if (generation === this.reviewGeneration) {
        this.reviewGeneration++
        this.patchLearning({ detail, detailId: detail.id, detailStatus: 'ready' })
      }
    }, 'changed')
  }

  /**
   * Refresh metadata, retaining the last successful inventory on failure.
   * @param forceReload - request a fresh native metadata read for an explicit refresh.
   * @returns completion of the shared in-flight inventory read.
   */
  async refresh(forceReload = false): Promise<void> {
    if (this.disposed) return
    if (this.pending !== undefined) {
      await this.pending
      if (forceReload) return this.refresh(true)
      return
    }
    this.patch({ ...this.source.getSnapshot().inventory === null ? { status: 'loading' } : {}, readError: false })
    this.pending = this.readInventory(forceReload).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async readInventory(forceReload: boolean): Promise<void> {
    try {
      const inventory = await valueOf(this.api.list(forceReload ? { forceReload: true } : {}))
      this.patch({ inventory, status: 'ready', readError: false })
    } catch (_readFailure) {
      this.patch({ readError: true, ...this.source.getSnapshot().inventory === null ? { status: 'error' } : {} })
    }
  }

  /**
   * Read only the selected skill body; late results from old selections are ignored.
   * @param id - exact provider/path identity.
   * @returns completion of this detail read.
   */
  async loadDetail(id: SkillLibraryId): Promise<void> {
    const generation = ++this.detailGeneration
    this.patch({ detailId: id, detail: null, detailStatus: 'loading' })
    try {
      const detail = await valueOf(this.api.detail({ id }))
      if (generation === this.detailGeneration) this.patch({ detail, detailStatus: 'ready' })
    } catch (_detailFailure) {
      if (generation === this.detailGeneration) this.patch({ detailStatus: 'error' })
    }
  }

  /**
   * Request one explicitly selected metadata or archive action.
   * @param action - selected lifecycle operation.
   * @param item - observed item, including its concurrency hash.
   * @returns completion of the operation and refreshed inventory.
   */
  async act(action: LibraryAction, item: SkillLibraryItem): Promise<void> {
    const hash = { id: item.id, expectedHash: item.contentHash }
    await this.operation(async () => {
      switch (action) {
        case 'pin': return valueOf(this.api.setPinned({ id: item.id, pinned: true }))
        case 'unpin': return valueOf(this.api.setPinned({ id: item.id, pinned: false }))
        case 'adopt': return valueOf(this.api.adopt(hash))
        case 'archive': return valueOf(this.api.archive(hash))
        case 'restore': return valueOf(this.api.restore({ id: item.id }))
        case 'automaticOn': return valueOf(this.api.setAutomaticCleanup({ ...hash, enabled: true }))
        case 'automaticOff': return valueOf(this.api.setAutomaticCleanup({ ...hash, enabled: false }))
      }
    }, action === 'restore' ? 'restored' : 'changed')
  }

  /**
   * Open a conservative proposal without applying any source changes.
   * @param ids - selected candidates; omitted for all eligible managed skills.
   * @returns completion of the preview request.
   */
  async preview(ids?: readonly SkillLibraryId[]): Promise<void> {
    if (this.source.getSnapshot().busy) return
    const generation = ++this.previewGeneration
    this.patch({ cleanupOpen: true, previewLoading: true, previewError: false, proposal: null })
    try {
      const proposal = await valueOf(this.api.previewCleanup(ids === undefined ? {} : { ids }))
      if (generation === this.previewGeneration) this.patch({ proposal, previewLoading: false })
    } catch (_previewFailure) {
      if (generation === this.previewGeneration) this.patch({ previewLoading: false, previewError: true })
    }
  }

  /** Discard a preview; application in progress retains its dialog. */
  closePreview(): void {
    if (this.source.getSnapshot().busy) return
    this.previewGeneration++
    this.patch({ cleanupOpen: false, proposal: null, previewLoading: false })
  }

  /**
   * Apply only the currently displayed proposal; the Host validates source hashes.
   * @returns completion of the applied operation and inventory refresh.
   */
  async applyPreview(): Promise<void> {
    const proposal = this.source.getSnapshot().proposal
    if (proposal === null) return
    await this.operation(async () => {
      await valueOf(this.api.applyCleanup({ proposalId: proposal.id }))
      this.patch({ cleanupOpen: false, proposal: null })
    }, 'cleanupApplied')
  }

  /**
   * Restore a historical instruction version under the current source hash.
   * @param item - observed source and concurrency hash.
   * @param revisionId - selected retained revision.
   * @returns completion of the restore and refreshed detail.
   */
  async rollback(item: SkillLibraryItem, revisionId: SkillRevisionId): Promise<void> {
    await this.operation(() => valueOf(this.api.rollback({ id: item.id, expectedHash: item.contentHash, revisionId })), 'restored')
  }

  private async operation(run: () => Promise<unknown>, kind: LibraryNotice['kind']): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy) return
    this.patch({ busy: true })
    try {
      await run()
      if (this.pending !== undefined) await this.pending
      await this.refresh()
      if (this.learningPending !== undefined) await this.learningPending
      await this.refreshLearning()
      const id = this.source.getSnapshot().detailId
      if (id !== null) await this.loadDetail(id)
      this.notice(kind)
    } catch (_operationFailure) {
      this.notice('actionError')
    } finally {
      this.patch({ busy: false })
    }
  }

  private notice(kind: LibraryNotice['kind']): void { this.patch({ notice: { kind, seq: ++this.noticeSequence } }) }
  private patchLearning(update: Partial<SkillLearningUiState>): void {
    this.patch({ learning: { ...this.source.getSnapshot().learning, ...update } })
  }
  private patch(update: Partial<SkillLibraryState>): void {
    if (!this.disposed) this.source.set({ ...this.source.getSnapshot(), ...update })
  }
}
