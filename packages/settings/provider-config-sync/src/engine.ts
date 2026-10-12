/** Locked three-way synchronization of explicit provider catalog configuration. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'
import { canonicalJson, hasExcludedModelFields, parseProvider, projectProvider, providerFields, schemaFingerprint } from './profile.ts'
import type { ProviderProfile } from './profile.ts'

/** Active explicit configuration and its current write revision. */
export interface LocalNamespace {
  schema: unknown
  revision: number
  providers: Record<string, unknown>
  inherited: Record<string, unknown>
}
/** Settings-owned capabilities; the engine never reads credential stores. */
export interface EngineOptions {
  sharedPath: string
  receiptPath: string
  read(): LocalNamespace | undefined
  mutate(ops: SettingsPathOpView[], revision: number): Promise<void>
}
/** Safe observable result; conflict identities contain no configuration values. */
export interface SyncStatus { state: 'ready' | 'pending' | 'conflict' | 'unconfigured' | 'error'; conflicts: string[] }

const route = z.string().regex(/^[a-z][a-z0-9-]{0,127}$/)
const record = z.strictObject({
  revision: z.number().int().nonnegative(), value: z.unknown().transform(value => value === null ? null : parseProvider(value)),
})
const records = z.record(route, record)
const documentSchema = z.strictObject({
  version: z.literal(1), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(), providers: records,
})
const receiptSchema = z.strictObject({ version: z.literal(1), schemaFingerprint: z.string(), sharedPath: z.string(), providers: records })
type ProviderRecord = z.infer<typeof record>
type SharedDocument = z.infer<typeof documentSchema>
type JsonValue = Extract<SettingsPathOpView, { op: 'set' }>['value']
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const MAX_DOCUMENT_BYTES = 1024 * 1024

function serialize(value: unknown): string {
  const text = canonicalJson(value) + '\n'
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error('Provider synchronization file exceeds supported size')
  return text
}

async function readDocument<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new Error('Provider synchronization file must be a bounded owner-only regular file')
  }
  try { return schema.parse(JSON.parse(await readFile(path, 'utf8'))) }
  catch { throw new Error('Unsupported shared provider configuration') }
}

function projection(providers: Record<string, unknown>): Record<string, ProviderProfile> {
  return Object.fromEntries(Object.entries(providers).map(([id, value]) => {
    if (!route.safeParse(id).success) throw new Error('Unsupported local provider identity')
    return [id, projectProvider(value)]
  }))
}

function importOps(id: string, local: LocalNamespace, value: ProviderProfile | null): SettingsPathOpView[] | undefined {
  const raw = local.providers[id]
  if (value === null) {
    if (Object.hasOwn(local.inherited, id)) return undefined
    if (raw !== undefined
      && Object.keys(raw as object).some(key => !(providerFields as readonly string[]).includes(key))) return undefined
    const profile = raw as Record<string, unknown> | undefined
    if (Array.isArray(profile?.models) && profile.models.some(model => hasExcludedModelFields(model))) return undefined
    if (profile?.modelOverrides !== undefined
      && Object.values(profile.modelOverrides as Record<string, unknown>)
        .some(model => hasExcludedModelFields(model, true))) return undefined
    // The caller only imports a tombstone when its explicit local route exists.
    return [{ op: 'unset', path: ['providers', id] }]
  }
  if (raw === undefined) {
    if (Object.hasOwn(local.inherited, id)) return undefined
    // Nous requires grant-bound local setup and forbids the missing-key guard.
    if (id === 'nous' || id === 'chatgpt') return undefined
    const apiKeyEnv = `YH_SYNC_UNCONFIGURED_${randomUUID().replaceAll('-', '').toUpperCase()}`
    return [{ op: 'set', path: ['providers', id], value: { ...value, apiKeyEnv } as JsonValue }]
  }
  const before = projectProvider(raw)
  // Existing authorization must never be redirected by a remote endpoint change.
  if (!equal(before.api, value.api) || !equal(before.baseURL, value.baseURL)) return undefined
  const source = raw as Record<string, unknown>
  if (!equal(before.models, value.models) && Array.isArray(source.models)
    && source.models.some(model => hasExcludedModelFields(model))) return undefined
  if (!equal(before.modelOverrides, value.modelOverrides) && source.modelOverrides !== undefined
    && Object.values(source.modelOverrides as Record<string, unknown>).some(model => hasExcludedModelFields(model, true))) return undefined
  return providerFields.flatMap((field): SettingsPathOpView[] => {
    if (equal(before[field], value[field])) return []
    return value[field] === undefined ? [{ op: 'unset', path: ['providers', id, field] }]
      : [{ op: 'set', path: ['providers', id, field], value: value[field] as JsonValue }]
  })
}

/** Each pass owns the shared lock through local reconciliation and receipt commit. */
export class ProviderSyncEngine {
  /** Bind one local Settings owner to its explicitly paired shared document.
   * @param options Local read/write capabilities and separate absolute file paths.
   */
  constructor(private readonly options: EngineOptions) {
    if (!isAbsolute(options.sharedPath) || !isAbsolute(options.receiptPath) || options.sharedPath === options.receiptPath) {
      throw new Error('Provider synchronization needs distinct absolute shared and local receipt paths')
    }
  }

  /** Synchronize without treating namespace absence or file removal as deletions.
   * @returns Confirmed readiness, pending availability, or preserved provider conflicts.
   */
  async synchronize(): Promise<SyncStatus> {
    if (this.options.read() === undefined) return { state: 'pending', conflicts: [] }
    await mkdir(dirname(this.options.sharedPath), { recursive: true, mode: 0o700 })
    const path = join(await realpath(dirname(this.options.sharedPath)), basename(this.options.sharedPath))
    return withFileLock(path, async () => {
      const local = this.options.read()
      if (local === undefined) return { state: 'pending', conflicts: [] }
      const fingerprint = schemaFingerprint(local.schema)
      const receipt = await readDocument(this.options.receiptPath, receiptSchema)
      const stored = await readDocument(path, documentSchema)
      if (receipt !== undefined && (receipt.sharedPath !== path || receipt.schemaFingerprint !== fingerprint)
        || stored !== undefined && stored.schemaFingerprint !== fingerprint) throw new Error('Provider configuration schemas do not match')
      if (stored === undefined && receipt !== undefined) throw new Error('Shared provider configuration is missing; restore it before synchronizing')
      const shared: SharedDocument = stored ?? { version: 1, schemaFingerprint: fingerprint, revision: 0, providers: {} }
      const baseline = receipt?.providers ?? {}
      if (Object.keys(baseline).some(id => !Object.hasOwn(shared.providers, id))) throw new Error('Shared provider records were removed without tombstones')
      const current = projection(local.providers)
      const conflicts: string[] = []
      const ops: SettingsPathOpView[] = []
      const nextBaseline = { ...baseline }
      let changed = stored === undefined
      for (const id of new Set([...Object.keys(current), ...Object.keys(shared.providers), ...Object.keys(baseline)])) {
        const localValue = current[id] ?? null
        let remote = shared.providers[id]
        const common = baseline[id]
        const localChanged = common === undefined ? localValue !== null : !equal(localValue, common.value)
        const remoteChanged = remote !== undefined && (common === undefined || !equal(remote.value, common.value))
        if (localChanged && remoteChanged && !equal(localValue, remote?.value)) { conflicts.push(id); continue }
        if (localChanged && !equal(localValue, remote?.value)) {
          shared.revision++
          remote = { revision: shared.revision, value: localValue }
          shared.providers[id] = remote
          changed = true
        } else if (remote !== undefined && !equal(localValue, remote.value)) {
          const edits = importOps(id, local, remote.value)
          if (edits === undefined) { conflicts.push(id); continue }
          ops.push(...edits)
        }
        // Every union member was already shared or published above; missing baseline rows are refused.
        nextBaseline[id] = remote as ProviderRecord
      }
      const nextReceipt = { version: 1, schemaFingerprint: fingerprint, sharedPath: path, providers: nextBaseline }
      // Bound both complete outputs before any shared or local commit.
      const sharedText = serialize(shared)
      serialize(nextReceipt)
      if (changed) await writeFileAtomic(path, sharedText, { mode: 0o600 })
      if (ops.length) await this.options.mutate(ops, local.revision)
      const after = this.options.read()
      if (after === undefined || schemaFingerprint(after.schema) !== fingerprint) return { state: 'pending', conflicts }
      const finalProfiles = projection(after.providers)
      // A failed/reverted local apply must never advance its baseline.
      for (const [id, candidate] of Object.entries(nextBaseline)) {
        if (!equal(finalProfiles[id] ?? null, candidate.value)) {
          if (baseline[id] === undefined) Reflect.deleteProperty(nextBaseline, id)
          else nextBaseline[id] = baseline[id]
          if (!conflicts.includes(id)) conflicts.push(id)
        }
      }
      await mkdir(dirname(this.options.receiptPath), { recursive: true, mode: 0o700 })
      if (!equal(receipt, nextReceipt)) await writeFileAtomic(this.options.receiptPath, serialize(nextReceipt), { mode: 0o600 })
      return { state: conflicts.length ? 'conflict' : 'ready', conflicts: conflicts.sort() }
    })
  }
}
