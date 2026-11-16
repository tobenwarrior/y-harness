/** Shared page-lifetime availability state for the Computer opener. */

import { createSnapshotStore, type SnapshotStore } from '@yharness/client-store'
import type { ComputerClient, ComputerIdentity } from './computer-client.ts'

/** Availability reported by the authenticated Computer status route. */
export type AvailabilityState = 'checking' | 'available' | 'mac' | 'unavailable'

/** Shared status source used by session-header Computer actions. */
export interface ComputerAvailability {
  readonly source: SnapshotStore<AvailabilityState>
  readonly identity: SnapshotStore<ComputerIdentity | undefined>
  /**
   * Refresh status for the active Bot, or the legacy route when omitted.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  refresh(sessionId?: string): void
  dispose(): void
}

/**
 * Keep one latest-result-wins status read for all Session headers.
 *
 * @param client authenticated Computer route client
 * @returns a refreshable availability source and its lifecycle disposer
 */
export function createComputerAvailability(client: ComputerClient): ComputerAvailability {
  const source = createSnapshotStore<AvailabilityState>('checking')
  const identity = createSnapshotStore<ComputerIdentity | undefined>(undefined)
  let request = 0
  let disposed = false
  let controller: AbortController | undefined

  const refresh = (sessionId?: string): void => {
    if (disposed) return
    controller?.abort()
    controller = new AbortController()
    const current = ++request
    source.set('checking')
    identity.set(undefined)
    void client.status(controller.signal, sessionId).then((status) => {
      if (disposed || current !== request) return
      identity.set(status.computer)
      source.set(status.available ? (status.kind === 'mac' ? 'mac' : 'available') : 'unavailable')
    }).catch((error: unknown) => {
      if (disposed || current !== request || (error instanceof DOMException && error.name === 'AbortError')) return
      identity.set(undefined)
      source.set('unavailable')
    })
  }

  return {
    source,
    identity,
    refresh,
    dispose: () => {
      if (disposed) return
      disposed = true
      ++request
      controller?.abort()
      controller = undefined
    },
  }
}
