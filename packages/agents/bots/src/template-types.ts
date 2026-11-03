/** Browser-safe reusable Bot template requests, values, and failure vocabulary. */

import { brandString, type Branded } from '@yharness/brand'
import type { BotAccent, BotIdentity, BotId, BotView } from './types.ts'

/** Stable durable identity of one published Bot template. */
export type BotTemplateId = Branded<'BotTemplateId'>

/**
 * Apply the Bot template identity brand after boundary validation.
 * @param value - Validated durable template id.
 * @returns Branded template id.
 */
export function BotTemplateId(value: string): BotTemplateId {
  return brandString<BotTemplateId>(value)
}

/** Signed, self-contained code carrying one portable Bot template. */
export type BotTemplateShareCode = Branded<'BotTemplateShareCode'>

/**
 * Apply the Bot template share-code brand after boundary validation.
 * @param value - Validated opaque share code.
 * @returns Branded template share code.
 */
export function BotTemplateShareCode(value: string): BotTemplateShareCode {
  return brandString<BotTemplateShareCode>(value)
}

/** Display profile carried by a portable Bot template. */
export interface BotTemplateProfile {
  /** User-facing template name. */
  readonly name: string
  /** Optional role description. */
  readonly description?: string
  /** Semantic character family. */
  readonly identity: BotIdentity
  /** Accent family. */
  readonly accent: BotAccent
}

/** Portable generated avatar bytes; no Host attachment id is included. */
export interface BotTemplateAvatar {
  /** Image media type validated by the target attachment provider. */
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Canonical base64 image bytes. */
  readonly data: string
  /** Exact encoded byte length. */
  readonly bytes: number
  /** Intrinsic image width. */
  readonly width: number
  /** Intrinsic image height. */
  readonly height: number
  /** Optional display name, never interpreted as a path. */
  readonly name?: string
}

/** Safe capability declaration copied into a template; it never grants target-host permissions. */
export type BotTemplateCapability = string

/** Safe Bot configuration included in a reusable template. */
export interface BotTemplateConfiguration {
  /** User-facing template name. */
  readonly name: string
  /** Optional role description. */
  readonly description?: string
  /** Semantic character family. */
  readonly identity: BotIdentity
  /** Accent family. */
  readonly accent: BotAccent
  /** Optional Agent preset identifier. */
  readonly agentPreset?: string
  /** Optional model-facing persona text. */
  readonly persona?: string
  /** Safe capability labels retained as declarations, not permissions. */
  readonly capabilities?: readonly BotTemplateCapability[]
  /** Structured profile projection for portable consumers. */
  readonly profile?: BotTemplateProfile
  /** Portable generated avatar, without a local attachment id. */
  readonly avatar?: BotTemplateAvatar
}

/** Browser-safe durable template row. */
export interface BotTemplateView extends BotTemplateConfiguration {
  /** Durable template identity. */
  readonly id: BotTemplateId
  /** Opaque code used for preview and import. */
  readonly shareCode: BotTemplateShareCode
  /** Publication time in Unix milliseconds. */
  readonly createdAt: number
  /** Revocation time, when the code is no longer usable. */
  readonly revokedAt?: number
  /** Content fingerprint used for keyed import retries. */
  readonly fingerprint?: string
  /** Self-asserted SHA-256 fingerprint of the public key that signed this artifact; it does not establish identity. */
  readonly issuerFingerprint?: string
  /** Portable code format version. */
  readonly portableVersion?: number
  /** Whether this Host has explicitly approved the signed artifact for import. */
  readonly approved?: boolean
}

/** List request reserved for future cursor pagination. */
export interface BotTemplateListRequest {
  /** Reserved cursor. */
  readonly cursor?: string
}

/** Durable template catalog response. */
export interface BotTemplateListValue {
  /** Published templates, including rows revoked by the owner. */
  readonly templates: readonly BotTemplateView[]
}

/** Publish one safe configuration snapshot from an existing Bot. */
export interface BotTemplatePublishRequest {
  /** Bot whose safe configuration should be copied. */
  readonly botId: BotId
  /** Optional template name; defaults to the Bot name. */
  readonly name?: string
  /** Optional template description; defaults to the Bot description. */
  readonly description?: string
  /** Optional replacement persona text. */
  readonly persona?: string
  /** Optional safe capability declarations. */
  readonly capabilities?: readonly BotTemplateCapability[]
}

/** Published template response. */
export interface BotTemplatePublishValue {
  /** Newly published template. */
  readonly template: BotTemplateView
}

/** Revoke one published template. */
export interface BotTemplateRevokeRequest {
  /** Template to revoke. */
  readonly templateId: BotTemplateId
}

/** Revocation response. */
export interface BotTemplateRevokeValue {
  /** Revoked template row. */
  readonly template: BotTemplateView
}

/** Preview request by opaque share code. */
export interface BotTemplatePreviewRequest {
  /** Exact share code, trimmed at the Host boundary. */
  readonly shareCode: BotTemplateShareCode
}

/** Target-Host tools available after resolving the signed preset locally. */
export interface BotTemplateLocalPermissions {
  /** Whether the target Host could resolve the effective preset tool view. */
  readonly status: 'resolved' | 'unavailable'
  /** Preset selected by the target Host, including its configured default. */
  readonly preset?: string
  /** Effective model-facing tool names for that local preset. */
  readonly tools: readonly string[]
}

/** Preview response. */
export interface BotTemplatePreviewValue {
  /** Safe configuration that import will use. */
  readonly template: BotTemplateView
  /** Current target-Host preset and tool view; never signed into the portable code. */
  readonly localPermissions: BotTemplateLocalPermissions
}

/** Approve one exact verified artifact for future imports on this Host. */
export interface BotTemplateApproveRequest {
  /** Signed artifact to approve after inspecting its preview. */
  readonly shareCode: BotTemplateShareCode
  /** Fingerprint shown by the inspected preview. */
  readonly fingerprint: string
}

/** Import request for a new Bot and Session. */
export interface BotTemplateImportRequest {
  /** Exact share code, trimmed at the Host boundary. */
  readonly shareCode: BotTemplateShareCode
  /** Optional replacement name for the imported Bot. */
  readonly name?: string
  /** Stable caller operation identity; repeating it returns the same Bot. */
  readonly importId?: string
}

/** Import response containing the newly provisioned Bot. */
export interface BotTemplateImportValue {
  /** Newly allocated Bot and its new Session binding. */
  readonly bot: BotView
  /** Source template used for the import. */
  readonly template: BotTemplateView
}

/** Explicitly approve one verified portable artifact for import on this Host. */
export interface BotTemplateApproveValue {
  /** The verified template with its Host-local approval state. */
  readonly template: BotTemplateView
  /** Current target-Host preset and tool view shown during approval. */
  readonly localPermissions: BotTemplateLocalPermissions
}

/** Stable operation identity for an idempotent template import. */
export type BotTemplateImportId = Branded<'BotTemplateImportId'>

/**
 * Apply the import-operation brand after boundary validation.
 * @param value - Validated stable operation identity.
 * @returns Branded import operation identity.
 */
export function BotTemplateImportId(value: string): BotTemplateImportId {
  return brandString<BotTemplateImportId>(value)
}

declare module '@yharness/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The supplied template reference does not name a durable row. */
    'bot-template/not-found': { readonly reference: string }
    /** The supplied share code is malformed or otherwise unusable. */
    'bot-template/invalid': {
      readonly reason: 'malformed-code' | 'empty-code' | 'invalid-signature' | 'unsupported-version' | 'invalid-payload'
    }
    /** The template exists but has been revoked by its publisher. */
    'bot-template/revoked': { readonly templateId: BotTemplateId }
    /** The signed artifact has not been explicitly approved on this Host. */
    'bot-template/untrusted': { readonly fingerprint: string }
    /** The approval did not match the currently inspected signed artifact. */
    'bot-template/approval-mismatch': { readonly fingerprint: string }
    /** The local template row belongs to another configured owner. */
    'bot-template/forbidden': { readonly templateId: BotTemplateId }
    /** A portable avatar could not be admitted on the target Host. */
    'bot-template/avatar-invalid': { readonly reason: 'invalid-bytes' | 'unavailable' }
    /** The same import identity was reused with different configuration. */
    'bot-template/import-conflict': { readonly importId: string }
  }
}
