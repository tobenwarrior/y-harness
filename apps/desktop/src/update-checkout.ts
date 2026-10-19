import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Checkout update detection for the fork's development build.
 *
 * The daily app runs from a checkout, so "an update" is a new commit: the
 * build stamp records the commit that was compiled, and a newer HEAD means the
 * running process is behind. `.local-setup/update-on-quit.py` already owns the
 * rebuild and relaunch, but it only acts when the app EXITS — so without a
 * visible affordance the user has to know to quit, which is not a workflow.
 *
 * This module answers only "is the running build behind the checkout?". The
 * caller decides what to show and what the action does.
 *
 * Both inputs are injected so the decision is unit-testable and so no spawn
 * policy lives here.
 */

/** A checkout state comparison for one running build. */
export interface CheckoutUpdateState {
  /** Commit the running build was compiled from (the stamp). */
  readonly builtCommit: string
  /** Commit currently checked out. */
  readonly headCommit: string
  /** True when HEAD moved past the built commit. */
  readonly available: boolean
  /** Short HEAD spelling for display. */
  readonly shortHead: string
}

/** Bounded git fact the detector needs; a nonzero exit is data, not a throw. */
export interface GitProbeResult {
  readonly exitCode: number | null
  readonly stdout: string
}

/** Injected environment; the detector performs no I/O of its own. */
export interface CheckoutUpdateProbe {
  /** Read the build stamp's recorded commit, or null when absent/unreadable. */
  readStampCommit(): Promise<string | null>
  /** Resolve the checkout's current HEAD commit. */
  readHeadCommit(): Promise<GitProbeResult>
}

/** Trim and validate one commit spelling; anything unusable becomes null. */
function normalizeCommit(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  // git prints a full object id; a stamp written by the fork does too. Anything
  // shorter or non-hex is not a commit we can compare, so it stays unknown.
  return /^[0-9a-f]{7,64}$/iu.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * Compare the running build's stamped commit with the checkout's HEAD.
 *
 * A missing stamp or an unreadable HEAD yields null: unknown is not "up to
 * date", and reporting an update that cannot be applied would be a lie.
 *
 * @param probe - injected stamp and git readers.
 * @returns the comparison, or null when either side is unknown.
 */
export async function detectCheckoutUpdate(
  probe: CheckoutUpdateProbe,
): Promise<CheckoutUpdateState | null> {
  const [stampRaw, head] = await Promise.all([
    probe.readStampCommit().catch(() => null),
    probe.readHeadCommit().catch(() => ({ exitCode: 1, stdout: '' })),
  ])
  if (head.exitCode !== 0) return null
  const builtCommit = normalizeCommit(stampRaw)
  const headCommit = normalizeCommit(head.stdout)
  if (builtCommit === null || headCommit === null) return null
  return {
    builtCommit,
    headCommit,
    available: builtCommit !== headCommit,
    shortHead: headCommit.slice(0, 12),
  }
}

/**
 * Whether a checkout update can be applied by this process at all. The rebuild
 * is owned by the fork's watcher, which acts when the app exits, so applying an
 * update means quitting — never building in-process, which would rewrite the
 * files the running app is executing.
 * @param state - the detected comparison.
 */
export function isCheckoutUpdateActionable(state: CheckoutUpdateState | null): boolean {
  return state !== null && state.available
}

/** The fork's build stamp, relative to the checkout root. */
const STAMP_RELATIVE_PATH = '.local-setup/update-stamp.json'

/** Stop walking after this many parents; a checkout is never deeper. */
const MAX_PARENT_WALK = 8

/**
 * Find the checkout that owns the fork's build stamp by walking up from a
 * starting directory. The running app lives inside the checkout, so this is
 * robust to where it was launched from, unlike `process.cwd()`.
 *
 * @param start - absolute directory to begin at (usually the app path).
 * @returns the checkout root, or null when no stamp exists above it.
 */
export async function findCheckoutRoot(start: string): Promise<string | null> {
  let current = start
  for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
    const candidate = join(current, STAMP_RELATIVE_PATH)
    try {
      await readFile(candidate, 'utf8')
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  return null
}

/**
 * Build the production probe for one checkout: the stamp's recorded commit and
 * the checkout's current HEAD.
 *
 * `git` is resolved from PATH and bounded by a timeout; every failure (missing
 * binary, not a repository, slow disk) surfaces as an unavailable probe rather
 * than an exception, because "unknown" is a legitimate answer here.
 *
 * @param checkoutRoot - absolute checkout root holding the stamp.
 * @param runGit - injectable runner, replaced at the test boundary.
 */
export function createCheckoutProbe(
  checkoutRoot: string,
  runGit: (args: readonly string[]) => Promise<GitProbeResult> = async (args) => {
    try {
      const { stdout } = await promisify(execFile)('git', [...args], {
        cwd: checkoutRoot,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      })
      return { exitCode: 0, stdout }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return { exitCode: typeof code === 'number' ? code : 1, stdout: '' }
    }
  },
): CheckoutUpdateProbe {
  return {
    readStampCommit: async () => {
      const raw = await readFile(join(checkoutRoot, STAMP_RELATIVE_PATH), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return null
      const commit = (parsed as { commit?: unknown }).commit
      return typeof commit === 'string' ? commit : null
    },
    readHeadCommit: () => runGit(['rev-parse', 'HEAD']),
  }
}
