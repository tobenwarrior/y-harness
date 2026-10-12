/** Separate Decision configuration and explicit preview query state. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { DecisionCapabilities, DecisionConfiguration, DecisionConfigureRequest, DecisionRoute, DecisionStatus, SkillLibraryItem, SkillLibraryList, SkillLibraryRetrieveRequest } from '@deepseek-ai/dsh-skill-library/types'

/** Minimal generated method face used by this separate settings consumer. */
export interface DecisionApi {
  readonly decisionStatus: () => Promise<RemoteResult<DecisionStatus>>
  readonly decisionCapabilities: (route: DecisionRoute) => Promise<RemoteResult<DecisionCapabilities>>
  readonly configureDecision: (request: DecisionConfigureRequest) => Promise<RemoteResult<DecisionConfiguration>>
  readonly retrieve: (request: SkillLibraryRetrieveRequest) => Promise<RemoteResult<readonly SkillLibraryItem[]>>
  readonly list: (request: Record<string, never>) => Promise<RemoteResult<SkillLibraryList>>
}
/** Query results owned outside React; drafts stay local to the form. */
export interface DecisionState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly status: DecisionStatus | null
  readonly projects: SkillLibraryList['projects']
  readonly controls: DecisionCapabilities | null
  readonly controlsKey: string
  /** Changes after metadata refresh even when the persisted route and revision stay the same. */
  readonly capabilityEpoch: number
  readonly busy: boolean
  readonly error: boolean
  readonly preview: readonly { readonly id: string; readonly name: string }[] | null
  readonly notice: 'saved' | 'error' | null
}
/** Framework-made hook and plain callbacks injected into the Models footer. */
export interface DecisionFace {
  readonly hooks: { readonly decision: HostObservable<DecisionState> }
  readonly ensureDecision: () => void
  readonly refreshDecision: () => void
  readonly loadDecisionControls: (route: DecisionRoute) => void
  readonly saveDecision: (enabled: boolean, route?: DecisionRoute) => void
  readonly previewDecision: (projectId: string, query: string) => void
  readonly dismissDecisionNotice: () => void
}
async function valueOf<T>(work: Promise<RemoteResult<T>>): Promise<T> {
  const result = await work
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Owns query generations and revision-based writes; preview is never automatic. */
export class DecisionController {
  /** Stable observable query state consumed through the injected framework hook. */
  readonly source = createSnapshotStore<DecisionState>({ phase: 'idle', status: null, projects: [], controls: null, controlsKey: '', capabilityEpoch: 0, busy: false, error: false, preview: null, notice: null })
  private disposed = false
  private generation = 0
  private controlsGeneration = 0
  /** @param api - separate Host configuration and scoped retrieval methods. */
  constructor(private readonly api: DecisionApi) { }
  /** Read metadata only. @returns settlement; errors retain previous settings. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation; ++this.controlsGeneration
    this.patch({ phase: 'loading', controls: null, controlsKey: '', error: false })
    try {
      const [status, inventory] = await Promise.all([valueOf(this.api.decisionStatus()), valueOf(this.api.list({}))])
      if (!this.isDisposed() && generation === this.generation) this.patch({
        phase: 'ready', status, projects: inventory.projects, capabilityEpoch: this.source.getSnapshot().capabilityEpoch + 1,
      })
    } catch (_error: unknown) { if (!this.isDisposed() && generation === this.generation) this.patch({ phase: 'error', error: true }) }
  }
  /**
   * Load model controls without generation.
   * @param route - selected available API model.
   * @returns query settlement.
   */
  async controls(route: DecisionRoute): Promise<void> {
    if (this.disposed) return
    const generation = ++this.controlsGeneration; this.patch({ controls: null, controlsKey: '', error: false })
    try {
      const controls = await valueOf(this.api.decisionCapabilities(route))
      if (!this.isDisposed() && generation === this.controlsGeneration) {
        this.patch({ controls, controlsKey: JSON.stringify([route.provider, route.model]) })
      }
    } catch (_error: unknown) { if (!this.isDisposed() && generation === this.controlsGeneration) this.patch({ error: true }) }
  }
  /**
   * Save with the displayed revision.
   * @param enabled - explicit opt-in.
   * @param route - exact API selection.
   * @returns save settlement; conflicts retain the draft and require refresh.
   */
  async save(enabled: boolean, route?: DecisionRoute): Promise<void> {
    const state = this.source.getSnapshot(); if (this.disposed || state.busy || state.status === null) return
    this.patch({ busy: true, error: false, notice: null }); ++this.generation
    try {
      const configuration = await valueOf(this.api.configureDecision({
        expectedRevision: state.status.configuration.revision, enabled, ...(route === undefined ? {} : { route }),
      }))
      if (!this.isDisposed()) this.patch({ status: { ...state.status, configuration }, notice: 'saved', preview: null })
    } catch (_error: unknown) { if (!this.isDisposed()) this.patch({ error: true, notice: 'error' }) }
    finally { if (!this.isDisposed()) this.patch({ busy: false }) }
  }
  /**
   * Explicitly preview scoped admitted metadata.
   * @param projectId - registered project.
   * @param query - candidate query.
   * @returns preview settlement.
   */
  async preview(projectId: string, query: string): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy || query.trim() === '' || projectId === '') return
    this.patch({ busy: true, error: false })
    try {
      const result = await valueOf(this.api.retrieve({ projectId, query }))
      if (!this.isDisposed()) this.patch({ preview: result.map(row => ({ id: row.id, name: row.name })) })
    } catch (_error: unknown) { if (!this.isDisposed()) this.patch({ error: true, notice: 'error' }) }
    finally { if (!this.isDisposed()) this.patch({ busy: false }) }
  }
  /**
   * Bind callbacks and the sole observable.
   * @returns footer inject face.
   */
  face(): DecisionFace {
    return {
      hooks: { decision: this.source },
      ensureDecision: () => { if (this.source.getSnapshot().phase === 'idle') void this.refresh() },
      refreshDecision: () => { void this.refresh() },
      loadDecisionControls: (route) => { void this.controls(route) },
      saveDecision: (enabled, route) => { void this.save(enabled, route) },
      previewDecision: (project, query) => { void this.preview(project, query) },
      dismissDecisionNotice: () => { this.patch({ notice: null }) },
    }
  }
  private isDisposed(): boolean { return this.disposed }
  private patch(value: Partial<DecisionState>): void { this.source.set({ ...this.source.getSnapshot(), ...value }) }
  /** Suppress late query/write echoes after the owning plugin unloads. */
  dispose(): void { this.disposed = true; ++this.generation; ++this.controlsGeneration }
}
