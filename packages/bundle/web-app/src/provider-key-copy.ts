/** Scoped Mac provider-key reads and add-only Cloud provider-key writes. */
import { createHash } from 'node:crypto'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import { isIP } from 'node:net'
import type { CredentialProvider, CredentialRef } from '@yharness/credentials'
import { assertUsableApiKey } from '@yharness/llm'
import { recordKeyFor, resolveProfiles } from '@yharness/llm-pi-ai'
import {
  PROVIDER_KEY_IMPORT_PATH, providerKeyImportRequest, providerKeyRoute, providerKeySourceRequest, providerKeyValue,
} from '@yharness/provider-config-sync'
import type { ProviderKeyOffer, ProviderKeyRoute } from '@yharness/provider-config-sync'
import type {} from '@yharness/settings'

type TransferCredentials = Pick<CredentialProvider, 'describe' | 'describeRecord' | 'readRecord' | 'resolve' | 'setIfAbsent'>
type Settings = { readonly revision: number; readonly value: unknown }
type ResolvedRoute = ProviderKeyRoute & { readonly ref?: CredentialRef }

const MISSING_COPY_REFERENCE = /^YH_SYNC_UNCONFIGURED_[0-9A-F]{32}$/u
const ADAPTER = 'llm-pi-ai'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function providers(value: unknown): Record<string, unknown> {
  return record(value) && record(value.providers) ? value.providers : {}
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function routeFor(provider: string, value: unknown): ResolvedRoute | undefined {
  if (!record(value) || !providerKeyRoute.shape.provider.safeParse(provider).success
    || provider === 'nous' || provider === 'chatgpt') return undefined
  try {
    const profile = resolveProfiles({ [provider]: value }, 'deferred').get(provider)
    const models = profile?.piProvider?.getModels()
    if (profile?.piProvider?.auth.apiKey === undefined || models === undefined || models.length === 0) return undefined
    const endpoints = new Set<string>()
    for (const model of models) {
      const url = new URL(model.baseUrl)
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
        || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || isIP(url.hostname.replace(/^\[|\]$/gu, '')) !== 0
        || model.baseUrl.includes('?') || model.baseUrl.includes('#')) return undefined
      endpoints.add(JSON.stringify([model.api, url.href]))
    }
    return {
      provider, identity: digest([provider, [...endpoints].sort()]),
      ...profile.apiKeyEnv === undefined ? {} : { ref: profile.apiKeyEnv },
    }
  } catch (_error) {
    return undefined
  }
}

function sourceClaim(route: ResolvedRoute, revision: number): string {
  return digest([route.provider, route.identity, revision, route.ref ?? null])
}

function keyValue(raw: string | undefined, provider: string): string | undefined {
  if (raw === undefined || !providerKeyValue.safeParse(raw).success) return undefined
  try { return assertUsableApiKey(raw, ADAPTER, provider) } catch (_error) { return undefined }
}

/** Presents key-copy candidates and rechecks the live provider before resolving or saving a key. */
export class ProviderKeyTransfer {
  /**
   * @param settings - Current settings of the active pi-ai adapter.
   * @param credentials - This workspace's credential store.
   */
  constructor(
    private readonly settings: () => Settings | undefined,
    private readonly credentials: TransferCredentials,
  ) {}

  /**
   * Find saved API keys the owner can approve for copying.
   * @returns Portable source route identities, without keys or credential references.
   */
  async offer(): Promise<ProviderKeyOffer[]> {
    const snapshot = this.settings()
    if (snapshot === undefined) return []
    const routes: ProviderKeyOffer[] = []
    for (const [provider, value] of Object.entries(providers(snapshot.value))) {
      const route = routeFor(provider, value)
      if (route === undefined) continue
      if (route.ref === undefined) {
        if (await this.storedKey(route.provider) === undefined) continue
      } else {
        const state = await this.credentials.describe(route.ref)
        if (!state.configured || state.source !== 'file') continue
      }
      routes.push({ provider: route.provider, identity: route.identity, sourceClaim: sourceClaim(route, snapshot.revision) })
    }
    return routes
  }

  /**
   * Resolve a stored key through the private Desktop IPC after approval.
   * @param offer - The source route and key binding previously shown for approval.
   * @returns The current single API key, if its route still matches.
   */
  async readKey(offer: ProviderKeyOffer): Promise<string | undefined> {
    const snapshot = this.settings()
    if (snapshot === undefined) return undefined
    const route = routeFor(offer.provider, providers(snapshot.value)[offer.provider])
    if (route === undefined || offer.identity !== route.identity
      || offer.sourceClaim !== sourceClaim(route, snapshot.revision)) return undefined
    const key = await this.sourceKey(route)
    return this.settings()?.revision === snapshot.revision ? key : undefined
  }

  private async sourceKey(route: ResolvedRoute): Promise<string | undefined> {
    if (route.ref === undefined) return this.storedKey(route.provider)
    const source = await this.credentials.resolve(route.ref)
    return source?.source === 'file' ? keyValue(source.value, route.provider) : undefined
  }

  /**
   * Check whether a copied Cloud route is ready to accept a key.
   * @param binding - Mac provider and endpoint identity.
   * @returns The exact destination revision's claim, or undefined when unavailable.
   */
  async prepare(binding: ProviderKeyRoute): Promise<string | undefined> {
    const destination = await this.destination(binding)
    return destination?.claim
  }

  /**
   * Add a key to the same empty Cloud route shown in the approval preview.
   * @param binding - Mac provider and endpoint identity.
   * @param claim - Claim returned for the destination preview.
   * @param raw - Single API key, received over the owner's private connection.
   * @returns Whether the destination stored the key.
   */
  async receive(binding: ProviderKeyRoute, claim: string, raw: string): Promise<boolean> {
    const key = keyValue(raw, binding.provider)
    if (key === undefined) return false
    const destination = await this.destination(binding)
    if (destination?.claim !== claim || this.credentials.setIfAbsent === undefined) return false
    return this.credentials.setIfAbsent(destination.ref, key)
  }

  private async storedKey(provider: string): Promise<string | undefined> {
    const record = await this.credentials.readRecord(recordKeyFor(provider))
    return record?.kind === 'api-key' && record.env === undefined ? keyValue(record.key, provider) : undefined
  }

  private async destination(binding: ProviderKeyRoute): Promise<{ ref: CredentialRef; claim: string } | undefined> {
    const snapshot = this.settings()
    if (snapshot === undefined || this.credentials.setIfAbsent === undefined) return undefined
    const values = providers(snapshot.value)
    const route = routeFor(binding.provider, values[binding.provider])
    const ref = route?.ref
    if (ref === undefined || route?.identity !== binding.identity || !MISSING_COPY_REFERENCE.test(ref)) return undefined
    if (Object.entries(values).some(([id, profile]) => id !== binding.provider && record(profile) && profile.apiKeyEnv === ref)) {
      return undefined
    }
    const [state, recordState] = await Promise.all([
      this.credentials.describe(ref), this.credentials.describeRecord(recordKeyFor(binding.provider)),
    ])
    if (state.configured || !state.writable || recordState.configured || this.settings()?.revision !== snapshot.revision) return undefined
    return { ref, claim: digest([binding.provider, binding.identity, snapshot.revision, ref]) }
  }
}

/**
 * Create the operator-only Cloud request handler; no HTTP operation reads a key.
 * @param transfer - Credential transfer for the local Cloud workspace.
 * @returns An exact authenticated POST route.
 */
export function providerKeyImportRoute(transfer: ProviderKeyTransfer): ConnectionFetchRoute {
  const headers = { 'Cache-Control': 'no-store' }
  const reply = (value: unknown, status = 200): Response => Response.json(value, { status, headers })
  return {
    path: PROVIDER_KEY_IMPORT_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type') !== 'application/json') return reply({}, 415)
      let raw: unknown
      try {
        const json = await request.text()
        if (json.length > 64 * 1024) return reply({}, 413)
        raw = JSON.parse(json)
      } catch (_error) { return reply({}, 400) }
      const parsed = providerKeyImportRequest.safeParse(raw)
      if (!parsed.success) return reply({}, 400)
      const message = parsed.data
      try {
        if (message.action === 'prepare') {
          const claim = await transfer.prepare(message.route)
          return reply({ claim: claim ?? null })
        }
        if (request.signal.aborted) return reply({}, 409)
        return reply({ copied: await transfer.receive(message.route, message.claim, message.key) })
      } catch (_error) {
        return reply({}, 503)
      }
    },
  }
}

/**
 * Bind the private Desktop IPC and the separately authenticated Cloud import.
 * @param ctx - Web runtime context.
 */
export function mountProviderKeyCopy(ctx: Context): void {
  const profile = ctx.get('profileContext')?.name
  if (profile !== 'desktop' && (profile !== 'web' || ctx.webServer.host !== '127.0.0.1')) return
  ctx.inject(['settings', 'credentials', 'connection'], (scope) => {
    const transfer = new ProviderKeyTransfer(
      () => scope.settings.describe().find(entry => entry.ns === ADAPTER),
      scope.credentials,
    )
    if (profile === 'web') {
      scope.effect(() => scope.connection.fetch.register(providerKeyImportRoute(transfer)), 'provider-key-copy: Cloud import')
      return
    }
    if (process.platform !== 'darwin' || !process.connected) return
    scope.effect(() => {
      const receive = (message: unknown): void => {
        if (!record(message) || message.type !== 'provider-key-copy' || typeof message.requestId !== 'number'
          || !Number.isSafeInteger(message.requestId)) return
        const requestId = message.requestId
        const send = (result: object): void => {
          if (process.connected) process.send?.({ type: 'provider-key-copy', requestId, ...result }, () => {})
        }
        void (async () => {
          try {
            const command = providerKeySourceRequest.parse(message.command)
            const value = command.action === 'offer' ? await transfer.offer() : await transfer.readKey(command.offer) ?? null
            send({ value })
          } catch (_error) { send({ error: 'Could not prepare the saved provider connection.' }) }
        })().catch(() => { /* The private IPC peer disconnected. */ })
      }
      process.on('message', receive)
      return () => { process.off('message', receive) }
    }, 'provider-key-copy: Desktop source')
  })
}
