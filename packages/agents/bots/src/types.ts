/** Browser-safe Bot requests, durable values, and Remote failure vocabulary. */

import { brandString, type Branded } from '@yharness/brand'
import type { ImageAttachmentRef } from '@yharness/attachment'
import type { MessageId } from '@yharness/llm/brand'
import type { SessionId } from '@yharness/session/types'

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
  'round',
  'cloud',
  'tile',
  'clover',
  'heart',
  'drop',
  'oval',
  'triangle',
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

/** Event sources admitted by Bot-owned routines. */
export const BOT_EVENT_SOURCES = ['bot', 'user'] as const

/** Source of a message that can fire a Bot-owned routine. */
export type BotEventSource = typeof BOT_EVENT_SOURCES[number]

/** Message event selector for one Bot-owned routine. */
export interface BotEventTrigger {
  /** Trigger family; message is the only supported event family. */
  readonly type: 'message'
  /** Whether a peer Bot or the human user must author the message. */
  readonly source: BotEventSource
}

/** One durably admitted event-trigger delivery. */
export interface BotEventRoutineDelivery {
  /** Session event sequence that caused this delivery. */
  readonly triggerEventSeq: number
  /** Stable message id used for retrying delivery after a restart. */
  readonly messageId: MessageId
  /** Whether the follow-up was persisted in the Bot Session. */
  readonly status: 'pending' | 'delivered'
  /** Time the event was admitted to this routine. */
  readonly createdAt: string
  /** Time Session persistence acknowledged the follow-up. */
  readonly deliveredAt?: string | undefined
}

/** Completed model result associated with one event-trigger delivery. */
export interface BotEventRoutineResult {
  /** Event-trigger message whose turn produced this result. */
  readonly messageId: MessageId
  /** Turn-ending reason, excluding private model reasoning. */
  readonly status: 'completed' | 'error' | 'aborted' | 'blocked' | 'max-tokens' | 'interrupted' | 'forked'
  /** Durable event time of the turn boundary. */
  readonly completedAt: string
  /** Visible assistant text produced by the turn, when any. */
  readonly output?: string | undefined
  /** Safe provider failure text when the turn ended with an error. */
  readonly error?: string | undefined
}

/** Durable Bot routine that runs when its selected message event arrives. */
export interface BotEventRoutine {
  /** Stable routine identity. */
  readonly id: string
  /** User-facing routine name. */
  readonly title: string
  /** Prompt delivered to the Bot when the event arrives. */
  readonly prompt: string
  /** Supported event selector. */
  readonly trigger: BotEventTrigger
  /** Whether future matching events are admitted. */
  readonly status: 'active' | 'paused'
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last durable routine mutation in Unix milliseconds. */
  readonly updatedAt: number
  /** Bounded delivery records, oldest first. */
  readonly deliveries: readonly BotEventRoutineDelivery[]
  /** Bounded completed model results, oldest first. */
  readonly results: readonly BotEventRoutineResult[]
}

/** Browser/native view of one Bot event routine. */
export type BotEventRoutineView = BotEventRoutine & {
  /** Common routine discriminator used alongside timed Schedule records. */
  readonly kind: 'event'
  /** Event routines wait for a matching message instead of a wall-clock target. */
  readonly state: 'waiting'
  /** Delivery remains in the Bot's original Session. */
  readonly deliveryMode: 'host'
}

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
  /** Bot-scoped message routines; absent on rows written before event routines existed. */
  readonly eventRoutines?: readonly BotEventRoutine[] | undefined
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

/** Change one Bot's semantic identity and/or accent without changing its Session. */
export interface BotAppearanceUpdateRequest {
  /** Bot whose visual identity should change. */
  readonly botId: BotId
  /** Optional semantic avatar family; omitted to retain the current family. */
  readonly identity?: BotIdentity
  /** Optional product accent family; omitted to retain the current family. */
  readonly accent?: BotAccent
  /** Remove a generated avatar in the same durable write when true. */
  readonly clearAvatar?: boolean
}

/** Appearance update response. */
export interface BotAppearanceUpdateValue {
  /** Updated Bot row with its Session mapping intact. */
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

declare module '@yharness/typert-protocol' {
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

declare module '@yharness/cordis' {
  interface Events {
    /**
     * Post-commit notification for roster writes; listeners refetch `bots.list`.
     * @mode emit
     */
    'bots/changed'(): void
  }
}
