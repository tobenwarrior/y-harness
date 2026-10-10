/** Deterministic native event identities independent of JSON key order. */
import { createHash } from 'node:crypto'

/**
 * Hash JSON source data without retaining native payloads outside display history.
 * @param value - JSON-compatible native metadata or event fields.
 * @returns a SHA-256 digest with recursively sorted object keys.
 */
export function codingSessionDigest(value: unknown): string {
  const raw = encodeNativeJson(value)
  if (raw === undefined) throw new Error('Native coding session contains non-JSON history.')
  return createHash('sha256').update(raw).digest('hex')
}

// JSON.stringify can return undefined for values outside native JSON data.
function encodeNativeJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key: string, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    }
    return item
  })
}
