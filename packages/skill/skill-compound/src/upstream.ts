/**
 * Upstream release tracking for the vendored Compound skills.
 *
 * The vendored copy in `assets/` is a snapshot: it moves only when this
 * repository updates it. The tracker reads the release upstream publishes,
 * compares it with {@link VENDORED_VERSION}, and reports the difference on a
 * same-origin route the browser half renders as an update indicator.
 *
 * @module @deepseek-ai/dsh-skill-compound
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Release of the vendored content; kept equal to the table in `UPSTREAM.md`. */
export const VENDORED_VERSION = '0.11.1'

/** Upstream repository the vendored content is copied from. */
export const UPSTREAM_REPOSITORY = 'tobenwarrior/compound-skills'

/** Branch whose `plugin.json` carries the current release. */
const UPSTREAM_BRANCH = 'main'

/** Same-origin route the browser half reads update status from. */
export const UPDATE_ROUTE = '/api/skill-compound.update'

/** Same-origin route that applies a released update to the checkout. */
export const APPLY_ROUTE = '/api/skill-compound.update.apply'

/** How long a successful reading stays fresh. */
const FRESH_MS = 6 * 60 * 60 * 1000

/** How long a failed reading suppresses further attempts. */
const RETRY_MS = 15 * 60 * 1000

/** One reading of the upstream release, as the browser half receives it. */
export interface UpdateStatus {
  /** Release currently vendored in this package. */
  readonly vendored: string
  /** Release upstream publishes, when it could be read. */
  readonly upstream: string | null
  /** Whether upstream publishes a later release than the vendored one. */
  readonly updateAvailable: boolean
  /** Upstream repository the comparison was made against. */
  readonly repository: string
  /** When this reading was taken, in epoch milliseconds; null before the first attempt. */
  readonly checkedAt: number | null
  /** Why the upstream release could not be compared, when it could not. */
  readonly error: string | null
}

/** A plain `major.minor.patch` release, which is all upstream publishes. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/u

/**
 * Compare two plain releases.
 * @param left - release to order.
 * @param right - release to order against.
 * @returns a negative, zero, or positive number as `left` orders before, with,
 *   or after `right`; `undefined` when either value is not a plain release.
 */
export function compareReleases(left: string, right: string): number | undefined {
  const leftParts = RELEASE.exec(left)
  const rightParts = RELEASE.exec(right)
  if (leftParts === null || rightParts === null) return undefined
  for (const index of [1, 2, 3]) {
    const difference = Number(leftParts[index]) - Number(rightParts[index])
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Read the release upstream currently publishes.
 * @param signal - cancels the request when the caller goes away.
 * @returns the upstream release.
 * @throws when the request fails, the response is not JSON, or it carries no version.
 */
async function fetchUpstreamRelease(signal?: AbortSignal): Promise<string> {
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${UPSTREAM_BRANCH}/plugin.json`
  const response = await fetch(url, { ...(signal === undefined ? {} : { signal }), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`upstream plugin.json answered HTTP ${response.status}`)
  const payload: unknown = await response.json()
  const version = typeof payload === 'object' && payload !== null && 'version' in payload
    ? (payload as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string') throw new Error('upstream plugin.json carries no version')
  return version
}

/** Reads the upstream release; injectable so tests do not depend on the network. */
export type ReleaseReader = (signal?: AbortSignal) => Promise<string>

/**
 * Cache one process's view of the upstream release.
 *
 * A browser half that polls the route must not turn into a request per poll:
 * a successful reading is reused for {@link FRESH_MS} and a failed one for
 * {@link RETRY_MS}, and the first caller after either window pays for the
 * next attempt.
 */
export class UpstreamReleaseTracker {
  private reading: { status: UpdateStatus; expiresAt: number } | undefined

  /** @param readRelease - upstream reader; defaults to the GitHub raw request. */
  constructor(private readonly readRelease: ReleaseReader = fetchUpstreamRelease) {}

  /**
   * Report the current comparison, reading upstream when the cache expired.
   * @param signal - cancels an upstream read the caller no longer needs.
   * @returns the reading, carrying `error` instead of a comparison when upstream was unreadable.
   */
  async status(signal?: AbortSignal): Promise<UpdateStatus> {
    const now = Date.now()
    if (this.reading !== undefined && this.reading.expiresAt > now) return this.reading.status
    const status = await this.read(signal)
    this.reading = { status, expiresAt: now + (status.error === null ? FRESH_MS : RETRY_MS) }
    return status
  }

  /**
   * Drop the cached reading, so the next status call reads upstream again.
   *
   * An applied update changes the vendored release, and the badge must not keep
   * reporting the comparison taken before it.
   */
  invalidate(): void {
    this.reading = undefined
  }

  private async read(signal?: AbortSignal): Promise<UpdateStatus> {
    const base = { vendored: VENDORED_VERSION, repository: UPSTREAM_REPOSITORY, checkedAt: Date.now() }
    try {
      const upstream = await this.readRelease(signal)
      const order = compareReleases(upstream, VENDORED_VERSION)
      return {
        ...base,
        upstream,
        updateAvailable: order === undefined ? false : order > 0,
        error: order === undefined ? `upstream release "${upstream}" is not a plain major.minor.patch version` : null,
      }
    } catch (error: unknown) {
      return {
        ...base,
        upstream: null,
        updateAvailable: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/** Outcome of one in-app update attempt. */
export interface UpdateApplication {
  /** What the attempt did. */
  readonly status: 'updated' | 'up-to-date' | 'failed' | 'unavailable'
  /** Release the update applied, when it applied one. */
  readonly upstream: string | null
  /** Why the attempt did not apply, when it did not. */
  readonly error: string | null
}

/** Runs the vendoring procedure; injectable so tests neither clone nor commit. */
export type UpdateApplier = () => Promise<UpdateApplication>

/** Repository-relative path of the script that performs the re-sync. */
const VENDOR_SCRIPT = 'scripts/vendor-compound.ts'

/** File the on-quit updater watches for a restart request. */
export const RESTART_REQUEST = '.local-setup/update-request.json'

/**
 * Checkout this package was installed from.
 *
 * `lib/index.js` and `src/index.ts` sit at the same depth, so the fourth parent is the
 * repository root in a source checkout and whatever contains the package in an install.
 */
const CHECKOUT = resolve(import.meta.dirname, '../../../..')

/**
 * Run one process to completion, collecting both streams.
 * @param command - executable to run.
 * @param args - arguments, passed without a shell.
 * @param cwd - working directory.
 * @returns exit code (null when the process could not start) and both streams.
 */
interface ProcessResult {
  /** Exit code, or null when the process could not start. */
  readonly code: number | null
  /** Everything the process wrote to stdout. */
  readonly stdout: string
  /** Everything the process wrote to stderr. */
  readonly stderr: string
}

function runProcess(command: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolveRun) => {
    // The Host may run under Electron, where this makes execPath behave as Node.
    const child = spawn(command, [...args], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: unknown) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: unknown) => { stderr += String(chunk) })
    child.on('error', (error) => { resolveRun({ code: null, stdout, stderr: `${stderr}${error.message}` }) })
    child.on('close', (code) => { resolveRun({ code, stdout, stderr }) })
  })
}

/**
 * Apply the released update by running this repository's vendoring script.
 *
 * The script owns the procedure — clone, mirror, record, test, commit — and reports a
 * JSON line the route returns unchanged. A packaged install has no checkout, so the
 * route reports that in-app updating is unavailable rather than failing obscurely.
 * @param cwd - checkout to update; defaults to the one this package was installed from.
 * @returns the attempt's outcome.
 */
export async function runVendorScript(cwd: string = CHECKOUT): Promise<UpdateApplication> {
  const script = join(cwd, VENDOR_SCRIPT)
  if (!existsSync(script)) {
    return { status: 'unavailable', upstream: null, error: `in-app updating needs a source checkout with ${VENDOR_SCRIPT}` }
  }
  const result = await runProcess(process.execPath, ['--import', 'tsx', script, '--apply'], cwd)
  const line = result.stdout.trim().split('\n').reverse().find(text => text.startsWith('{'))
  let report: { applied?: string; upstream?: unknown; error?: unknown; updateAvailable?: unknown } | undefined
  try {
    report = line === undefined ? undefined : JSON.parse(line) as typeof report
  } catch {
    report = undefined
  }
  if (report === undefined) {
    const reason = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')
    return { status: 'failed', upstream: null, error: reason === '' ? `vendoring exited ${String(result.code)}` : reason }
  }
  const upstream = typeof report.upstream === 'string' ? report.upstream : null
  if (report.applied === 'committed') {
    // The new content needs a rebuild, which cannot happen under a live app: ask the
    // on-quit updater to restart this one, and it applies the build and relaunches.
    const request = join(cwd, RESTART_REQUEST)
    if (existsSync(join(cwd, '.local-setup'))) {
      const payload = { upstream, requestedAt: new Date().toISOString() }
      writeFileSync(request, `${JSON.stringify(payload)}\n`)
    }
    return { status: 'updated', upstream, error: null }
  }
  if (report.updateAvailable === false) return { status: 'up-to-date', upstream, error: null }
  return { status: 'failed', upstream, error: typeof report.error === 'string' ? report.error : 'the update did not commit' }
}

/**
 * Register the update-status route the browser half reads, and the route that applies one.
 * @param ctx - Context carrying the shared API channel.
 * @param tracker - process-wide reading cache.
 * @param apply - update procedure; defaults to this checkout's vendoring script.
 */
export function registerUpdateRoute(ctx: Context, tracker: UpstreamReleaseTracker, apply: UpdateApplier = runVendorScript): void {
  let running: Promise<UpdateApplication> | undefined
  ctx.connection.fetch.register({
    path: UPDATE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => Response.json(await tracker.status(request.signal), { headers: { 'cache-control': 'no-store' } }),
  })
  ctx.connection.fetch.register({
    path: APPLY_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      // One update at a time: a second request must not race the first into the checkout.
      if (running !== undefined) {
        const busy: UpdateApplication = { status: 'failed', upstream: null, error: 'an update is already running' }
        return Response.json(busy, { status: 409, headers: { 'cache-control': 'no-store' } })
      }
      running = (async () => {
        try {
          const outcome = await apply()
          tracker.invalidate()
          return outcome
        } finally {
          running = undefined
        }
      })()
      return Response.json(await running, { headers: { 'cache-control': 'no-store' } })
    },
  })
}
