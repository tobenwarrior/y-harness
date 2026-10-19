/**
 * Fork isolation: give a forked conversation its own git worktree instead of
 * sharing the source checkout (clean-room behavior spec: ChatGPT desktop's
 * "Fork chat in new worktree"). Two forks editing one working directory
 * corrupt each other; a worktree gives each fork its own files and branch on
 * the same repository history.
 *
 * Design follows the workspace-changes git layer: an injected {@link GitRunner}
 * owns process lifetime, every command takes an AbortSignal, and a nonzero
 * exit is an expected OUTCOME kind rather than an exception. Only programming
 * errors (a malformed request) throw.
 */
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitRunner } from './git.ts'

/** Longest generated branch segment; keeps refs readable and filesystem-safe. */
const MAX_SLUG_CHARS = 48

/** Retained stderr tail for diagnostics, matching the git layer's budget. */
const STDERR_TAIL_BYTES = 2_000

/** Why a worktree could not be created. */
export type WorktreeRefusalReason =
  /** The source directory is not inside a git repository. */
  | 'not-a-repository'
  /** The caller-supplied label has no usable characters. */
  | 'invalid-label'
  /** A checkout already exists at the computed path or the branch is taken. */
  | 'already-exists'
  /** The target directory could not be created or removed. */
  | 'filesystem'

/** A request to isolate one fork in its own worktree. */
export interface WorktreeRequest {
  /** Working directory inside the source repository (the fork's origin). */
  readonly sourceDir: string
  /** Caller-chosen label, usually the conversation title; sanitized into a slug. */
  readonly label: string
  /** Parent directory for created worktrees; each fork gets one child directory. */
  readonly worktreesRoot: string
  /** Commit-ish to branch from; defaults to the source's current HEAD. */
  readonly startPoint?: string | undefined
  /** Unique suffix disambiguating same-labeled forks (e.g. a short session id). */
  readonly suffix?: string | undefined
  readonly signal: AbortSignal
}

/** Result of one fork-isolation attempt. */
export type WorktreeOutcome =
  | {
    readonly kind: 'created'
    /** Absolute path of the new checkout, usable as the fork's working directory. */
    readonly path: string
    /** Branch checked out in the new worktree. */
    readonly branch: string
    /** Repository top level the worktree shares. */
    readonly repositoryRoot: string
    /** Commit the branch starts from. */
    readonly baseCommit: string
  }
  | { readonly kind: 'refused'; readonly reason: WorktreeRefusalReason; readonly detail: string }
  | {
    readonly kind: 'failed'
    /** Which git step failed, for diagnosis. */
    readonly stage: 'rev-parse' | 'head' | 'worktree-add'
    readonly exitCode: number | null
    readonly stderr: string
  }

/**
 * Reduce a human label to a git-ref- and filesystem-safe slug.
 * @param label - arbitrary caller text.
 * @returns lowercase `[a-z0-9-]` slug, or '' when nothing usable remains.
 */
export function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/u, '')
  return slug
}

/** Keep the last `bytes` of a diagnostic string without splitting a surrogate pair. */
function tail(text: string, bytes = STDERR_TAIL_BYTES): string {
  if (text.length <= bytes) return text.trim()
  return `…${text.slice(text.length - bytes)}`.trim()
}

/**
 * Create an isolated worktree for one fork.
 *
 * The branch name and directory are derived from the label plus an optional
 * suffix, so same-labeled forks never collide. Cleanup is attempted when
 * `git worktree add` fails after the branch was created, so a failed attempt
 * leaves neither a stale directory nor a dangling branch.
 *
 * @param git - command runner (owns the git child process).
 * @param request - source, label, destination root, and cancellation.
 * @returns the created checkout, a refusal, or a git failure.
 */
export async function createForkWorktree(
  git: GitRunner,
  request: WorktreeRequest,
): Promise<WorktreeOutcome> {
  const source = resolve(request.sourceDir)
  const root = resolve(request.worktreesRoot)

  const slug = slugifyLabel(request.label)
  if (slug === '') {
    return { kind: 'refused', reason: 'invalid-label', detail: request.label }
  }

  const located = await git.run(
    ['rev-parse', '--show-toplevel'],
    { cwd: source, signal: request.signal },
  )
  if (located.exitCode !== 0) {
    if (/not a git repository/i.test(located.stderr)) {
      return {
        kind: 'refused',
        reason: 'not-a-repository',
        detail: source,
      }
    }
    return {
      kind: 'failed',
      stage: 'rev-parse',
      exitCode: located.exitCode,
      stderr: tail(located.stderr),
    }
  }
  const repositoryRoot = resolve(source, located.stdout.trim())

  const head = await git.run(
    ['rev-parse', 'HEAD'],
    { cwd: repositoryRoot, signal: request.signal },
  )
  if (head.exitCode !== 0) {
    // A repository with no commits cannot host a branch yet; that is a
    // refusal with a clear reason rather than a git failure.
    return {
      kind: 'refused',
      reason: 'not-a-repository',
      detail: `no HEAD commit in ${repositoryRoot}: ${tail(head.stderr)}`,
    }
  }
  const baseCommit = head.stdout.trim()
  const startPoint = request.startPoint ?? baseCommit

  const suffix = request.suffix === undefined || request.suffix === ''
    ? ''
    : `-${slugifyLabel(request.suffix).slice(0, 12)}`
  const branch = `dsh/fork/${slug}${suffix}`
  const path = join(root, `${slug}${suffix}`)

  // An existing path or branch means this fork was already materialized, or a
  // previous attempt leaked; report it instead of overwriting either.
  const existing = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repositoryRoot, signal: request.signal },
  )
  if (existing.exitCode === 0) {
    return { kind: 'refused', reason: 'already-exists', detail: branch }
  }

  try {
    await mkdir(root, { recursive: true })
  } catch (error) {
    return {
      kind: 'refused',
      reason: 'filesystem',
      detail: `cannot create ${root}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const added = await git.run(
    ['worktree', 'add', '-b', branch, path, startPoint],
    { cwd: repositoryRoot, signal: request.signal },
  )
  if (added.exitCode !== 0) {
    // Best-effort: drop a partial directory so a retry starts clean.
    await rm(path, { recursive: true, force: true }).catch(() => {})
    return {
      kind: 'failed',
      stage: 'worktree-add',
      exitCode: added.exitCode,
      stderr: tail(added.stderr),
    }
  }

  return { kind: 'created', path, branch, repositoryRoot, baseCommit }
}

/** Result of removing a fork's worktree. */
export type WorktreeRemoval =
  | { readonly kind: 'removed' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly exitCode: number | null; readonly stderr: string }

/**
 * Remove one fork's worktree and its branch, leaving the shared repository
 * history untouched. Uncommitted work in the checkout is discarded, so callers
 * must only invoke this for a fork they own and are disposing.
 *
 * @param git - command runner.
 * @param repositoryRoot - the shared repository top level.
 * @param path - the worktree directory to remove.
 * @param branch - branch created with the worktree; omitted leaves the ref.
 * @param signal - cancellation.
 */
export async function removeForkWorktree(
  git: GitRunner,
  repositoryRoot: string,
  path: string,
  branch: string | undefined,
  signal: AbortSignal,
): Promise<WorktreeRemoval> {
  if (!isAbsolute(path)) {
    throw new Error('removeForkWorktree requires an absolute worktree path')
  }
  const removed = await git.run(
    ['worktree', 'remove', '--force', path],
    { cwd: repositoryRoot, signal },
  )
  if (removed.exitCode !== 0) {
    if (/is not a working tree|no such file or directory/i.test(removed.stderr)) {
      // The directory is already gone; prune the administrative entry and
      // still drop the branch so the fork leaves nothing behind.
      await git.run(['worktree', 'prune'], { cwd: repositoryRoot, signal }).catch(() => undefined)
      if (branch !== undefined) {
        await git.run(['branch', '-D', branch], { cwd: repositoryRoot, signal }).catch(() => undefined)
      }
      return { kind: 'missing' }
    }
    return { kind: 'failed', exitCode: removed.exitCode, stderr: tail(removed.stderr) }
  }
  if (branch !== undefined) {
    // A branch checked out by another worktree refuses deletion; that is the
    // repository protecting live state, so a failure here is not fatal.
    await git.run(['branch', '-D', branch], { cwd: repositoryRoot, signal }).catch(() => undefined)
  }
  return { kind: 'removed' }
}

/**
 * Whether a directory can host a fork worktree: it must sit inside a git
 * repository with at least one commit. Used to decide whether to offer the
 * "fork in new worktree" affordance at all.
 *
 * @param git - command runner.
 * @param cwd - candidate working directory.
 * @param signal - cancellation.
 * @returns true when a worktree fork is possible.
 */
export async function canForkIntoWorktree(
  git: GitRunner,
  cwd: string,
  signal: AbortSignal,
): Promise<boolean> {
  const located = await git.run(
    ['rev-parse', '--show-toplevel'],
    { cwd, signal },
  ).catch(() => null)
  if (located === null || located.exitCode !== 0) return false
  const head = await git.run(
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    { cwd, signal },
  ).catch(() => null)
  return head !== null && head.exitCode === 0
}
