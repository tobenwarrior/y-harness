/** Update status the Host reports for the vendored Compound skills. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Browser-relative form of the Host route registered by `dsh-skill-compound`. */
export const UPDATE_ROUTE = 'api/skill-compound.update'

/** Browser-relative form of the Host route that applies a released update. */
export const APPLY_ROUTE = 'api/skill-compound.update.apply'

/** One reading of the released Compound skills version. */
export interface UpdateStatus {
  /** Release currently vendored into this Y Harness build. */
  readonly vendored: string
  /** Release the upstream repository publishes, when it could be read. */
  readonly upstream: string | null
  /** Whether upstream publishes a later release than the vendored one. */
  readonly updateAvailable: boolean
  /** Upstream repository the comparison was made against. */
  readonly repository: string
  /** When the reading was taken, in epoch milliseconds. */
  readonly checkedAt: number | null
  /** Why the released version could not be compared, when it could not. */
  readonly error: string | null
}

/** Indicator state shared by the sidebar badge and the steps panel. */
export interface CompoundUpdateState {
  /** Reading progress of the Host route. */
  readonly phase: 'idle' | 'loading' | 'ready'
  /** Whether the steps panel is showing. */
  readonly open: boolean
  /** Latest reading, retained while a newer one is in flight. */
  readonly status: UpdateStatus | null
  /** Progress of the in-app update the user asked for. */
  readonly apply: ApplyProgress
}

/** Progress of one in-app update. */
export interface ApplyProgress {
  /** Idle before the user asks; `done` means the checkout now holds the release. */
  readonly phase: 'idle' | 'running' | 'done' | 'failed'
  /** Why the update did not apply, when it did not. */
  readonly error: string | null
}

/** What the Host route answers after one update attempt. */
interface ApplyOutcome {
  /** What the attempt did. */
  readonly status: 'updated' | 'up-to-date' | 'failed' | 'unavailable'
  /** Release the attempt applied, when it applied one. */
  readonly upstream: string | null
  /** Why the attempt did not apply, when it did not. */
  readonly error: string | null
}

/**
 * Validate one apply response before the indicator renders it.
 * @param value - parsed response body.
 * @returns whether the body is a complete apply outcome.
 */
export function isApplyOutcome(value: unknown): value is ApplyOutcome {
  if (typeof value !== 'object' || value === null) return false
  const outcome = value as Partial<Record<keyof ApplyOutcome, unknown>>
  return (outcome.status === 'updated' || outcome.status === 'up-to-date' || outcome.status === 'failed' || outcome.status === 'unavailable')
    && (typeof outcome.upstream === 'string' || outcome.upstream === null)
    && (typeof outcome.error === 'string' || outcome.error === null)
}

/**
 * Nothing to do here: the Host asks the on-quit updater to restart the app.
 *
 * The rebuild cannot run against a live app, so applying the update schedules the
 * restart on the Host side and the panel only reports it.
 */

/** Data and callbacks the indicator registrations receive. */
export interface CompoundUpdateFace {
  /** Reading source the renderer binds as `useUpdate`. */
  readonly hooks: { readonly update: HostObservable<CompoundUpdateState> }
  /** Read the Host route again. */
  readonly refresh: () => void
  /** Open the update steps panel. */
  readonly show: () => void
  /** Close the update steps panel. */
  readonly hide: () => void
  /** Apply the released update, then quit so the rebuild can follow. */
  readonly apply: () => void
}

/**
 * Validate one route response before the indicator renders it.
 * @param value - parsed response body.
 * @returns whether the body is a complete update status.
 */
export function isUpdateStatus(value: unknown): value is UpdateStatus {
  if (typeof value !== 'object' || value === null) return false
  const status = value as Partial<Record<keyof UpdateStatus, unknown>>
  return typeof status.vendored === 'string'
    && (typeof status.upstream === 'string' || status.upstream === null)
    && typeof status.updateAvailable === 'boolean'
    && typeof status.repository === 'string'
    && (typeof status.checkedAt === 'number' || status.checkedAt === null)
    && (typeof status.error === 'string' || status.error === null)
}

/** Owns the indicator's reading state and its request lifetime. */
export class CompoundUpdateController {
  private readonly source = createSnapshotStore<CompoundUpdateState>({
    phase: 'idle', open: false, status: null, apply: { phase: 'idle', error: null },
  })
  private request: AbortController | undefined

  /** Read the Host route once, retaining the previous reading until it answers. */
  async refresh(): Promise<void> {
    this.request?.abort()
    const request = new AbortController()
    this.request = request
    this.patch({ phase: 'loading' })
    try {
      const response = await fetch(UPDATE_ROUTE, { signal: request.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value: unknown = await response.json()
      if (!isUpdateStatus(value)) throw new Error('the Host answered with an unrecognized status')
      // A superseded read must not publish over the reading that replaced it.
      if (request.signal.aborted) return
      this.patch({ phase: 'ready', status: value })
    } catch (error: unknown) {
      if (request.signal.aborted) return
      this.patch({
        phase: 'ready',
        status: {
          vendored: this.source.getSnapshot().status?.vendored ?? '',
          upstream: null,
          updateAvailable: false,
          repository: '',
          checkedAt: null,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      if (this.request === request) this.request = undefined
    }
  }

  /**
   * Apply the released update, then ask the desktop shell to quit.
   *
   * The quit is the point: the checkout now holds the release, and the on-quit
   * updater rebuilds and relaunches. A host that cannot update (no checkout) or a
   * failed attempt leaves the app running and reports why.
   * @returns nothing; progress is published on the shared state.
   */
  async applyUpdate(): Promise<void> {
    if (this.source.getSnapshot().apply.phase === 'running') return
    this.patch({ apply: { phase: 'running', error: null } })
    try {
      const response = await fetch(APPLY_ROUTE, { method: 'POST' })
      const value: unknown = await response.json()
      if (!isApplyOutcome(value)) throw new Error('the Host answered with an unrecognized outcome')
      if (value.status === 'updated' || value.status === 'up-to-date') {
        this.patch({ apply: { phase: 'done', error: null } })
        void this.refresh()
        return
      }
      this.patch({ apply: { phase: 'failed', error: value.error ?? 'the update did not apply' } })
    } catch (error: unknown) {
      this.patch({ apply: { phase: 'failed', error: error instanceof Error ? error.message : String(error) } })
    }
  }

  /** Release the in-flight request; the fiber that owns this controller is going away. */
  dispose(): void {
    this.request?.abort()
    this.request = undefined
  }

  /**
   * Build the registration face.
   * @returns hooks and the deliberate user actions.
   */
  face(): CompoundUpdateFace {
    return {
      hooks: { update: this.source },
      refresh: () => { void this.refresh() },
      show: () => { this.patch({ open: true }); void this.refresh() },
      hide: () => { this.patch({ open: false }) },
      apply: () => { void this.applyUpdate() },
    }
  }

  private patch(change: Partial<CompoundUpdateState>): void {
    this.source.set({ ...this.source.getSnapshot(), ...change })
  }
}
