/** Browser-safe Bot requests, durable values, and Remote failure vocabulary. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable user-owned identity for one roster entry. */
export type BotId = Branded<'BotId'>

/** Apply the Bot identity brand to a value already admitted by the owner.
 * @param value - String value already validated as a Bot id.
 * @returns The branded Bot id.
 */
export function BotId(value: string): BotId {
  return brandString<BotId>(value)
}

/** Existing semantic glyph families used by the Bot avatar. */
export const BOT_IDENTITIES = [
  'agent',
  'sparkle',
  'goal',
  'browse',
  'skill',
  'workspace',
] as const

/** Existing product accent families used by the Bot avatar. */
export const BOT_ACCENTS = [
  'blue',
  'teal',
  'amber',
  'violet',
  'rose',
  'lime',
] as const

/** Named icon family used by a Bot's stable visual identity. */
export type BotIdentity = typeof BOT_IDENTITIES[number]

/** Named accent family used by a Bot's stable visual identity. */
export type BotAccent = typeof BOT_ACCENTS[number]

/** Lifecycle of a durable Bot row while its backing Session is being adopted. */
export type BotProvisioningState = 'provisioning' | 'active'

/** Host availability of the Bot's one backing Session Agent. */
export type BotAvailability = 'running' | 'idle' | 'offline'

/** Persisted generated avatar reference owned by one Bot row. */
export type BotAvatar = ImageAttachmentRef

/** Authoritative durable row: one Bot maps to exactly one ordinary Session. */
export interface BotRecord {
  /** Stable roster identity. */
  readonly id: BotId
  /** The only Session owned by this Bot. */
  readonly sessionId: SessionId
  /** User-visible display name. */
  readonly name: string
  /** Optional user-facing routing description. */
  readonly description?: string | undefined
  /** Stable semantic avatar family. */
  readonly identity: BotIdentity
  /** Stable product accent family. */
  readonly accent: BotAccent
  /** Optional generated avatar selected by the user. */
  readonly avatar?: BotAvatar | undefined
  /** Absolute working directory used for the Bot's Session. */
  readonly cwd: string
  /** Optional preset selected when the backing Session is created. */
  readonly agentPreset?: string | undefined
  /** Whether the row has completed Session provisioning. */
  readonly state: BotProvisioningState
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last durable roster mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Browser-facing Bot row enriched with live availability. */
export type BotView = BotRecord & {
  /** Current live Agent state; `offline` means the Session is cold, not deleted. */
  readonly availability: BotAvailability
}

/** New Bot metadata and optional stable id for retrying provisioning. */
export interface BotCreateRequest {
  /** Optional caller-selected id; reuse it to retry a provisioning failure. */
  readonly id?: BotId
  /** Non-empty display name, trimmed by the Host. */
  readonly name: string
  /** Optional routing description. */
  readonly description?: string
  /** Stable semantic avatar family. */
  readonly identity?: BotIdentity
  /** Stable product accent family. */
  readonly accent?: BotAccent
  /** Absolute working directory; defaults to the Host process directory. */
  readonly cwd?: string
  /** Optional Agent preset passed to Session creation. */
  readonly agentPreset?: string
}

/** Bot create response. */
export interface BotCreateValue {
  /** The newly active or still-provisioning durable Bot row. */
  readonly bot: BotView
}

/** Bot catalog request; cursor is reserved for a future bounded roster. */
export interface BotListRequest {
  /** Reserved cursor; version one always returns the complete roster. */
  readonly cursor?: string
}

/** Bot catalog response. */
export interface BotListValue {
  /** Durable roster ordered by creation time, then id. */
  readonly bots: readonly BotView[]
}

/** Rename one Bot without changing its Session binding. */
export interface BotRenameRequest {
  /** Bot identity to rename. */
  readonly botId: BotId
  /** New non-empty display name. */
  readonly name: string
}

/** Bot rename response. */
export interface BotRenameValue {
  /** The committed renamed row. */
  readonly bot: BotView
}

/** Replace or clear one Bot's generated avatar without changing its Session. */
export interface BotAvatarUpdateRequest {
  /** Bot whose avatar should change. */
  readonly botId: BotId
  /** Generated avatar reference, or null to return to the semantic default avatar. */
  readonly avatar: BotAvatar | null
}

/** Avatar update response. */
export interface BotAvatarUpdateValue {
  /** Updated Bot row with its Session mapping intact. */
  readonly bot: BotView
}

/** Read one Bot-owned generated avatar from Host attachment storage. */
export interface BotAvatarReadRequest {
  /** Bot whose current avatar should be read. */
  readonly botId: BotId
}

/** Avatar reference and bytes used by a Client to render the roster image. */
export interface BotAvatarReadValue {
  /** Canonical stored image reference. */
  readonly avatar: ImageAttachmentRef
  /** Base64-encoded stored image bytes. */
  readonly data: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested Bot id is absent from the durable roster. */
    'bot/not-found': { readonly botId: BotId }
    /** The requested Bot id already names another roster row. */
    'bot/id-conflict': { readonly botId: BotId }
    /** The requested Bot metadata conflicts with an existing provisioning row. */
    'bot/provisioning-conflict': { readonly botId: BotId }
    /** Session creation failed; the Bot row remains retryable when supplied. */
    'bot/provisioning-failed': { readonly botId: BotId; readonly sessionId: SessionId }
    /** The supplied avatar reference is malformed or cannot be read from attachment storage. */
    'bot/avatar-invalid': { readonly botId: BotId; readonly reason: 'invalid-reference' | 'unreadable' }
    /** The Bot has no generated avatar to read. */
    'bot/avatar-missing': { readonly botId: BotId }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Post-commit notification for roster writes; listeners refetch `bots.list`.
     * @mode emit
     */
    'bots/changed'(): void
  }
}
