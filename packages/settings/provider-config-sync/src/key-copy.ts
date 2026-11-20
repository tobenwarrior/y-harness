/** Private Desktop source IPC and owner Cloud import request fields. */
import { z } from 'zod'
import { providerCatalogRoute } from './profile.ts'

/** Write-only Cloud entry point for an approved native provider key copy. */
export const PROVIDER_KEY_IMPORT_PATH = '/api/provider-key-import'

/** The provider ID and digest of the endpoints its models actually use. */
export const providerKeyRoute = z.strictObject({
  provider: providerCatalogRoute,
  identity: z.string().regex(/^[a-f0-9]{64}$/u),
})
/** One source or destination provider route named in a key transfer. */
export type ProviderKeyRoute = z.infer<typeof providerKeyRoute>

/** An approved source identity bound to its current key reference. */
export const providerKeyOffer = providerKeyRoute.extend({ sourceClaim: z.string().regex(/^[a-f0-9]{64}$/u) })
/** The Mac route shown for approval, with its private source claim. */
export type ProviderKeyOffer = z.infer<typeof providerKeyOffer>

/** Stored credential value within the handoff transport's size budget. */
export const providerKeyValue = z.string().min(1).max(8_192)

/** Owner import requests address one destination route at a time. */
export const providerKeyImportRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare'), route: providerKeyRoute }),
  z.strictObject({
    action: z.literal('receive'), route: providerKeyRoute,
    claim: z.string().regex(/^[a-f0-9]{64}$/u), key: providerKeyValue,
  }),
])
/** Parsed request on the write-only Cloud channel. */
export type ProviderKeyImportRequest = z.infer<typeof providerKeyImportRequest>

/** Source commands are accepted on the private Desktop parent channel. */
export const providerKeySourceRequest = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('offer') }),
  z.strictObject({ action: z.literal('read'), offer: providerKeyOffer }),
])
/** Parsed command sent by Electron to the Desktop Host. */
export type ProviderKeySourceRequest = z.infer<typeof providerKeySourceRequest>
