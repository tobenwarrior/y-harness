/** Optional Host-owned sharing of ordinary provider catalogs, with local access. */
import { join, resolve } from 'node:path'
import { Context, Service } from '@yharness/cordis'
import z from '@yharness/schemastery'
import { watch, type FSWatcher } from 'chokidar'
import type {} from '@yharness/settings'
import type {} from '@yharness/app-boot'
import type {} from '@yharness/hmr'
import { ProviderSyncEngine } from './engine.ts'
import type { LocalNamespace, SyncStatus } from './engine.ts'
import { schemaFingerprint } from './profile.ts'

declare module '@yharness/cordis' {
  interface Context {
    /** Optional ordinary provider configuration sharing; no credential transport. */
    providerConfigSync: ProviderConfigSync
  }
}

/** Pairing is explicit; no shared location is selected by default. */
export interface Config {
  /** Explicit absolute path shared only by approved, schema-compatible local profiles. */
  sharedPath?: string
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported local provider configuration')
  return value as Record<string, unknown>
}

/** Own the refresh queue, settings listener, watcher, and quiescent disposal. */
export default class ProviderConfigSync extends Service {
  static inject = ['settings', 'profileContext']
  static Config = z.object({ sharedPath: z.string().min(1) })
  private readonly engine: ProviderSyncEngine | undefined
  private watcher: FSWatcher | undefined
  private closed = false
  private requested = false
  private running: Promise<SyncStatus> | undefined
  private current: SyncStatus = { state: 'unconfigured', conflicts: [] }
  private readonly lifetime = new AbortController()

  constructor(private readonly ownerContext: Context, config: Config) {
    super(ownerContext, 'providerConfigSync')
    if (config.sharedPath === undefined) return
    const sharedPath = config.sharedPath
    const receiptPath = join(ownerContext.profileContext.dir, `.provider-config-sync-${schemaFingerprint(resolve(sharedPath)).slice(0, 16)}.json`)
    this.engine = new ProviderSyncEngine({ sharedPath, receiptPath, read: () => this.read(),
      mutate: (ops, revision) => ownerContext.settings.mutate('llm-pi-ai', ops, revision, this.lifetime.signal) })
    this.current = { state: 'pending', conflicts: [] }
    ownerContext.on('settings/document-updated', (ns) => { if (ns === 'llm-pi-ai') void this.synchronize() })
    ownerContext.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      await this.watcher?.close()
      await this.running
    })
    const start = () => {
      this.watcher = watch(sharedPath, { ignoreInitial: true, depth: 0 })
      this.watcher.on('all', () => { void this.synchronize() })
      this.watcher.on('error', () => { this.fail() })
      void this.synchronize()
    }
    const hmr = ownerContext.get('hmr')
    if (hmr === undefined) start()
    else hmr.runOutsideTransaction(start)
  }

  private read(): LocalNamespace | undefined {
    if (this.closed) return undefined
    const descriptor = this.ownerContext.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    if (descriptor === undefined) return undefined
    return { schema: descriptor.schema, revision: descriptor.revision,
      providers: object(object(descriptor.user).providers), inherited: object(object(descriptor.base).providers) }
  }

  private fail(): void {
    this.current = { state: 'error', conflicts: [] }
    // Never log configuration payloads or provider/parser error excerpts.
    this.ownerContext.logger.warn('Provider configuration synchronization failed; local settings were preserved')
  }

  /** Read a detached status without exposing configuration or credentials.
   * @returns Readiness or conflict identities, without provider values.
   */
  status(): SyncStatus { return { ...this.current, conflicts: [...this.current.conflicts] } }

  /** Queue a refresh; repeated notifications share one lifecycle and never re-enter a lock.
   * @returns The status after this refresh queue reaches its current commit point.
   */
  synchronize(): Promise<SyncStatus> {
    const engine = this.engine
    if (engine === undefined || this.closed) return Promise.resolve(this.status())
    const queue = () => {
      this.requested = true
      if (this.running !== undefined) return this.running
      const completed = Promise.withResolvers<SyncStatus>()
      this.running = completed.promise
      void Promise.resolve().then(async () => {
        while (this.requested && !this.closed) {
          this.requested = false
          try { this.current = await engine.synchronize() } catch { if (!this.lifetime.signal.aborted) this.fail() }
        }
        // Clear ownership in the same stack as completion, before any next notification.
        this.running = undefined
        completed.resolve(this.status())
      })
      return completed.promise
    }
    const hmr = this.ownerContext.get('hmr')
    return hmr === undefined ? queue() : hmr.runOutsideTransaction(queue)
  }
}
