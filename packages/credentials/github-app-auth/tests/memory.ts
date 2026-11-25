import { CredentialProvider } from '@yharness/credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@yharness/credentials'

/** Serialized in-memory record provider used by the GitHub authorization tests. */
export class MemoryCredentials extends CredentialProvider {
  private readonly records = new Map<CredentialKey, CredentialRecord>()
  private tail = Promise.resolve()

  /** Replace the backing value as a second process could while a request is in flight. */
  replaceFromOtherProcess(key: CredentialKey, record: CredentialRecord): void {
    this.records.set(key, record)
  }

  /** Remove a backing value as a second process could while a request is in flight. */
  deleteFromOtherProcess(key: CredentialKey): void {
    this.records.delete(key)
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(undefined)
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override set(_ref: CredentialRef, _value: string): Promise<void> {
    return Promise.resolve()
  }

  override unset(_ref: CredentialRef): Promise<void> {
    return Promise.resolve()
  }

  override readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  override describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const stored = this.records.get(key)
    return Promise.resolve(stored === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: stored.kind, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  override modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const run = this.tail.then(async () => {
      const current = this.records.get(key)
      const next = await mutate(current)
      if (next !== undefined) {
        this.records.set(key, next)
        this.ctx.emit('credentials/record-updated', key)
        return next
      }
      return current
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  override deleteRecord(key: CredentialKey): Promise<void> {
    const run = this.tail.then(() => {
      if (this.records.delete(key)) this.ctx.emit('credentials/record-updated', key)
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
