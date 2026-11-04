import { randomUUID } from '@yharness/util-crypto'

const STORAGE_PREFIX = 'yharness.client-ui-bots.shared-group-pending'
const LOCK_PREFIX = 'yharness.client-ui-bots.shared-group-pending-lock'
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const MAX_TEXT_LENGTH = 16_384
const PRINCIPAL_SCOPE_PATTERN = /^principal-[A-Za-z0-9-]+$/

/** Maximum number of pending records retained for one authenticated principal. */
export const SHARED_GROUP_PENDING_QUEUE_MAX_RECORDS = 128

/** Raised when retaining another retry record could exceed the safe local quota. */
export class SharedGroupPendingQueueFullError extends Error {
  constructor() {
    super('Shared-group retry storage quota reached')
    this.name = 'SharedGroupPendingQueueFullError'
  }
}

interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

interface PendingCreationRecord {
  readonly version: 1
  readonly kind: 'creation'
  readonly status: 'pending' | 'expired'
  readonly id: string
  readonly operationHash: string
  readonly name: string
  readonly botIds: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
}

interface PendingMessageRecord {
  readonly version: 1
  readonly kind: 'message'
  readonly status: 'pending' | 'expired'
  readonly id: string
  readonly operationHash: string
  readonly groupId: string
  readonly text?: string
  readonly createdAt: number
  readonly expiresAt: number
}

type PendingRecord = PendingCreationRecord | PendingMessageRecord

/** Durable shared-group creation retry metadata visible to the current principal. */
export interface SharedPendingGroupCreation {
  readonly operationHash: string
  readonly id: string
  readonly name: string
  readonly botIds: readonly string[]
  readonly createdAt: number
  readonly expiresAt: number
  readonly expired: boolean
}

/** Durable shared-group message retry metadata visible to the current principal. */
export interface SharedPendingGroupMessage {
  readonly operationHash: string
  readonly id: string
  readonly groupId: string
  /** Present until the record expires; expired tombstones never retain message text. */
  readonly text?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly expired: boolean
}

/** Stable operation reservation returned by the browser retry queue. */
export interface SharedPendingGroupReservation {
  readonly operationHash: string
  readonly id: string
  readonly recovered: boolean
  readonly expired: boolean
}

/** Per-operation browser persistence for shared-group retries. */
export interface SharedGroupPendingQueue {
  /** Whether this browser can safely persist and coordinate retry records. */
  readonly durable: boolean
  /** List interrupted group creations and explicit expiry tombstones for this principal. */
  listCreations(): Promise<readonly SharedPendingGroupCreation[]>
  /** List pending group messages and text-free expired tombstones for this principal. */
  listMessages(): Promise<readonly SharedPendingGroupMessage[]>
  /** Reserve or recover one stable group id for a creation operation. */
  reserveCreation(operationKey: string, name: string, botIds: readonly string[]): Promise<SharedPendingGroupReservation>
  /** Remove one creation record only when its id still matches. */
  removeCreation(operationHash: string, id: string): Promise<void>
  /** Reserve or recover one stable message id for a group message operation. */
  reserveMessage(operationKey: string, groupId: string, text: string): Promise<SharedPendingGroupReservation>
  /** Remove one message record only when its operation hash and id still match. */
  removeMessage(operationHash: string, id: string): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
}

function parseRecord(value: unknown): PendingRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || !isSafeId(value.id)
    || typeof value.operationHash !== 'string' || !/^[0-9a-f-]{8,128}$/.test(value.operationHash)
    || !isSafeTimestamp(value.createdAt) || !isSafeTimestamp(value.expiresAt) || value.expiresAt < value.createdAt) return undefined
  const status = value.status === undefined ? 'pending' : value.status
  if (status !== 'pending' && status !== 'expired') return undefined
  if (value.kind === 'creation') {
    if (typeof value.name !== 'string' || value.name.trim() === '' || value.name.length > 256
      || !Array.isArray(value.botIds) || value.botIds.length < 2 || value.botIds.length > 6) return undefined
    const botIds: string[] = []
    for (const botId of value.botIds) {
      if (!isSafeId(botId)) return undefined
      botIds.push(botId)
    }
    return {
      version: 1,
      kind: 'creation',
      status,
      id: value.id,
      operationHash: value.operationHash,
      name: value.name,
      botIds,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
    }
  }
  if (value.kind !== 'message' || typeof value.groupId !== 'string' || !isSafeId(value.groupId)) return undefined
  if (status === 'pending' && (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT_LENGTH)) return undefined
  if (status === 'expired' && value.text !== undefined) return undefined
  return {
    version: 1,
    kind: 'message',
    status,
    id: value.id,
    operationHash: value.operationHash,
    groupId: value.groupId,
    ...(status === 'pending' && typeof value.text === 'string' ? { text: value.text } : {}),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  }
}

function getStorage(): StorageLike | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined
  try {
    const storage = globalThis.localStorage
    const probeKey = `${STORAGE_PREFIX}.probe`
    storage.setItem(probeKey, '1')
    storage.removeItem(probeKey)
    return storage
  } catch {
    return undefined
  }
}

function getLocks(): LockManagerLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  const candidate = navigator as Navigator & { readonly locks?: LockManagerLike }
  return candidate.locks
}

function encodeScope(scope: string): string {
  return encodeURIComponent(scope)
}

function scopePrefix(scope: string): string {
  return `${STORAGE_PREFIX}.${encodeScope(scope)}`
}

function recordKey(scope: string, kind: PendingRecord['kind'], operationHash: string): string {
  return `${scopePrefix(scope)}.${kind}.${operationHash}`
}

function lockKey(scope: string, kind: PendingRecord['kind'], operationHash: string): string {
  return `${LOCK_PREFIX}.${encodeScope(scope)}.${kind}.${operationHash}`
}

function catalogLockKey(scope: string): string {
  return `${LOCK_PREFIX}.${encodeScope(scope)}.catalog`
}

async function operationHash(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle !== undefined) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function creationView(record: PendingCreationRecord): SharedPendingGroupCreation {
  return {
    operationHash: record.operationHash,
    id: record.id,
    name: record.name,
    botIds: [...record.botIds],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expired: record.status === 'expired',
  }
}

function messageView(record: PendingMessageRecord): SharedPendingGroupMessage {
  return {
    operationHash: record.operationHash,
    id: record.id,
    groupId: record.groupId,
    ...(record.text === undefined ? {} : { text: record.text }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expired: record.status === 'expired',
  }
}

/**
 * Create a scoped, per-operation retry queue. The queue refuses to persist when
 * localStorage or Web Locks is unavailable, so callers never claim a retry is safe
 * without both durable storage and cross-tab coordination.
 * @param scope - Server-issued principal identifier used to partition local data.
 * @returns Shared-group retry queue for that principal.
 */
export function createSharedGroupPendingQueue(scope: string): SharedGroupPendingQueue {
  if (!PRINCIPAL_SCOPE_PATTERN.test(scope)) throw new Error('Shared-group retry scope is invalid')
  const storage = getStorage()
  const locks = getLocks()
  let healthy = storage !== undefined && locks !== undefined

  const withLock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    if (!healthy || storage === undefined || locks === undefined) throw new Error('Shared-group retry storage is unavailable')
    try {
      return await locks.request(name, work)
    } catch (cause: unknown) {
      if (!(cause instanceof SharedGroupPendingQueueFullError)) healthy = false
      throw cause
    }
  }

  const read = (key: string): PendingRecord | undefined => {
    if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
    const raw = storage.getItem(key)
    if (raw === null) return undefined
    try {
      return parseRecord(JSON.parse(raw))
    } catch {
      return undefined
    }
  }

  const remove = (key: string): void => {
    if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
    storage.removeItem(key)
  }

  const write = (key: string, record: PendingRecord): void => {
    if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
    storage.setItem(key, JSON.stringify(record))
  }

  const ensureCapacity = (key: string): void => {
    if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
    let count = 0
    for (let index = 0; index < storage.length; index += 1) {
      const candidate = storage.key(index)
      if (candidate !== null && candidate.startsWith(`${scopePrefix(scope)}.`)) count += 1
    }
    if (count >= SHARED_GROUP_PENDING_QUEUE_MAX_RECORDS && storage.getItem(key) === null) {
      throw new SharedGroupPendingQueueFullError()
    }
  }

  const prune = async (): Promise<void> => {
    if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
    const now = Date.now()
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(`${scopePrefix(scope)}.`)) keys.push(key)
    }
    for (const key of keys) {
      const record = read(key)
      if (record === undefined) {
        remove(key)
      } else if (record.status === 'pending' && record.expiresAt <= now) {
        if (record.kind === 'creation') {
          write(key, { ...record, status: 'expired' })
        } else {
          const { text: _text, ...tombstone } = record
          write(key, { ...tombstone, status: 'expired' })
        }
      }
    }
  }

  return {
    get durable(): boolean { return healthy },
    listCreations: () => withLock(catalogLockKey(scope), async () => {
      await prune()
      if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
      const records: SharedPendingGroupCreation[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key === null || !key.startsWith(`${scopePrefix(scope)}.creation.`)) continue
        const record = read(key)
        if (record?.kind === 'creation') records.push(creationView(record))
      }
      return records.sort((left, right) => left.createdAt - right.createdAt)
    }),
    listMessages: () => withLock(catalogLockKey(scope), async () => {
      await prune()
      if (storage === undefined) throw new Error('Shared-group retry storage is unavailable')
      const records: SharedPendingGroupMessage[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key === null || !key.startsWith(`${scopePrefix(scope)}.message.`)) continue
        const record = read(key)
        if (record?.kind === 'message') records.push(messageView(record))
      }
      return records.sort((left, right) => left.createdAt - right.createdAt)
    }),
    reserveCreation: async (operationKey, name, botIds) => {
      const hash = await operationHash(operationKey)
      const canonicalBotIds = [...botIds].sort()
      return withLock(lockKey(scope, 'creation', hash), async () => {
        await prune()
        const key = recordKey(scope, 'creation', hash)
        const current = read(key)
        const now = Date.now()
        if (current?.kind === 'creation'
          && current.name === name && current.botIds.length === canonicalBotIds.length
          && current.botIds.every((botId, index) => botId === canonicalBotIds[index])) {
          return { operationHash: hash, id: current.id, recovered: true, expired: current.status === 'expired' }
        }
        ensureCapacity(key)
        const record: PendingCreationRecord = {
          version: 1,
          kind: 'creation',
          status: 'pending',
          id: `bot-group-${randomUUID()}`,
          operationHash: hash,
          name,
          botIds: canonicalBotIds,
          createdAt: now,
          expiresAt: now + PENDING_TTL_MS,
        }
        write(key, record)
        return { operationHash: hash, id: record.id, recovered: false, expired: false }
      })
    },
    removeCreation: (hash, id) => withLock(lockKey(scope, 'creation', hash), async () => {
      const key = recordKey(scope, 'creation', hash)
      const current = read(key)
      if (current?.kind === 'creation' && current.id === id) remove(key)
    }),
    reserveMessage: async (operationKey, groupId, text) => {
      const hash = await operationHash(operationKey)
      return withLock(lockKey(scope, 'message', hash), async () => {
        await prune()
        const key = recordKey(scope, 'message', hash)
        const current = read(key)
        const now = Date.now()
        if (current?.kind === 'message' && current.groupId === groupId
          && (current.status === 'expired' || current.text === text)) {
          return { operationHash: hash, id: current.id, recovered: true, expired: current.status === 'expired' }
        }
        ensureCapacity(key)
        const record: PendingMessageRecord = {
          version: 1,
          kind: 'message',
          status: 'pending',
          id: `bot-group-message-${randomUUID()}`,
          operationHash: hash,
          groupId,
          text,
          createdAt: now,
          expiresAt: now + PENDING_TTL_MS,
        }
        write(key, record)
        return { operationHash: hash, id: record.id, recovered: false, expired: false }
      })
    },
    removeMessage: (hash, id) => withLock(lockKey(scope, 'message', hash), async () => {
      const key = recordKey(scope, 'message', hash)
      const current = read(key)
      if (current?.kind === 'message' && current.id === id) remove(key)
    }),
  }
}
