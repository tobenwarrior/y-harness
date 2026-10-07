/** Page-owned Loader entries; transport-independent reconciliation, retries and code replacement. */
import type { Fiber, FiberState } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { parseBootManifest } from './manifest.ts'
import type { BootManifest, ClientModuleLoader } from './manifest.ts'
import { removeOwnedStyles, tearDownEntryFiber } from './entry-lifecycle.ts'

/** Page-local failures do not change the Host's bundle enablement. */
export interface ClientEntryState {
  /** True during live Loader mutations and queued settlement; prefetch alone leaves it false. */
  readonly syncing: boolean
  /** Package ids and errors from the latest reconciliation. */
  readonly failures: readonly { readonly id: string; readonly message: string }[]
}

/** Module-table capabilities used within serialized entry operations. */
interface ModuleIndex {
  update(manifest: BootManifest, managed: Iterable<string>): void
  invalidateForReplacement(id: string, rev: string): void
  prune(roots: Iterable<string>): void
}

/** Numeric values mirror Cordis's const enum, which bundle loaders cannot import as a runtime object. */
const ACTIVE = 2 as FiberState.ACTIVE
const FAILED = 3 as FiberState.FAILED

/** Revisions and requests identify desired code; URLs only select its immutable delivery resource. */
function entryTargets(manifest: BootManifest): string {
  return JSON.stringify(manifest.modules.map(row => [row.id, row.rev, row.inject, row.external]))
}

/** Manages only entries created from the Host manifest; other Loader contributors retain ownership. */
export class ClientEntries {
  /** Stable observable consumed by page diagnostics through the renderer's injected hook. */
  readonly state: ObservableSnapshot<ClientEntryState> = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  // The modules bootstrap factory cannot request platform libraries before the shell supplies its seed.
  private snapshot: ClientEntryState = { syncing: false, failures: [] }
  private readonly listeners = new Set<() => void>()
  private readonly retirementListeners = new Set<(fibers: readonly Fiber[]) => void>()
  private readonly managed = new Map<string, Entry>()
  private readonly revisions = new Map<string, string>()
  private loader: Loader | undefined
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private desired: BootManifest
  private generation = 0
  private stopped = false

  /**
   * Construct the page controller before Cordis boot.
   * @param modules - Module arrival and materialization owner.
   * @param index - Private descriptor replacement and unused-module cleanup.
   */
  constructor(private readonly modules: ClientModuleLoader, private readonly index: ModuleIndex) {
    this.desired = modules.manifest
  }

  /**
   * Observe fibers synchronously before Loader removal, code replacement or failed-fiber restart.
   * Replacement reports every fiber of the shared plugin runtime; removal and restart report the entry fiber.
   * A listener error aborts that mutation and follows the operation's error reporting. Creation does not notify listeners.
   * @param listener - Called after syncing begins and before any retiring fiber is disposed.
   * @returns Unsubscribe the listener.
   */
  beforeRetire(listener: (fibers: readonly Fiber[]) => void): () => void {
    this.retirementListeners.add(listener)
    return () => { this.retirementListeners.delete(listener) }
  }

  /**
   * Create the initial roster and retain its entry identities for subsequent reconciliation.
   * @param loader - Page Loader, already configured with the module system.
   * @param manifest - Initial roster audited by the boot caller.
   * @returns after initial entries and their activation settle; boot owns its activation audit.
   */
  start(loader: Loader, manifest: BootManifest): Promise<void> {
    if (this.loader !== undefined) throw new Error('client-modules: entries already started')
    this.loader = loader
    this.desired = manifest
    loader.ctx.effect(() => () => {
      this.stopped = true
      this.generation++
      return this.queue
    }, 'client-modules: entry reconciliation')
    return this.enqueue(async () => {
      await Promise.all(this.desired.plugins.map(async ({ id }) => {
        await this.create(loader, id)
      }))
      await loader.await()
      for (const row of this.modules.manifest.modules) this.revisions.set(row.id, row.rev)
    })
  }

  /**
   * Validate and apply the latest full Host graph. Changed targets cancel obsolete mounts; identical targets share pending loads.
   * @param graph - JSON-decoded graph received from the Host.
   * @returns after the queued reconciliation; per-package failures remain available in {@link state}.
   */
  sync(graph: unknown): Promise<void> {
    const manifest = parseBootManifest(graph)
    if (entryTargets(manifest) !== entryTargets(this.desired)) this.generation++
    this.desired = manifest
    const generation = this.generation
    return this.enqueue(() => this.reconcile(generation))
  }

  /**
   * Retry failed entries against the latest graph, including an unchanged revision.
   * @returns after retry settlement, with remaining errors in {@link state}.
   */
  retry(): Promise<void> {
    const generation = ++this.generation
    return this.enqueue(() => this.reconcile(generation))
  }

  /**
   * Replace one entry's code in the same queue as graph updates; duplicate revisions are ignored.
   * Entries missing after a failed import are reconciled; bootstrap replacement fails before teardown.
   * @param id - Package id from a rebuilt frame.
   * @param rev - Opaque revision selecting the rebuilt artifact.
   * @returns after replacement and Loader-owned cascades settle; errors reject, and activation failures remain in {@link state}.
   */
  reload(id: string, rev: string): Promise<void> {
    this.desired = {
      ...this.desired,
      modules: this.desired.modules.map(row => row.id === id ? { ...row, rev } : row),
    }
    const generation = this.generation
    return this.enqueue(async () => {
      const desired = this.desired.modules.find(row => row.id === id)
      if (!this.current(generation) || desired === undefined || desired.rev !== rev) return
      const entry = this.managed.get(id)
      if (entry === undefined) {
        this.modules.invalidate(id, desired.rev)
        removeOwnedStyles(id)
        await this.reconcile(generation)
        return
      }
      if (this.revisions.get(id) === rev && entry.fiber !== undefined) return
      await this.prepare(id, rev)
      await this.replace(entry, id, rev, generation)
      if (!this.currentTarget(generation, id, rev)) return
      const failures = await this.audit(this.snapshot.failures.filter(failure => failure.id !== id && !this.managed.has(failure.id)))
      this.publish({ syncing: this.snapshot.syncing, failures })
    }, id)
  }

  private publish(snapshot: ClientEntryState): void {
    if (snapshot.syncing === this.snapshot.syncing
      && snapshot.failures.length === this.snapshot.failures.length
      && snapshot.failures.every((failure, index) => {
        const previous = this.snapshot.failures[index]
        return failure.id === previous?.id && failure.message === previous.message
      })) return
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        // The page controller has no owning plugin Context for a scoped logger.
        console.error('client-modules: synchronization subscriber failed', error)
      }
    }
  }

  private enqueue(task: () => Promise<void>, subject = 'graph'): Promise<void> {
    this.pending++
    const run = this.queue.then(async () => {
      try {
        await task()
      } catch (error) {
        await this.loader?.await()
        this.publish({ syncing: this.snapshot.syncing, failures: [
          ...this.snapshot.failures.filter(failure => failure.id !== subject),
          { id: subject, message: String(error) },
        ] })
        throw error
      } finally {
        await this.loader?.await()
        if (--this.pending === 0) this.publish({ syncing: false, failures: this.snapshot.failures })
      }
    })
    // Each operation reports its own failure; later operations must still run.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private beginApplying(): void {
    if (!this.snapshot.syncing) this.publish({ syncing: true, failures: this.snapshot.failures })
  }

  private notifyBeforeRetire(fibers: readonly Fiber[]): void {
    for (const listener of [...this.retirementListeners]) listener(fibers)
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  private currentTarget(generation: number, id: string, rev: string): boolean {
    return this.current(generation) && this.desired.modules.some(row => row.id === id && row.rev === rev)
  }

  private requireLoader(): Loader {
    if (this.loader === undefined) throw new Error('client-modules: entries have not started')
    return this.loader
  }

  /** Keep ownership even when Loader rejects a module's plugin exports after inserting its entry. */
  private async create(loader: Loader, id: string): Promise<void> {
    const options = { name: id }
    const entryId = loader.ensureId(options)
    try {
      await loader.create(options)
    } finally {
      this.managed.set(id, loader.resolve(entryId))
    }
  }

  private async prepare(id: string, rev: string): Promise<void> {
    this.index.invalidateForReplacement(id, rev)
    await this.modules.prefetch(id)
  }

  private async replace(entry: Entry, id: string, rev: string, generation: number): Promise<void> {
    if (!this.currentTarget(generation, id, rev)) return
    this.beginApplying()
    if (!this.currentTarget(generation, id, rev)) return
    const fiber = entry.fiber
    if (fiber !== undefined) this.notifyBeforeRetire(fiber.runtime === null ? [fiber] : [...fiber.runtime.fibers])
    if (!this.currentTarget(generation, id, rev)) return
    await tearDownEntryFiber(entry)
    removeOwnedStyles(id)
    if (!this.currentTarget(generation, id, rev)) return
    await this.modules.import(id, '', {})
    if (!this.currentTarget(generation, id, rev)) return
    await entry.refresh()
    await this.requireLoader().await()
    await entry.fiber?.await()
    if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
    this.revisions.set(id, rev)
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.current(generation)) return
    const loader = this.requireLoader()
    const manifest = this.desired
    const failures: { id: string; message: string }[] = []
    this.index.update(manifest, this.managed.keys())
    for (const row of manifest.modules) {
      if (!this.current(generation)) return
      if (!this.currentTarget(generation, row.id, row.rev)) continue
      try {
        const entry = this.managed.get(row.id)
        if (entry === undefined) await this.modules.prefetch(row.id)
        else if (this.revisions.get(row.id) !== row.rev || entry.fiber === undefined) await this.prepare(row.id, row.rev)
      } catch (error) {
        if (this.currentTarget(generation, row.id, row.rev)) failures.push({ id: row.id, message: String(error) })
      }
    }
    if (!this.current(generation)) return
    if (failures.length > 0) {
      const settledFailures = await this.audit(failures)
      if (this.current(generation)) this.publish({ syncing: this.snapshot.syncing, failures: settledFailures })
      return
    }
    const wanted = new Set(manifest.plugins.map(row => row.id))
    for (const [id, entry] of this.managed) {
      if (wanted.has(id)) continue
      this.beginApplying()
      if (!this.current(generation)) break
      const fiber = entry.fiber
      if (fiber !== undefined) this.notifyBeforeRetire([fiber])
      if (!this.current(generation)) break
      loader.remove(entry.id)
      this.managed.delete(id)
      this.revisions.delete(id)
      // Removed fibers no longer appear in Loader.getTasks().
      while (fiber?.inertia !== undefined) await fiber.inertia
    }
    for (const row of manifest.modules) {
      if (!this.current(generation)) break
      if (!this.currentTarget(generation, row.id, row.rev)) continue
      try {
        const entry = this.managed.get(row.id)
        if (entry === undefined) {
          await this.modules.import(row.id, '', {})
          if (!this.currentTarget(generation, row.id, row.rev)) continue
          this.beginApplying()
          if (!this.currentTarget(generation, row.id, row.rev)) continue
          await this.create(loader, row.id)
          this.revisions.set(row.id, row.rev)
        } else if (this.revisions.get(row.id) !== row.rev) {
          await this.replace(entry, row.id, row.rev, generation)
        } else if (entry.fiber === undefined) {
          await this.replace(entry, row.id, row.rev, generation)
        } else if (entry.fiber.state === FAILED) {
          const fiber = entry.fiber
          this.beginApplying()
          if (!this.currentTarget(generation, row.id, row.rev)) continue
          this.notifyBeforeRetire([fiber])
          if (!this.currentTarget(generation, row.id, row.rev)) continue
          fiber.update(entry.options.config)
        }
      } catch (error) {
        failures.push({ id: row.id, message: String(error) })
      }
    }
    const settledFailures = await this.audit(failures)
    this.index.prune([...loader.entries()].map(entry => entry.options.name))
    if (this.current(generation)) this.publish({ syncing: this.snapshot.syncing, failures: settledFailures })
  }

  private async audit(failures: { id: string; message: string }[]): Promise<{ id: string; message: string }[]> {
    await this.requireLoader().await()
    for (const [id, entry] of this.managed) {
      if (failures.some(failure => failure.id === id)) continue
      if (entry.fiber?.state === ACTIVE) continue
      try {
        if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
        await entry.fiber.await()
        failures.push({ id, message: `client-modules: ${id} is waiting for activation` })
      } catch (error) {
        failures.push({ id, message: String(error) })
      }
    }
    return failures
  }
}
