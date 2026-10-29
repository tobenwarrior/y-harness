/** Browser-safe avatar-generation vocabulary and Remote failures. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Why the Host cannot currently offer generated avatars. */
export type AvatarGenerationUnavailableReason =
  | 'openai-provider-not-configured'
  | 'openai-credential-not-configured'
  | 'credential-store-unavailable'
  | 'invalid-credential-reference'
  | 'attachments-unavailable'

/** Read-only capability state safe to show in a Client configuration surface. */
export type AvatarGenerationStatus =
  | {
    readonly available: true
    readonly provider: 'openai'
    readonly model: string
  }
  | {
    readonly available: false
    readonly provider: 'openai' | null
    readonly model: string
    readonly reason: AvatarGenerationUnavailableReason
  }

/** User-authored description of the requested avatar. */
export interface AvatarGenerationRequest {
  /** Short visual description, without credentials or provider settings. */
  readonly description: string
}

/** Generated avatar preview bytes, held in the Client until the user commits them. */
export interface AvatarGenerationValue {
  /** Base64 of the validated provider bytes, for immediate Client preview. */
  readonly data: string
  /** Media type of the preview bytes. */
  readonly mediaType: 'image/png'
}

/** Preview payload explicitly selected for durable attachment storage. */
export interface AvatarGenerationCommitRequest {
  /** Canonical base64 image bytes returned by {@link AvatarGenerationValue}. */
  readonly data: string
  /** Media type of the preview bytes. */
  readonly mediaType: 'image/png'
}

/** Durable attachment created when the user commits a generated preview. */
export interface AvatarGenerationCommitValue {
  /** Host-owned image reference for assignment to a Bot. */
  readonly attachment: ImageAttachmentRef
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** OpenAI generation cannot run with the current Host configuration. */
    'avatar-generation/unavailable': { readonly reason: AvatarGenerationUnavailableReason }
    /** The user description did not satisfy the local request policy. */
    'avatar-generation/invalid-request': { readonly reason: 'empty-description' | 'description-too-long' }
    /** OpenAI rejected the configured credential. */
    'avatar-generation/provider-auth': { readonly status: number }
    /** OpenAI asked the caller to retry later. */
    'avatar-generation/rate-limited': { readonly status: number; readonly retryAfterSeconds?: number }
    /** OpenAI returned a non-success response other than auth/rate-limit. */
    'avatar-generation/provider': { readonly status: number }
    /** OpenAI returned a success response without a usable PNG payload. */
    'avatar-generation/response-invalid': {}
    /** The configured attachment provider refused the generated image. */
    'avatar-generation/attachment': {}
    /** The provider request failed before a response was available. */
    'avatar-generation/network': {}
  }
}
