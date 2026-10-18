/**
 * Types for the scoped upstream sync tool. The implementation is a plain module because
 * CI runs it without a compile step; these declarations let the repository's typecheck and
 * spec suite use it.
 */

/** Manifest sections a prerequisite merge may update. */
export const MANIFEST_DEPENDENCY_FIELDS: readonly string[]

/** One dependency entry the merge changed. */
export interface ManifestChange {
  /** Manifest section holding the entry. */
  field: string
  /** Package name of the entry. */
  name: string
  /** Range this fork declared before the merge, or undefined for a new entry. */
  from: string | undefined
  /** Range upstream declares at the target revision. */
  to: string
}

/** One dependency entry this merge leaves alone because upstream's range is lower. */
export interface ManifestSkipped {
  /** Manifest section holding the entry. */
  field: string
  /** Package name of the entry. */
  name: string
  /** Range this fork keeps. */
  from: string
  /** Lower range upstream declares. */
  to: string
}

/** One dependency entry this fork keeps although upstream no longer lists it. */
export interface ManifestKept {
  /** Manifest section holding the entry. */
  field: string
  /** Package name of the entry. */
  name: string
  /** Range this fork keeps. */
  spec: string
}

/** Outcome of merging upstream's dependency entries into one manifest. */
export interface ManifestMerge {
  /** The manifest to write. */
  merged: Record<string, unknown>
  /** Entries added or re-ranged by the merge. */
  changes: ManifestChange[]
  /** Entries kept as they are because upstream's range is lower. */
  skipped: ManifestSkipped[]
  /** Entries only this fork declares. */
  kept: ManifestKept[]
  /** Top-level fields that differ upstream and that this merge deliberately does not apply. */
  untouchedFields: string[]
}

/**
 * Select the files that match a prerequisite pattern and no exclusion.
 * @param changedPaths Repository-relative paths changed between the two revisions.
 * @param patterns Glob patterns of the declared prerequisite files.
 * @param excludeMatchers Matchers that must never be selected.
 * @returns The selected paths, in the order given.
 */
export function selectPrerequisites(
  changedPaths: readonly string[],
  patterns: readonly string[],
  excludeMatchers?: readonly RegExp[],
): string[]

/**
 * Whether accepting an upstream range would move a dependency backwards.
 * @param theirs Upstream's declared range.
 * @param ours This fork's declared range.
 * @returns True when both name a concrete version and upstream's is lower.
 */
export function movesBackwards(theirs: unknown, ours: unknown): boolean

/**
 * Merge upstream dependency entries into this fork's manifest.
 * @param ours This fork's manifest object.
 * @param theirs Upstream's manifest object at the target revision, or undefined when unreadable.
 * @param fields Dependency sections to merge.
 * @returns The merged manifest, what it changed, what it kept, and what it left alone.
 */
export function mergeManifestFields(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown> | undefined,
  fields?: readonly string[],
): ManifestMerge

/**
 * Remove the incremental build state that caches module resolution.
 * @param repoRoot Repository root.
 * @returns The removed cache paths, repository-relative with `/` separators.
 */
export function clearBuildStateCaches(repoRoot: string): string[]
