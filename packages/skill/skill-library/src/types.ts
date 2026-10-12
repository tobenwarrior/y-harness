/** Browser-safe skill library inventory, revision and provider vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable provider/path identity, independent of a skill's display name. */
export type SkillLibraryId = Branded<'SkillLibraryId'>
/** Identity of an in-memory cleanup preview. */
export type SkillCleanupProposalId = Branded<'SkillCleanupProposalId'>
/** Identity of one durable instruction revision. */
export type SkillRevisionId = Branded<'SkillRevisionId'>

/** Registered project grouping. */
export interface SkillLibraryProject {
  readonly id: string
  readonly title: string
  readonly path: string
}
/** Explicit relationship extracted from skill metadata or Markdown links. */
export interface SkillLibraryReference {
  readonly target: string
  readonly kind: 'skill' | 'file' | 'url'
  readonly resolvedId?: SkillLibraryId | undefined
}
/** Reliable recorded loads never imply verified successful application. */
export interface SkillLibraryUsage {
  readonly coverage: 'unknown' | 'recorded-loads'
  readonly loadCount: number
  readonly lastLoadedAt?: string | undefined
}
/** Metadata only; instruction text is loaded separately. */
export interface SkillLibraryItem {
  readonly id: SkillLibraryId
  readonly name: string
  readonly description: string
  readonly provider: string
  readonly source: string
  readonly path: string
  readonly scope: 'project' | 'shared'
  readonly projectIds: readonly string[]
  readonly ownership: 'protected' | 'y-managed' | 'vendor'
  readonly status: 'active' | 'disabled' | 'archived'
  readonly shadowed: boolean
  readonly pinned: boolean
  readonly automaticCleanup: boolean
  readonly invocation: {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }
  readonly contentHash: string
  readonly bodyBytes: number
  readonly usage: SkillLibraryUsage
  readonly references: readonly SkillLibraryReference[]
  readonly capabilities: {
    readonly adopt: boolean
    readonly archive: boolean
    readonly restore: boolean
    readonly cleanup: boolean
    readonly native: boolean
  }
}
/** Historical instruction version with a restorable source snapshot. */
export interface SkillLibraryRevision {
  readonly id: SkillRevisionId
  readonly createdAt: string
  readonly reason: 'cleanup' | 'rollback' | 'learning'
  readonly beforeHash: string
  readonly afterHash: string
  readonly beforeBytes: number
  readonly afterBytes: number
}
/** Lazy full instruction view. */
export interface SkillLibraryDetail {
  readonly item: SkillLibraryItem
  readonly content: string
  readonly revisions: readonly SkillLibraryRevision[]
}
/** Provider availability does not imply usage telemetry coverage. */
export interface SkillLibraryProviderStatus {
  readonly provider: string
  readonly state: 'connected' | 'disconnected' | 'unsupported' | 'unavailable'
  readonly message?: string
}
/** Complete metadata inventory. */
export interface SkillLibraryList {
  readonly items: readonly SkillLibraryItem[]
  readonly projects: readonly SkillLibraryProject[]
  readonly providers: readonly SkillLibraryProviderStatus[]
  readonly bodyBudgetBytes: number
}
/** Per-item conservative compression proposal, preserving YAML and code blocks. */
export interface SkillCleanupChange {
  readonly id: SkillLibraryId
  readonly name: string
  readonly expectedHash: string
  readonly before: string
  readonly after: string
  readonly beforeBytes: number
  readonly afterBytes: number
  readonly overBudget: boolean
}
/** A preview requires explicit application; skipped entries include protected skills. */
export interface SkillCleanupProposal {
  readonly id: SkillCleanupProposalId
  readonly changes: readonly SkillCleanupChange[]
  readonly skipped: readonly {
    readonly id: SkillLibraryId
    readonly reason: string
  }[]
  readonly createdAt: string
}
/** Native adapter entry; existing native skills remain protected and read-only. */
export interface NativeSkillLibraryEntry {
  readonly path: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly projectIds: readonly string[]
  readonly enabled: boolean
  readonly userInvocable?: boolean
  readonly references?: readonly SkillLibraryReference[]
}
/** Already-connected native provider observation. */
export interface NativeSkillLibraryObservation {
  readonly entries: readonly NativeSkillLibraryEntry[]
  readonly status: SkillLibraryProviderStatus
}
/** Native providers must not start processes or request authorization during discovery. */
export interface NativeSkillLibraryProvider {
  readonly name: string
  /**
   * @param projects - registered project directories.
   * @param request - optional explicit native refresh.
   * @returns metadata and provider availability, without starting a process.
   */
  list(
    projects: readonly SkillLibraryProject[],
    request?: { readonly forceReload?: boolean }): Promise<NativeSkillLibraryObservation>
  /**
   * @param path - previously discovered instruction locator.
   * @returns individually requested instructions.
   */
  detail?(path: string): Promise<string>
}
/** Individually selected id. */
export interface SkillLibraryIdRequest { readonly id: SkillLibraryId }
/** Hash admission protects a preview against changed source instructions. */
export interface SkillLibraryHashRequest extends SkillLibraryIdRequest { readonly expectedHash: string }
/** Pin mutation. */
export interface SkillLibraryPinRequest extends SkillLibraryIdRequest { readonly pinned: boolean }
/** Explicit opt-in is separate from adoption and disabled initially. */
export interface SkillLibraryAutomaticRequest extends SkillLibraryHashRequest { readonly enabled: boolean }
/** Current-project filtering; shared skills remain available. */
export interface SkillLibraryListRequest {
  readonly projectId?: string
  readonly forceReload?: boolean
}
/** Selected conservative cleanup candidates, or every eligible managed entry. */
export interface SkillLibraryCleanupRequest { readonly ids?: readonly SkillLibraryId[] }
/** Apply a preview generated by this running service. */
export interface SkillLibraryApplyRequest { readonly proposalId: SkillCleanupProposalId }
/** Restore previous instructions without changing archive state. */
export interface SkillLibraryRollbackRequest extends SkillLibraryHashRequest { readonly revisionId: SkillRevisionId }
/** Returned item after a metadata or source mutation. */
export interface SkillLibraryItemValue { readonly item: SkillLibraryItem }
/** Revision results after an applied preview. */
export interface SkillLibraryApplyValue { readonly revised: readonly SkillLibraryId[] }
/** Bounded metadata selection before any instruction body reads. */
export interface SkillLibraryRetrieveRequest {
  readonly projectId?: string
  readonly query: string
  readonly explicitIds?: readonly SkillLibraryId[]
  readonly limit?: number
}

export type * from './learning-types.ts'
export type * from './decision-types.ts'
