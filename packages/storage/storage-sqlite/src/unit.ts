/**
 * One opened SQLite KV unit: prepared per-table statements over the
 * `u_<unit>_<table>` record tables plus this unit's row in the shared
 * `unit_globals` table. Ordinary primitives are single statements; fenced
 * updates use a bounded-retry `BEGIN IMMEDIATE` transaction. There is no write
 * queue (write ordering is the caller's responsibility per the KV contract).
 * @module @yharness/storage-sqlite/unit
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { StorageError } from '@yharness/storage'
import type { KvUnit, KvUnitDescriptor } from '@yharness/storage'
import { recordTableName } from './schema.ts'

/** Bounded retry cadence for a second SQLite connection holding the write lock. */
const WRITE_LOCK_RETRY_INITIAL_MS = 5
const WRITE_LOCK_RETRY_MAX_MS = 100
const WRITE_LOCK_RETRY_BUDGET_MS = 2_000

/** Prepared statements for one declared table. */
interface TableStatements {
  upsert: StatementSync
  insert: StatementSync
  remove: StatementSync
  selectAll: StatementSync
  selectOne: StatementSync
}

/**
 * The SQLite {@link KvUnit}. Constructed by the backend AFTER the unit's
 * record tables exist; statements are prepared once here and reused for every
 * primitive. Values are stored as JSON text in the `value` column.
 */
export class SqliteKvUnit implements KvUnit {
  private readonly db: DatabaseSync
  private readonly tables = new Map<string, TableStatements>()
  private readonly globalUpsert: StatementSync | undefined
  private readonly globalSelect: StatementSync | undefined
  private closed = false

  /**
   * @param db - Open database handle owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   */
  constructor(
    db: DatabaseSync,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {
    this.db = db
    for (const table of descriptor.tables) {
      // Both name segments are validated against UNIT_NAME_RE by the backend,
      // so the physical identifier is safe to interpolate into statement text.
      const physical = recordTableName(descriptor.name, table)
      this.tables.set(table, {
        upsert: db.prepare(
          `INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ),
        insert: db.prepare(`INSERT OR IGNORE INTO "${physical}" (key, value) VALUES (?, ?)`),
        remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
        selectAll: db.prepare(`SELECT key, value FROM "${physical}"`),
        selectOne: db.prepare(`SELECT value FROM "${physical}" WHERE key = ?`),
      })
    }
    this.globalUpsert = descriptor.hasGlobal
      ? db.prepare(
        'INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value',
      )
      : undefined
    this.globalSelect = descriptor.hasGlobal
      ? db.prepare('SELECT value FROM unit_globals WHERE unit = ?')
      : undefined
  }

  getRecord(table: string, key: string): Promise<unknown | undefined> {
    return this.settle(() => {
      const statements = this.statementsFor(table)
      const row = statements.selectOne.get(key) as { value: string } | undefined
      return row === undefined ? undefined : this.parseValue(row.value, `table '${table}' key '${key}'`)
    })
  }

  updateRecord(
    table: string,
    key: string,
    update: (current: unknown) => unknown,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: unknown }> {
    return this.withImmediateTransaction(() => {
      const statements = this.statementsFor(table)
      const row = statements.selectOne.get(key) as { value: string } | undefined
      if (row === undefined) {
        return { found: false }
      }
      const value = update(this.parseValue(row.value, `table '${table}' key '${key}'`))
      statements.upsert.run(key, JSON.stringify(value))
      return { found: true, value }
    })
  }

  insertRecord(table: string, key: string, value: unknown): Promise<boolean> {
    return this.settle(() => this.statementsFor(table).insert.run(key, JSON.stringify(value)).changes === 1)
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(() => {
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [name, statements] of this.tables) {
        // Null prototype: record keys are arbitrary strings, so '__proto__'
        // must land as an own property instead of mutating the prototype.
        const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const row of statements.selectAll.all() as Array<{ key: string; value: string }>) {
          records[row.key] = this.parseValue(row.value, `table '${name}' key '${row.key}'`)
        }
        tables[name] = records
      }
      let global: unknown = null
      if (this.globalSelect !== undefined) {
        const row = this.globalSelect.get(this.descriptor.name) as { value: string } | undefined
        if (row !== undefined) global = this.parseValue(row.value, 'global slot')
      }
      return { tables, global }
    })
  }

  /** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
  private parseValue(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`,
        { cause: error },
      )
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).upsert.run(key, JSON.stringify(value))
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).remove.run(key)
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(() => {
      if (this.globalUpsert === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      this.globalUpsert.run(this.descriptor.name, JSON.stringify(value))
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  /**
   * Run one synchronous primitive behind the closed guard, mapping a throw to
   * a rejection so the Promise-returning contract never throws synchronously.
   */
  private settle<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      return Promise.resolve(operation())
    } catch (error) {
      // Non-Error throws can only enter through JSON.stringify propagating a
      // value's own toJSON throw; wrap those, preserve every real Error.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Acquire SQLite's write lock with bounded asynchronous retries. The
   * synchronous driver returns `database is locked` immediately when another
   * connection owns the lock, so waiting between attempts keeps the event loop
   * available for that connection to commit while still failing a permanently
   * contended medium within a fixed budget.
   */
  private async withImmediateTransaction<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      const deadline = Date.now() + WRITE_LOCK_RETRY_BUDGET_MS
      let delay = WRITE_LOCK_RETRY_INITIAL_MS
      for (;;) {
        try {
          this.db.exec('BEGIN IMMEDIATE')
        } catch (error) {
          if (!isSqliteBusy(error) || Date.now() >= deadline) throw error
          const remaining = deadline - Date.now()
          await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)))
          delay = Math.min(delay * 2, WRITE_LOCK_RETRY_MAX_MS)
          continue
        }
        try {
          const result = operation()
          this.db.exec('COMMIT')
          return result
        } catch (error: unknown) {
          try { this.db.exec('ROLLBACK') } catch (rollbackError: unknown) { void rollbackError }
          throw error
        }
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
  }

  private statementsFor(table: string): TableStatements {
    const statements = this.tables.get(table)
    if (statements === undefined) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return statements
  }
}

/** Return true only for SQLite's transient writer-lock errors. */
function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && typeof error.code === 'string'
    && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) return true
  return /database (?:is )?locked|database busy/i.test(error.message)
}
