/** Native Mac-to-Cloud catalog copy over the two authenticated Hosts. */
import { randomUUID } from 'node:crypto'
import { planProviderCatalogCopy } from '@yharness/provider-config-sync'
import type { VaultCloudWorkspace } from './cloud-vault.ts'
import { readBoundedJson } from './web-document.ts'

const SETTINGS_REPLY_BYTES = 8 * 1024 * 1024
const COPY_TIMEOUT_MS = 10_000

/** An add-only preview that stays bound to the same destination. */
export interface CloudProviderCatalogCopy {
  readonly additions: number
  readonly retained: number
  readonly skipped: number
  apply(): Promise<void>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localOrigin(value: string): string {
  const url = new URL(value)
  if (url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') {
    throw new Error('The provider catalog copy requires private local connections')
  }
  return url.origin
}

async function request(peer: VaultCloudWorkspace, method: 'describe' | 'mutate', args: object = {}): Promise<unknown> {
  const rpcId = randomUUID()
  const name = 'settings/' + method
  const response = await peer.fetch(new URL('/api/' + name, localOrigin(peer.origin)).href, {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: name, payload: { args } }),
    signal: AbortSignal.timeout(COPY_TIMEOUT_MS),
  })
  const reply = await readBoundedJson(response, SETTINGS_REPLY_BYTES)
  if (!record(reply) || reply.type !== 'server-response' || reply.rpcId !== rpcId
    || !record(reply.result) || reply.result.ok !== true) throw new Error('Provider settings are unavailable')
  return reply.result.value
}

/**
 * Read catalogs before asking the owner to approve their copy.
 * @param mac - Current authenticated Mac workspace.
 * @param cloud - Current authenticated Cloud workspace.
 * @returns Copy counts and the exact revision-checked write.
 */
export async function prepareCloudProviderCatalogCopy(
  mac: VaultCloudWorkspace, cloud: VaultCloudWorkspace,
): Promise<CloudProviderCatalogCopy> {
  if (localOrigin(mac.origin) === localOrigin(cloud.origin)) throw new Error('Choose a separate Cloud workspace')
  const [source, target] = await Promise.all([request(mac, 'describe'), request(cloud, 'describe')])
  const plan = planProviderCatalogCopy(source, target)
  return {
    additions: plan.changes.length,
    retained: plan.retained,
    skipped: plan.skipped,
    async apply() {
      if (plan.changes.length === 0) return
      await request(cloud, 'mutate', { ns: 'llm-pi-ai', ops: plan.changes, expectedRevision: plan.revision })
    },
  }
}
