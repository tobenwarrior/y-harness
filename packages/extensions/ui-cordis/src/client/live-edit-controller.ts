/** Own the Client-side lifecycle for one reversible Live Edit preview. */

import type { Context as ClientContext } from '@yharness/cordis'
import type {
  LiveEditAction, LiveEditState, RemoteResult,
} from '@yharness/api-remotes/client'
import type { HostObservable } from '@yharness/client-ui-slots'
import type { LiveEditPreview } from './live-edit-preview.ts'

/** State the controls render in addition to the Host-owned patch state. */
export interface LiveEditViewState extends LiveEditState {
  /** Whether a Keep or Undo request is currently in flight. */
  readonly phase: 'idle' | 'applying'
  /** Last local/Remote failure for the currently visible state. */
  readonly error: string | null
}

/** Face shared by the sidebar badge and the frame-wide controls. */
export interface LiveEditFace {
  /** Observable state consumed through the slot renderer's selector hook. */
  readonly hooks: { readonly state: HostObservable<LiveEditViewState> }
  /** Apply a user decision to the exact revision currently shown. */
  readonly onAction: (action: LiveEditAction, revision: string) => Promise<void>
  /** Move keyboard focus to the visible Keep/Undo action. */
  readonly focus: () => void
}

/** Controller and cleanup returned by the Client plugin. */
export interface LiveEditController {
  /** Face injected into the Live Edit slot entries. */
  readonly face: LiveEditFace
  /** Re-read the authoritative state after a forwarded event or reconnect. */
  readonly refresh: () => void
  /** Stop Remote reads and dispose the preview motor. */
  readonly dispose: () => void
}

const INITIAL_STATE: LiveEditViewState = {
  revision: '',
  canUndo: false,
  phase: 'idle',
  error: null,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function remoteErrorMessage(result: Extract<RemoteResult<never>, { ok: false }>): string {
  return `${result.error.code}: ${result.error.message}`
}

/**
 * Create the revision-fenced Remote reader and the DOM preview bridge.
 *
 * Every write is guarded by one monotonically increasing operation number. A
 * late state read can therefore never replace the state from a newer event or
 * Keep/Undo response. The renderer always receives `preview ?? kept`, so a
 * kept patch remains visible while the Host has no active preview.
 *
 * @param ctx - Client root carrying the Remote namespace and forwarded events.
 * @param preview - renderer motor that applies and clears DOM patches.
 * @returns the shared Live Edit face and its cleanup.
 */
export function createLiveEditController(
  ctx: ClientContext,
  preview: LiveEditPreview,
): LiveEditController {
  let state = INITIAL_STATE
  let disposed = false
  let operation = 0
  let appliedFingerprint: string | undefined
  const listeners = new Set<() => void>()

  const source: HostObservable<LiveEditViewState> = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const publish = (next: LiveEditViewState): void => {
    if (disposed) return
    state = next
    const patch = next.preview ?? next.kept
    // Keep phase/error updates from restarting the renderer's enter/exit
    // animation. Remote reads clone patches, so compare their JSON value as
    // well as retaining the fast path for the common same-object update.
    const fingerprint = patch === undefined ? undefined : JSON.stringify(patch)
    if (fingerprint !== appliedFingerprint) {
      appliedFingerprint = fingerprint
      preview.apply(patch)
    }
    for (const listener of [...listeners]) listener()
  }

  const publishRemote = (next: LiveEditState): void => {
    publish({ ...next, phase: 'idle', error: null })
  }

  const refresh = (): void => {
    const currentOperation = ++operation
    void ctx.remote.dynamicCordisRunner.liveEditState().then((result) => {
      if (disposed || currentOperation !== operation) return
      if (!result.ok) {
        // A disconnected page starts from the empty state and will retry on
        // the next connection generation; do not flash an error card there.
        if (state.preview === undefined && state.kept === undefined) return
        publish({ ...state, phase: 'idle', error: remoteErrorMessage(result) })
        return
      }
      publishRemote(result.value)
    }, (error: unknown) => {
      if (disposed || currentOperation !== operation) return
      if (state.preview === undefined && state.kept === undefined) return
      publish({ ...state, phase: 'idle', error: errorMessage(error) })
    })
  }

  const onAction = async (action: LiveEditAction, revision: string): Promise<void> => {
    if (disposed || state.phase === 'applying' || revision !== state.revision) return
    // Keep is meaningful only while a preview is staged. Undo is meaningful
    // only while the Host says a prior kept patch can be reverted.
    if (action === 'keep' && state.preview === undefined) return
    if (action === 'undo' && !state.canUndo && state.preview === undefined) return

    const currentOperation = ++operation
    publish({ ...state, phase: 'applying', error: null })
    try {
      const result = await ctx.remote.dynamicCordisRunner.applyLiveEdit(action, revision)
      if (disposed || currentOperation !== operation) return
      if (!result.ok) {
        publish({ ...state, phase: 'idle', error: remoteErrorMessage(result) })
        return
      }
      publishRemote(result.value)
    } catch (error: unknown) {
      if (disposed || currentOperation !== operation) return
      publish({ ...state, phase: 'idle', error: errorMessage(error) })
    }
  }

  const focus = (): void => {
    const root = document.querySelector<HTMLElement>('[data-yh-live-edit-controls]')
    root?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }

  const onReset = (): void => {
    operation++
    publish(INITIAL_STATE)
    refresh()
  }

  const disposeEvent = ctx.remote.$on('cordis/live-edit-changed', refresh)
  const disposeReset = ctx.on('connection/reset', onReset)
  refresh()

  return {
    face: { hooks: { state: source }, onAction, focus },
    refresh,
    dispose: () => {
      if (disposed) return
      disposed = true
      operation++
      disposeEvent()
      disposeReset()
      preview.dispose()
      listeners.clear()
    },
  }
}
