/** Ordinary provider catalog data; authentication stays owned by each profile. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const effort = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const modelFields = {
  name: z.string().max(512).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  input: z.array(z.enum(['text', 'image'])).max(2).optional(),
  reasoningEfforts: z.union([z.literal(false), z.partialRecord(effort, z.union([z.string().max(128), z.null()]))]).optional(),
  defaultReasoning: effort.optional(),
}
const model = { id: z.string().min(1).max(512), ...modelFields }
const endpoint = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !value.includes('?') && !value.includes('#')
  } catch { return false }
})
const fields = {
  displayName: z.string().max(512).optional(),
  api: z.string().min(1).max(128).optional(),
  baseURL: endpoint.optional(),
}
const sharedProvider = z.strictObject({
  ...fields,
  models: z.array(z.strictObject(model)).max(4096).optional(),
  modelOverrides: z.record(z.string().min(1).max(512), z.strictObject(modelFields)).optional(),
})
const localProvider = z.object({
  ...fields,
  models: z.array(z.object(model)).max(4096).optional(),
  modelOverrides: z.record(z.string().min(1).max(512), z.object(modelFields)).optional(),
})

/** Only these ordinary fields may cross the shared-file boundary. */
export const providerFields = ['displayName', 'api', 'baseURL', 'models', 'modelOverrides'] as const
/** Safe ordinary provider projection; excluded fields are never included. */
export type ProviderProfile = z.infer<typeof sharedProvider>

/** Project an explicit local provider profile without access or unknown fields.
 * @param value Explicit local profile whose excluded fields stay local.
 * @returns A detached ordinary catalog projection.
 */
export function projectProvider(value: unknown): ProviderProfile {
  const result = localProvider.safeParse(value)
  if (!result.success) throw new Error(result.error.issues.some(issue => issue.path[0] === 'baseURL')
    ? 'Provider endpoint is not safe to synchronize' : 'Unsupported local provider configuration')
  return result.data
}

/** Reject unrecognized shared fields, including excluded nested model fields.
 * @param value Shared profile candidate.
 * @returns The validated ordinary provider profile.
 */
export function parseProvider(value: unknown): ProviderProfile {
  const result = sharedProvider.safeParse(value)
  if (!result.success) throw new Error('Unsupported shared provider configuration')
  return result.data
}

/** Stable object-key ordering preserves array order for catalog comparisons.
 * @param value JSON-shaped value to encode.
 * @returns Its canonical JSON representation.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, entry: unknown) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
}

/** Bind synchronization to the active schema, normalizing process-local node identities.
 * @param value Serialized schema envelope, or an ordinary JSON-shaped identity.
 * @returns A SHA-256 fingerprint of the normalized structure.
 */
export function schemaFingerprint(value: unknown): string {
  const envelope = value as { uid?: unknown; refs?: Record<string, Record<string, unknown>> } | null
  let normalized = value
  if (envelope !== null && typeof envelope === 'object' && typeof envelope.uid === 'number' && envelope.refs !== undefined) {
    const refs = envelope.refs
    const seen = new Map<number, number>()
    const walk = (uid: number): unknown => {
      const known = seen.get(uid)
      if (known !== undefined) return { $ref: known }
      const index = seen.size
      seen.set(uid, index)
      const node = refs[uid]
      if (node === undefined) throw new Error('Unsupported provider configuration schema')
      const result: Record<string, unknown> = { $id: index, ...node }
      for (const key of ['inner', 'sKey']) if (typeof node[key] === 'number') result[key] = walk(node[key])
      if (Array.isArray(node.list)) result.list = node.list.map(uid => walk(uid as number))
      if (node.dict !== undefined) result.dict = Object.fromEntries(Object.entries(node.dict as Record<string, number>)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, uid]) => [key, walk(uid)]))
      return result
    }
    normalized = walk(envelope.uid)
  }
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex')
}

/** Detect local-only model fields without examining their values.
 * @param value Local model configuration.
 * @param override Whether the model ID lives in the parent dictionary key.
 * @returns Whether synchronizing a replacement would discard excluded fields.
 */
export function hasExcludedModelFields(value: unknown, override = false): boolean {
  const allowed = new Set([...Object.keys(modelFields), ...override ? [] : ['id']])
  return value === null || typeof value !== 'object' || Object.keys(value).some(key => !allowed.has(key))
}
