/** Shared page-lifetime availability state for the Computer opener. */

import { createSnapshotStore, type SnapshotStore } from '@yharness/client-store'
import type { ComputerClient } from './computer-client.ts'

/** Availability reported by the authenticated Computer status route. */
export type AvailabilityState = 'checking' | 'available' | 'unavailable'

/** Shared status source used by session-header Computer actions. */
export interface ComputerAvailability {
  readonly source: SnapshotStore<AvailabilityState>
  refresh(): void
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
  let request = 0
  let disposed = false
  let controller: AbortController | undefined

  const refresh = (): void => {
    if (disposed) return
    controller?.abort()
    controller = new AbortController()
    const current = ++request
    source.set('checking')
    void client.status(controller.signal).then((status) => {
      if (disposed || current !== request) return
      source.set(status.available ? 'available' : 'unavailable')
    }).catch((error: unknown) => {
      if (disposed || current !== request || (error instanceof DOMException && error.name === 'AbortError')) return
      source.set('unavailable')
    })
  }

  return {
    source,
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
