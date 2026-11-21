/** Add-only provider catalog import between approved Harness workspaces. */
import type { SettingsPathOpView } from '@yharness/settings/types'
import { providerCatalogRoute, projectProvider, schemaFingerprint, unconfiguredProviderSettings } from './profile.ts'

/** Safe settings changes planned against the destination's current revision. */
export interface ProviderCatalogCopyPlan {
  readonly revision: number
  readonly changes: readonly SettingsPathOpView[]
  readonly retained: number
  readonly skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function describe(value: unknown): { namespace: Record<string, unknown>; writable: boolean } {
  if (!isRecord(value) || !Array.isArray(value.namespaces)) throw new Error('Invalid provider catalog response')
  const namespaces: readonly unknown[] = value.namespaces
  const namespace = namespaces.find((row): row is Record<string, unknown> => isRecord(row) && row.ns === 'llm-pi-ai')
  if (namespace === undefined || !isRecord(namespace.schema)) throw new Error('Provider catalogs are unavailable')
  return { namespace, writable: value.writable === true }
}

function providers(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value) || (value.providers !== undefined && !isRecord(value.providers))) {
    throw new Error('Invalid provider catalog settings')
  }
  return value.providers ?? {}
}

/**
 * Copy explicitly configured model catalogs to missing destination routes.
 * @param source - Redacted Settings describe response from the source Host.
 * @param destination - Redacted Settings describe response from the destination Host.
 * @returns Add-only edits carrying fresh target-local credential references and their revision.
 */
export function planProviderCatalogCopy(source: unknown, destination: unknown): ProviderCatalogCopyPlan {
  const from = describe(source).namespace
  const to = describe(destination)
  const revision = to.namespace.revision
  if (!to.writable || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Cloud provider settings are read-only')
  }
  if (schemaFingerprint(from.schema) !== schemaFingerprint(to.namespace.schema)) {
    throw new Error('Provider catalogs require compatible versions')
  }
  const current = providers(to.namespace.value)
  const inherited = providers(to.namespace.base)
  const user = providers(to.namespace.user)
  const changes: SettingsPathOpView[] = []
  let retained = 0
  let skipped = 0
  for (const [id, raw] of Object.entries(providers(from.user))) {
    if (Object.hasOwn(current, id) || Object.hasOwn(inherited, id) || Object.hasOwn(user, id)) {
      retained++
      continue
    }
    try {
      const profile = providerCatalogRoute.safeParse(id).success
        ? unconfiguredProviderSettings(id, projectProvider(raw)) : undefined
      if (profile === undefined) skipped++
      else changes.push({ op: 'set', path: ['providers', id], value: profile })
    } catch (_error) {
      // Unsupported route values can include secrets. Report only their count.
      skipped++
    }
  }
  if (Buffer.byteLength(JSON.stringify(changes)) > 1024 * 1024) {
    throw new Error('Provider catalog copy exceeds the supported size')
  }
  return { revision, changes, retained, skipped }
}
