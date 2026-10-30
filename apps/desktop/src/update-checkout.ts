import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Checkout update detection for the fork's development build.
 *
 * A legacy launcher can compare its build stamp with local HEAD. The managed
 * GitHub launcher publishes a separate status only after a newer commit has
 * been built in an isolated directory. The launcher owns activation after exit;
 * this module only reports whether a prepared target differs from the running build.
 */

/** A checkout state comparison for one running build. */
export interface CheckoutUpdateState {
  /** Commit the running build was compiled from (the stamp). */
  readonly builtCommit: string
  /** Local or prepared target commit. */
  readonly headCommit: string
  /** Whether the target differs from the running build. */
  readonly available: boolean
  /** Short target spelling for display. */
  readonly shortHead: string
  /** Whether this comparison came from the GitHub-managed supervisor. */
  readonly managed?: boolean
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
 * Whether the launcher has an update to offer after the app exits.
 * @param state - The detected comparison.
 * @returns Whether a different target is available.
 */
export function isCheckoutUpdateActionable(state: CheckoutUpdateState | null): boolean {
  return state !== null && state.available
}

/**
 * Persist a one-shot request for the managed launcher to activate a checked update after exit.
 * @param state - The verified managed update currently shown to the user.
 * @param env - Environment supplied by the managed launcher.
 * @returns Whether a restart request was written; unmanaged or unavailable states are ignored.
 */
export async function requestManagedGithubRestart(
  state: CheckoutUpdateState | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const statusPath = env.DSH_DESKTOP_GITHUB_STATUS
  const path = env.DSH_DESKTOP_GITHUB_RESTART
    ?? (statusPath === undefined ? undefined : join(dirname(statusPath), 'restart-request.json'))
  const builtCommit = env.DSH_DESKTOP_GITHUB_BUILD_COMMIT?.toLowerCase()
  if (env.DSH_DESKTOP_GITHUB_MANAGED !== '1' || path === undefined || !isAbsolute(path)
    || state?.managed !== true || !state.available || builtCommit === undefined
    || !/^[0-9a-f]{40}$/u.test(builtCommit) || state.builtCommit !== builtCommit
    || !/^[0-9a-f]{40}$/u.test(state.headCommit)) return false

  const temporary = join(dirname(path), `.restart-request-${randomUUID()}`)
  const body = `${JSON.stringify({ phase: 'requested', buildCommit: builtCommit, targetCommit: state.headCommit })}\n`
  try {
    await writeFile(temporary, body, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
    return true
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
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

/**
 * Read a bounded supervisor status without following a final symlink.
 * @param env - Environment supplied by the managed launcher.
 * @returns A prepared update comparison, or null when the status is unavailable.
 */
export async function detectManagedGithubUpdate(env: NodeJS.ProcessEnv = process.env): Promise<CheckoutUpdateState | null> {
  const path = env.DSH_DESKTOP_GITHUB_STATUS
  const builtCommit = env.DSH_DESKTOP_GITHUB_BUILD_COMMIT
  if (env.DSH_DESKTOP_GITHUB_MANAGED !== '1' || path === undefined || !isAbsolute(path)
    || builtCommit === undefined || !/^[0-9a-f]{40}$/i.test(builtCommit)) return null
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      const limit = 4096
      if (!stat.isFile() || stat.size > limit) return null
      const buffer = Buffer.alloc(limit + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > limit) return null
      const status: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'))
      if (typeof status !== 'object' || status === null) return null
      const { phase, commit } = status as { phase?: unknown; commit?: unknown }
      if ((phase !== 'ready' && phase !== 'active') || typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit)) return null
      const built = builtCommit.toLowerCase()
      const head = commit.toLowerCase()
      // An active status is the supervisor's normal steady state. It must name
      // the running build; a mismatch is stale/unknown rather than actionable.
      if (phase === 'active' && head !== built) return null
      return {
        builtCommit: built,
        headCommit: head,
        available: phase === 'ready' && built !== head,
        shortHead: head.slice(0, 12),
        managed: true,
      }
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}
