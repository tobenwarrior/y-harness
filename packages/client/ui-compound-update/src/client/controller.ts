/** Update status the Host reports for the vendored Compound skills. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Browser-relative form of the Host route registered by `dsh-skill-compound`. */
export const UPDATE_ROUTE = 'api/skill-compound.update'

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
}

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
  private readonly source = createSnapshotStore<CompoundUpdateState>({ phase: 'idle', open: false, status: null })
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
    }
  }

  private patch(change: Partial<CompoundUpdateState>): void {
    this.source.set({ ...this.source.getSnapshot(), ...change })
  }
}
