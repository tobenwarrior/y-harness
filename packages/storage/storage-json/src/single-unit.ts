/**
 * One opened JSON unit in `single` layout: the whole unit is one document at
 * `<root>/<name>.json`. Each write takes the file lock, rereads the current
 * document, and republishes the complete result atomically before refreshing
 * the in-memory projection. Writes are NOT queued here — per the backend
 * contract, write ordering belongs to the caller (the domain layer's write
 * chain); the lock only fences independent processes. The `per-record` layout
 * is a separate unit class in `per-record-unit.ts`.
 * @module @yharness/storage-json/src/single-unit
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock } from '@yharness/atomic-write'
import { StorageError } from '@yharness/storage'
import type { KvUnit, KvUnitDescriptor } from '@yharness/storage'
import { writeAtomic } from './atomic.ts'
import { parse, serialize } from './format.ts'
import type { UnitState } from './format.ts'

/**
 * Open (load or lazily create) one `single`-layout unit under `root`: the
 * unit file is `<root>/<name>.json`.
 * @param descriptor - Static identity and shape of the unit.
 * @param root - Absolute backend root directory.
 * @param onClose - Backend callback releasing the unit's open-slot.
 * @returns the opened unit.
 */
export async function openSingleUnit(
  descriptor: KvUnitDescriptor,
  root: string,
  onClose: () => void,
): Promise<KvUnit> {
  const path = join(root, `${descriptor.name}.json`)
  let text: string | undefined
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Missing file = empty unit; materialization defers to the first write.
  }
  const state: UnitState =
    text === undefined
      ? {
        version: descriptor.version,
        global: null,
        tables: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
      }
      : parse(text, descriptor)
  return new SingleJsonUnit(descriptor, path, state, onClose)
}

class SingleJsonUnit implements KvUnit {
  private closed = false
  /** In-flight publishes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly path: string,
    private readonly state: UnitState,
    private readonly onClose: () => void,
  ) {}

  // oxlint-disable-next-line typescript/require-await -- async keeps the closed guard a rejection, not a synchronous throw
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    this.assertOpen()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const [table, records] of this.state.tables) {
      tables[table] = Object.fromEntries(records)
    }
    return { tables, global: this.state.global }
  }

  async getRecord(table: string, key: string): Promise<unknown | undefined> {
    this.assertOpen()
    this.records(table)
    return (await this.readState()).tables.get(table)?.get(key)
  }

  async updateRecord(
    table: string,
    key: string,
    update: (current: unknown) => unknown,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: unknown }> {
    this.assertOpen()
    this.records(table)
    return this.track(withFileLock(this.path, async () => {
      const current = await this.readState()
      const records = current.tables.get(table)
      if (records === undefined || !records.has(key)) return { found: false }
      const value = update(records.get(key))
      records.set(key, value)
      await writeAtomic(this.path, serialize(this.descriptor.name, current))
      this.replaceState(current)
      return { found: true, value }
    }))
  }

  async insertRecord(table: string, key: string, value: unknown): Promise<boolean> {
    this.assertOpen()
    this.records(table)
    return this.track(withFileLock(this.path, async () => {
      const current = await this.readState()
      const records = current.tables.get(table)
      if (records === undefined || records.has(key)) return false
      records.set(key, value)
      await writeAtomic(this.path, serialize(this.descriptor.name, current))
      this.replaceState(current)
      return true
    }))
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    this.assertOpen()
    this.records(table)
    await this.track(withFileLock(this.path, async () => {
      const current = await this.readState()
      const records = current.tables.get(table)
      if (records === undefined) {
        throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
      }
      records.set(key, value)
      await writeAtomic(this.path, serialize(this.descriptor.name, current))
      this.replaceState(current)
    }))
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    this.assertOpen()
    this.records(table)
    await this.track(withFileLock(this.path, async () => {
      const current = await this.readState()
      const records = current.tables.get(table)
      if (records === undefined) {
        throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
      }
      if (!records.has(key)) return
      records.delete(key)
      await writeAtomic(this.path, serialize(this.descriptor.name, current))
      this.replaceState(current)
    }))
  }

  async setGlobal(value: unknown): Promise<void> {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
    await this.track(withFileLock(this.path, async () => {
      const current = await this.readState()
      current.global = value
      await writeAtomic(this.path, serialize(this.descriptor.name, current))
      this.replaceState(current)
    }))
  }

  /* jscpd:ignore-start -- the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }
  /* jscpd:ignore-end */

  private records(table: string): Map<string, unknown> {
    const records = this.state.tables.get(table)
    if (!records) {
      throw new Error(`unit '${this.descriptor.name}' does not declare table '${table}'`)
    }
    return records
  }

  private emptyState(): UnitState {
    return {
      version: this.descriptor.version,
      global: null,
      tables: new Map(this.descriptor.tables.map(table => [table, new Map<string, unknown>()])),
    }
  }

  /** Read the current whole-unit document, treating a missing file as empty. */
  private async readState(): Promise<UnitState> {
    try {
      return parse(await readFile(this.path, 'utf8'), this.descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.emptyState()
    }
  }

  /** Replace this unit's read cache with the state committed by an atomic update. */
  private replaceState(next: UnitState): void {
    this.state.version = next.version
    this.state.global = next.global
    this.state.tables.clear()
    for (const [table, records] of next.tables) this.state.tables.set(table, records)
  }

  /** Keep fenced read-modify-write operations in the close drain set. */
  private track<T>(operation: Promise<T>): Promise<T> {
    const drain = operation.then(() => undefined, () => undefined)
    this.inFlight.add(drain)
    drain.then(() => this.inFlight.delete(drain), () => {})
    return operation
  }
}
