/**
 * Self-healing for stale-boot races. A rebuild that publishes its manifest
 * before its artifacts settle makes reconciliation replace the bootstrap
 * module, which the module system refuses without a page reload. The failure
 * message already prescribes the remedy, so the shell performs it instead of
 * parking on the boot failure screen. Genuine breakage still reaches the
 * screen: the reload guard bounds automatic reloads to one per boot chain.
 * @module @yharness/client-web/src/bootstrap-staleness
 */

/** Failure signature the module system raises for bootstrap replacement. */
const STALENESS_MARK = 'requires a page reload'

/** Session flag bounding automatic reloads to one per boot chain. */
const RELOAD_GUARD_KEY = 'dsh.web.bootstrapReloaded'

/** Settle delay before reloading, so an in-flight rebuild can finish publishing artifacts. */
const RELOAD_SETTLE_MS = 2000

/** Test seams for the reload side effects; production calls omit them. */
export interface StalenessReloadSeams {
  /** Page reload; defaults to the document location. */
  readonly reloadPage?: () => void
  /** Guard storage; defaults to the session storage. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Settle delay override; zero reloads synchronously. */
  readonly settleMs?: number
  /** Timer injection; defaults to the global timeout. */
  readonly defer?: (callback: () => void, ms: number) => void
}

/**
 * Whether every message is a bootstrap replacement that a fresh boot resolves.
 * Mixed failures keep their screen: reloading cannot fix the other entries.
 * @param messages - Failure messages from one reconciliation or boot attempt.
 * @returns true only for a non-empty, all-staleness set.
 */
export function isBootstrapStalenessOnly(messages: readonly string[]): boolean {
  return messages.length > 0 && messages.every(message => message.includes(STALENESS_MARK))
}

/**
 * Schedule one page reload for bootstrap staleness.
 * @param seams - Reload side-effect overrides; production calls omit them.
 * @returns whether a reload was scheduled; false keeps the caller's failure screen.
 */
export function reloadOnceForStaleness(seams: StalenessReloadSeams = {}): boolean {
  const storage = seams.storage ?? sessionStorage
  try {
    if (storage.getItem(RELOAD_GUARD_KEY) !== null) return false
    storage.setItem(RELOAD_GUARD_KEY, '1')
  } catch {
    // Storage unavailable: refuse the reload rather than risk a loop without a guard.
    return false
  }
  const reloadPage = seams.reloadPage ?? ((): void => { location.reload() })
  const settleMs = seams.settleMs ?? RELOAD_SETTLE_MS
  if (settleMs <= 0) reloadPage()
  else (seams.defer ?? setTimeout)(() => { reloadPage() }, settleMs)
  return true
}

/**
 * Clear the reload guard after a successful mount, re-arming future incidents.
 * @param storage - Guard storage override; defaults to the session storage.
 */
export function clearBootstrapReloadGuard(storage?: Pick<Storage, 'removeItem'>): void {
  try {
    (storage ?? sessionStorage).removeItem(RELOAD_GUARD_KEY)
  } catch {
    // Storage unavailable: the guard stays set and the next staleness keeps its screen.
  }
}
