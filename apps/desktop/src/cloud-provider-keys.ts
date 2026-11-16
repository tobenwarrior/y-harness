/** Native owner approval and transfer of saved keys through the private Cloud connection. */
import {
  PROVIDER_KEY_IMPORT_PATH, providerKeyOffer, providerKeyValue,
} from '@yharness/provider-config-sync'
import type {
  ProviderKeyImportRequest, ProviderKeySourceRequest,
} from '@yharness/provider-config-sync'
import type { VaultCloudWorkspace } from './cloud-vault.ts'
import { privateHostOrigin, readBoundedJson } from './web-document.ts'

/** An approval preview bound to one Mac Host and its current Cloud connection. */
export interface CloudProviderKeyCopy {
  readonly providers: readonly string[]
  /** @returns The number of keys stored and the number that could not be copied. */
  apply(): Promise<{ copied: number; skipped: number }>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function request(cloud: VaultCloudWorkspace, body: ProviderKeyImportRequest): Promise<unknown> {
  const endpoint = new URL(PROVIDER_KEY_IMPORT_PATH, privateHostOrigin(cloud.origin))
  const response = await cloud.fetch(endpoint.href, {
    method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  const reply = await readBoundedJson(response, 16_384)
  if (!record(reply)) throw new Error('Cloud key copy is unavailable.')
  return body.action === 'prepare' ? reply.claim : reply.copied
}

/**
 * Match key-free Mac offers against Cloud before collecting consent in the shell.
 * @param source - Current Desktop Host's private child-process control channel.
 * @param cloud - Authenticated Cloud connection backed by the verified SSH session.
 * @returns Names for the approval dialog and a single approved copy operation.
 */
export async function prepareCloudProviderKeyCopy(
  source: (request: ProviderKeySourceRequest) => Promise<unknown>,
  cloud: VaultCloudWorkspace,
): Promise<CloudProviderKeyCopy> {
  privateHostOrigin(cloud.origin)
  const offers = providerKeyOffer.array().parse(await source({ action: 'offer' }))
  const ready = (await Promise.all(offers.map(async (offer) => {
    const route = { provider: offer.provider, identity: offer.identity }
    const claim = await request(cloud, { action: 'prepare', route })
    if (claim === null) return undefined
    if (typeof claim !== 'string' || !/^[a-f0-9]{64}$/u.test(claim)) throw new Error('Cloud key copy is unavailable.')
    return { route, offer, claim }
  }))).filter(entry => entry !== undefined)
  let applied = false
  return {
    providers: ready.map(({ route }) => route.provider),
    async apply() {
      if (applied) throw new Error('Review the provider key copy again.')
      applied = true
      let copied = 0
      for (const { route, offer, claim } of ready) {
        try {
          const key = providerKeyValue.safeParse(await source({ action: 'read', offer }))
          if (key.success && await request(cloud, { action: 'receive', route, claim, key: key.data }) === true) copied++
        } catch (_error) {
          // Redact transfer failures and let unaffected provider keys finish.
        }
      }
      return { copied, skipped: ready.length - copied }
    },
  }
}
