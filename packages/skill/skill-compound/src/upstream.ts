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

import type { Context } from '@deepseek-ai/cordis'

/** Release of the vendored content; kept equal to the table in `UPSTREAM.md`. */
export const VENDORED_VERSION = '0.11.0'

/** Upstream repository the vendored content is copied from. */
export const UPSTREAM_REPOSITORY = 'tobenwarrior/compound-skills'

/** Branch whose `plugin.json` carries the current release. */
const UPSTREAM_BRANCH = 'main'

/** Same-origin route the browser half reads update status from. */
export const UPDATE_ROUTE = '/api/skill-compound.update'

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

/**
 * Register the update-status route the browser half reads.
 * @param ctx - Context carrying the shared API channel.
 * @param tracker - process-wide reading cache.
 */
export function registerUpdateRoute(ctx: Context, tracker: UpstreamReleaseTracker): void {
  ctx.connection.fetch.register({
    path: UPDATE_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => Response.json(await tracker.status(request.signal), { headers: { 'cache-control': 'no-store' } }),
  })
}
