import type {
  BotAccent as SharedBotAccent,
  BotAvatar as SharedBotAvatar,
  BotIdentity as SharedBotIdentity,
} from '@yharness/bots/client'
import type {
  AvatarGenerationRequest,
  AvatarGenerationCommitValue,
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@yharness/avatar-generation/types'

/** Visual accent families persisted by the Bot service. */
export type BotAccent = SharedBotAccent

/** Stable expressive character silhouette families persisted by the Bot service. */
export type BotIdentity = SharedBotIdentity

/** Live availability mapped from the Bot's retained Session. */
export type BotStatus = 'idle' | 'working' | 'preparing' | 'offline'

/** One bot identity and its presentation summary. One bot maps to one Session. */
export interface BotSummary {
  /** Stable bot identity, distinct from the linked Session id. */
  readonly id: string
  /** Human-facing name displayed in the roster and conversation header. */
  readonly name: string
  /** Optional description persisted with the Bot record. */
  readonly description?: string
  /** Roster section. Empty values are rendered under the default group. */
  readonly group?: string
  /** Latest useful sentence from the linked Session. */
  readonly preview?: string
  /** Relative or localized activity label supplied by the owner. */
  readonly activity?: string
  /** Optional live Session state. Omit it when the owner has no live signal. */
  readonly status?: BotStatus
  /** Optional unread count for work completed since the user last opened the bot. */
  readonly unread?: number
  /** Stable visual family; avoids arbitrary colors in feature CSS. */
  readonly accent?: BotAccent
  /** Stable expressive character silhouette used by the avatar. */
  readonly identity?: BotIdentity
  /** Optional persisted generated image reference; the semantic avatar remains the fallback while it loads. */
  readonly avatar?: SharedBotAvatar
}

/** User choice passed to the owner when creating a bot. */
export interface BotCreation {
  readonly name: string
  readonly identity: BotIdentity
  readonly accent: BotAccent
}

/** Async avatar capabilities owned by the Client composition. */
export interface BotAvatarEditorActions {
  /** Read whether the configured provider can generate an avatar now. */
  readonly status?: () => Promise<AvatarGenerationStatus>
  /** Generate one validated, non-durable image preview when generation is mounted. */
  readonly generate?: (request: AvatarGenerationRequest, signal?: AbortSignal) => Promise<AvatarGenerationValue>
  /** Persist a preview after the user explicitly chooses it when avatar updates are mounted. */
  readonly commit?: (preview: AvatarGenerationValue) => Promise<AvatarGenerationCommitValue>
  /** Persist the generated image, or clear it to restore the semantic avatar. */
  readonly update?: (botId: string, avatar: SharedBotAvatar | null) => Promise<void>
  /** Persist a semantic character choice and optionally clear a generated image in the same update. */
  readonly updateAppearance?: (botId: string, appearance: {
    readonly identity: BotIdentity
    readonly accent: BotAccent
    readonly clearAvatar: boolean
  }) => Promise<void>
}

/** Props for the presentational Bot workspace. */
export interface BotWorkspaceProps {
  /** Available bots in the owner's stable order. */
  readonly bots: readonly BotSummary[]
  /** Selected bot id, or null when no bot is selected. */
  readonly selectedBotId: string | null
  /** Select a bot and let the owner open its persistent Session. */
  readonly onSelectBot: (id: string) => void
  /** Provision one Bot; rejects while the same request remains retryable. */
  readonly onCreateBot: (creation: BotCreation) => Promise<void>
  /** Optional callback for the connections action. */
  readonly onConnectApps?: (() => void) | undefined
  /** Optional settings deep-link for configuring the avatar provider. */
  readonly onOpenAvatarSettings?: (() => void) | undefined
  /** Optional retry for an owner-provided loading failure. */
  readonly onRetry?: (() => void) | undefined
  /** Owner-provided failure. Existing rows remain visible when present. */
  readonly error?: string | null | undefined
  /** Owner-provided loading state. */
  readonly loading?: boolean | undefined
  /** Loads a persisted generated avatar through the Bot-owned attachment path. */
  readonly loadAvatar?: ((botId: string, avatar: SharedBotAvatar) => Promise<string>) | undefined
  /** Optional generated-avatar editor; absent when the deployment does not mount it. */
  readonly avatarEditor?: BotAvatarEditorActions | undefined
}
