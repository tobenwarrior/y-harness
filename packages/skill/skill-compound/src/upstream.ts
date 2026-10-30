/**
 * Upstream release tracking for the vendored Compound skills.
 *
 * The vendored copy in `assets/` is a snapshot: it moves only when this
 * repository updates it. The tracker reads the release upstream publishes,
 * compares it with {@link VENDORED_VERSION}, and reports the difference on a
 * same-origin route the browser half renders as an update indicator.
 *
 * @module @yharness/skill-compound
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@yharness/cordis'
import { activeOverlay, overlayRoot, updateOverlay, type OverlayRevision } from './overlay.ts'
import { resolveUpstreamCommit, UPSTREAM_REPOSITORY as RESOLVER_REPOSITORY } from './upstream-head.ts'
export { resolveUpstreamCommit } from './upstream-head.ts'

/** Release of the vendored content; kept equal to the table in `UPSTREAM.md`. */
export const VENDORED_VERSION = '0.11.1'

/** Upstream repository the vendored content is copied from. */
export const UPSTREAM_REPOSITORY = RESOLVER_REPOSITORY

/** Branch whose `plugin.json` carries the current release. */

/** Same-origin route the browser half reads update status from. */
export const UPDATE_ROUTE = '/api/skill-compound.update'

/** Same-origin route that applies a released update to the checkout. */
export const APPLY_ROUTE = '/api/skill-compound.update.apply'

/** How long a successful reading stays fresh. */
const FRESH_MS = 6 * 60 * 60 * 1000

/** How long a failed reading suppresses further attempts. */
const RETRY_MS = 15 * 60 * 1000
const UPSTREAM_REQUEST_TIMEOUT_MS = 30_000

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

/** Parse the commit recorded alongside the vendored snapshot. */
export function recordedCommit(source: string): string {
  const commit = source.match(/^\| Vendored commit \| `([a-f0-9]{40})`/m)?.[1]
  if (commit === undefined) throw new Error('UPSTREAM.md carries no valid vendored commit')
  return commit
}

/** Whether the upstream snapshot is newer or has changed at the same version. */
export function hasUpdate(release: string, vendored: string, commit: string, currentCommit: string): boolean {
  const order = compareReleases(release, vendored)
  if (order === undefined) throw new Error(`upstream release "${release}" is not a plain major.minor.patch version`)
  return order > 0 || (order === 0 && commit.toLowerCase() !== currentCommit.toLowerCase())
}

/**
 * Read the release upstream currently publishes.
 * @param signal - cancels the request when the caller goes away.
 * @returns the upstream release.
 * @throws when the request fails, the response is not JSON, or it carries no version.
 */
async function fetchUpstreamRelease(signal?: AbortSignal): Promise<{ version: string; commit: string }> {
  const commit = await resolveUpstreamCommit(signal)
  const timeout = AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const options = { signal: requestSignal, headers: { accept: 'application/json' } }
  const url = `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit}/plugin.json`
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`upstream plugin.json answered HTTP ${response.status}`)
  const manifest: unknown = await response.json()
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest
    ? (manifest as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string') throw new Error('upstream plugin.json carries no version')
  return { version, commit }
}

/** Reads the upstream release; injectable so tests do not depend on the network. */
export type ReleaseReader = (signal?: AbortSignal) => Promise<string | { version: string; commit: string }>

interface RevisionBaselineValue { version: string; commit: string }

interface TrackerRead { status: UpdateStatus; baseline?: RevisionBaselineValue }

/**
 * Cache one process's view of the upstream release.
 *
 * A browser half that polls the route must not turn into a request per poll:
 * a successful reading is reused for {@link FRESH_MS} and a failed one for
 * {@link RETRY_MS}, and the first caller after either window pays for the
 * next attempt.
 */
export class UpstreamReleaseTracker {
  private reading: { status: UpdateStatus; expiresAt: number; baseline: RevisionBaselineValue } | undefined

  /** @param readRelease - upstream reader; defaults to the GitHub raw request. */
  constructor(
    private readonly readRelease: ReleaseReader = fetchUpstreamRelease,
    private readonly baseline: () => { version: string; commit: string } = () => ({
      version: VENDORED_VERSION,
      commit: recordedCommit(readFileSync(join(import.meta.dirname, '../UPSTREAM.md'), 'utf8')),
    }),
  ) {}

  /**
   * Report the current comparison, reading upstream when the cache expired.
   * @param signal - cancels an upstream read the caller no longer needs.
   * @returns the reading, carrying `error` instead of a comparison when upstream was unreadable.
   */
  async status(signal?: AbortSignal): Promise<UpdateStatus> {
    for (;;) {
      const now = Date.now()
      if (this.reading !== undefined && this.reading.expiresAt > now) {
        const current = this.safeBaseline()
        if (current !== undefined && sameRevision(current, this.reading.baseline)) return this.reading.status
        this.reading = undefined
      }
      const result = await this.read(signal)
      // A cancelled request belongs to its caller, not to the process-wide cache.
      // Otherwise a browser tab closing during a read could suppress the host's
      // next automatic check for the full retry window.
      if (signal?.aborted) return result.status
      const current = this.safeBaseline()
      if (result.baseline !== undefined && current !== undefined && !sameRevision(current, result.baseline)) {
        // The overlay changed while the remote request was in flight. Discard the
        // comparison and read again so neither the response nor the cache mixes
        // two revisions.
        this.reading = undefined
        continue
      }
      if (current !== undefined) {
        this.reading = {
          status: result.status,
          expiresAt: now + (result.status.error === null ? FRESH_MS : RETRY_MS),
          baseline: current,
        }
      }
      return result.status
    }
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

  private safeBaseline(): RevisionBaselineValue | undefined {
    try { return this.baseline() } catch { return undefined }
  }

  private async read(signal?: AbortSignal): Promise<TrackerRead> {
    const base = { vendored: VENDORED_VERSION, repository: UPSTREAM_REPOSITORY, checkedAt: Date.now() }
    let current: RevisionBaselineValue | undefined
    try {
      current = this.baseline()
      base.vendored = current.version
      const release = await this.readRelease(signal)
      const upstream = typeof release === 'string' ? release : release.version
      const order = compareReleases(upstream, current.version)
      if (order === undefined) return { status: { ...base, upstream, updateAvailable: false, error: `upstream release "${upstream}" is not a plain major.minor.patch version` }, baseline: current }
      const updateAvailable = typeof release === 'string'
        ? order > 0
        : hasUpdate(upstream, current.version, release.commit, current.commit)
      return { status: { ...base, upstream, updateAvailable, error: null }, baseline: current }
    } catch (error: unknown) {
      return {
        status: {
          ...base,
          upstream: null,
          updateAvailable: false,
          error: error instanceof Error ? error.message : String(error),
        },
        ...(current === undefined ? {} : { baseline: current }),
      }
    }
  }
}

function sameRevision(left: RevisionBaselineValue, right: RevisionBaselineValue): boolean {
  return left.version === right.version && left.commit.toLowerCase() === right.commit.toLowerCase()
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

/** Runs the overlay update procedure; injectable so tests neither clone nor commit. */
export type UpdateApplier = (signal?: AbortSignal) => Promise<UpdateApplication>

/** Baseline revision used when no private overlay has been published. */
export type RevisionBaseline = () => Pick<OverlayRevision, 'version' | 'commit'>

/** Read the release recorded in the bundled package. */
function bundledBaseline(): { version: string; commit: string } {
  return {
    version: VENDORED_VERSION,
    commit: recordedCommit(readFileSync(join(import.meta.dirname, '../UPSTREAM.md'), 'utf8')),
  }
}

/**
 * Download and publish the current Compound revision in the private overlay.
 *
 * The managed application checkout is deliberately untouched: it may be detached,
 * carry launcher markers, and be replaced by the app updater at any time. The overlay
 * is user-owned and is selected by the skill provider on the next catalog read.
 * @param root - private overlay directory.
 * @param baseline - bundled revision used when no overlay exists.
 * @returns the update outcome consumed by the browser route.
 */
export async function runOverlayUpdate(
  root: string = overlayRoot(), baseline: RevisionBaseline = bundledBaseline, signal?: AbortSignal,
): Promise<UpdateApplication> {
  try {
    signal?.throwIfAborted()
    const before = activeOverlay(root) ?? baseline()
    const revision = await updateOverlay(root, before.version, signal)
    const changed = revision.version !== before.version || revision.commit.toLowerCase() !== before.commit.toLowerCase()
    return { status: changed ? 'updated' : 'up-to-date', upstream: revision.version, error: null }
  } catch (error: unknown) {
    return { status: 'failed', upstream: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register the update-status route the browser half reads, and the route that applies one.
 * @param ctx - Context carrying the shared API channel.
 * @param tracker - process-wide reading cache.
 * @param apply - update procedure; defaults to the private overlay updater.
 */
export function registerUpdateRoute(
  ctx: Context, tracker: UpstreamReleaseTracker,
  apply: UpdateApplier = signal => runOverlayUpdate(undefined, undefined, signal),
): void {
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
    fetch: async (request) => {
      // One update at a time: a second request must not race the first into the checkout.
      if (running !== undefined) {
        const busy: UpdateApplication = { status: 'failed', upstream: null, error: 'an update is already running' }
        return Response.json(busy, { status: 409, headers: { 'cache-control': 'no-store' } })
      }
      running = (async () => {
        try {
          const outcome = await apply()
          tracker.invalidate()
          request.signal.throwIfAborted()
          return outcome
        } finally {
          running = undefined
        }
      })()
      return Response.json(await running, { headers: { 'cache-control': 'no-store' } })
    },
  })
}
