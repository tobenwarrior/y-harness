import type {
  BotAccent as SharedBotAccent,
  BotAvatar as SharedBotAvatar,
  BotConnectedAppAccess as SharedBotConnectedAppAccess,
  BotGroupReactionView as SharedBotGroupReactionView,
  BotIdentity as SharedBotIdentity,
  BotSkillAccess as SharedBotSkillAccess,
  BotSkillPolicy as SharedBotSkillPolicy,
  BotTemplateAvatar,
  BotTemplateCapability,
  BotTemplateLocalPermissions,
  BotTemplateProfile,
  BotInputAttachmentView as SharedBotInputAttachmentView,
  BotRoutineHistoryRequest,
  BotRoutineHistoryValue,
  BotRoutineView,
} from '@yharness/bots/client'
import type { BotGroupDeliveryStatusView as SharedBotGroupDeliveryStatusView } from '@yharness/bots/client'
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

/** Connected app and the selected Bot's durable access decision. */
export type BotConnectedAppAccess = SharedBotConnectedAppAccess

/** Host-local skill metadata and the selected Bot's current grant. */
export type BotSkillSummary = SharedBotSkillAccess

/** Canonical host-local skill policy used by the Bot manager. */
export type BotSkillPolicy = SharedBotSkillPolicy

/** Live availability mapped from the Bot's retained Session. */
export type BotStatus = 'idle' | 'working' | 'preparing' | 'offline'

/** One bot identity and its presentation summary. One bot maps to one Session. */
export interface BotSummary {
  /** Stable bot identity, distinct from the linked Session id. */
  readonly id: string
  /** Latest durable Bot profile revision, when supplied by the owner. */
  readonly updatedAt?: number
  /** Human-facing name displayed in the roster and conversation header. */
  readonly name: string
  /** Optional description persisted with the Bot record. */
  readonly description?: string
  /** Optional model-facing persona persisted with the Bot record. */
  readonly persona?: string
  /** Safe capability declarations retained with the Bot record. */
  readonly capabilities?: readonly string[]
  /** Roster section. Empty values are rendered under the default group. */
  readonly group?: string
  /** Whether this Bot is pinned above other Bots in its section. */
  readonly pinned?: boolean
  /** Whether this Bot is currently recoverable from the hidden section. */
  readonly hidden?: boolean
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


/** Roster placement fields changed by the organization menu. */
export interface BotOrganizationPatch {
  readonly pinned?: boolean
  readonly hidden?: boolean
  readonly group?: string | null
}


/** One existing Bot shown as a member of a workspace group. */
export interface BotGroupSummary {
  /** Durable group identity. */
  readonly id: string
  /** Human-facing group name. */
  readonly name: string
  /** Existing Bots in their durable display order. */
  readonly bots: readonly BotSummary[]
}

/** Browser-owned attachment draft staged beside a local or shared group message. */
export interface BotGroupAttachmentDraft {
  /** Stable draft identity used for removal and retry. */
  readonly id: string
  /** Browser file retained until the group operation settles. */
  readonly file: File
  /** Object URL used only for an in-memory image preview. */
  readonly previewUrl?: string
  /** Local preparation state; failed drafts remain visible for retry. */
  readonly state: 'ready' | 'error'
  /** Safe display detail for a failed preparation attempt. */
  readonly error?: string
}

/** A group transcript row projected for the Bot workspace. */
export interface BotGroupMessageSummary {
  /** Durable transcript message identity. */
  readonly id: string
  /** Human or Bot author. */
  readonly sender:
    | { readonly kind: 'user' }
    | { readonly kind: 'bot'; readonly botId: string; readonly name: string }
  /** User-visible message text. */
  readonly text: string
  /** Exact Bot ids selected by mentions for this message, when it was targeted. */
  readonly targetBotIds?: readonly string[]
  /** Parent message selected when this message was written as a reply. */
  readonly replyToMessageId?: string
  /** Aggregated emoji reactions visible to the current viewer. */
  readonly reactions?: readonly BotGroupReactionSummary[]
  /** Safe metadata for attachments admitted to this message. */
  readonly attachments?: readonly SharedBotInputAttachmentView[]
  /** Unix timestamp used for stable transcript ordering. */
  readonly createdAt: number
}

/** One emoji reaction count in a group transcript. */
export type BotGroupReactionSummary = SharedBotGroupReactionView

/** Group reaction mutation request shared by local and shared rooms. */
export type BotGroupReactionRequest = {
  /** Group containing the message. */
  readonly groupId: string
  /** Message whose reaction is changing. */
  readonly messageId: string
  /** Fixed emoji to select or remove. */
  readonly emoji: string
  /** Whether to add this emoji or remove only this viewer's selection of it. */
  readonly action: 'add' | 'remove'
}

/** Result returned after a group reaction mutation. */
export type BotGroupReactionValue = {
  /** Message whose reactions were changed. */
  readonly messageId: string
  /** Current aggregated counts after the mutation. */
  readonly reactions: readonly BotGroupReactionSummary[]
}

/** Persisted per-recipient execution state projected into the group transcript. */
export interface BotGroupDeliverySummary {
  /** Source group message identity. */
  readonly messageId: string
  /** Recipient Bot identity. */
  readonly botId: string
  /** Durable delivery lifecycle. */
  readonly status: SharedBotGroupDeliveryStatusView['status']
  /** Safe failure description supplied by the Host after a failed turn. */
  readonly error?: string
}

/** Selected workspace group plus its durable transcript. */
export interface BotGroupDetailData extends BotGroupSummary {
  /** Chronological transcript rows. */
  readonly messages: readonly BotGroupMessageSummary[]
  /** Persisted per-recipient delivery state, when the Host supports it. */
  readonly deliveries?: readonly BotGroupDeliverySummary[]
}

/** User choice passed to the owner when creating a workspace group. */
export interface BotGroupCreation {
  /** Group name. */
  readonly name: string
  /** Two through six existing Bot ids. */
  readonly botIds: readonly string[]
  /** Optional explicit retry/new-operation identity. */
  readonly groupId?: string

}

/** Group metadata and member selection submitted by the edit dialog. */
export interface BotGroupUpdate {
  /** Existing group identity. */
  readonly groupId: string
  /** New display name. */
  readonly name: string
  /** Complete member selection in display order. */
  readonly botIds: readonly string[]
}

/** User choice passed to the owner when creating a bot. */
export interface BotCreation {
  readonly name: string
  readonly identity: BotIdentity
  readonly accent: BotAccent
  /** Optional user-facing role description. */
  readonly description?: string
  /** Optional model-facing persona text. */
  readonly persona?: string
  /** Safe capability declarations, not granted permissions. */
  readonly capabilities?: readonly string[]
}

/** Complete profile submitted by the owner when editing an existing Bot. */
export interface BotProfileUpdate {
  /** Row revision captured when the edit dialog opened. */
  readonly expectedUpdatedAt?: number
  readonly name: string
  readonly description: string
  readonly persona: string
  /** Safe capability declarations, not granted permissions. */
  readonly capabilities: readonly string[]
}

/** Safe reusable Bot configuration shown in the Client workspace. */
export interface BotTemplateSummary {
  /** Durable template identity. */
  readonly id: string
  /** Opaque code used to preview and import the template. */
  readonly shareCode: string
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
  /** Safe capability declarations retained as data, not target permissions. */
  readonly capabilities?: readonly BotTemplateCapability[]
  /** Structured display profile carried by the signed artifact. */
  readonly profile?: BotTemplateProfile
  /** Portable avatar bytes, without a Host attachment id. */
  readonly avatar?: BotTemplateAvatar
  /** Stable signed-artifact fingerprint. */
  readonly fingerprint?: string
  /** Self-asserted SHA-256 fingerprint of the public key that signed the artifact; it does not establish identity. */
  readonly issuerFingerprint?: string
  /** Portable code format version. */
  readonly portableVersion?: number
  /** Whether this Host has explicitly approved the signed artifact. */
  readonly approved?: boolean
  /** Target-Host effective preset tools shown before approval; absent in catalog rows. */
  readonly localPermissions?: BotTemplateLocalPermissions
  /** Opaque Host-local approval token returned by the current preview. */
  readonly approvalToken?: string
  /** Publication time in Unix milliseconds. */
  readonly createdAt: number
  /** Revocation time, when the code is no longer usable. */
  readonly revokedAt?: number
}

/** Browser state for the reusable Bot template catalog and import flow. */
export interface BotTemplateState {
  /** Catalog loading phase. */
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  /** Published templates, including revoked rows retained for status display. */
  readonly templates: readonly BotTemplateSummary[]
  /** Current pasted or generated share code. */
  readonly code: string
  /** Safe preview for the current code, when one was resolved. */
  readonly preview: BotTemplateSummary | null
  /** Last template-specific failure. */
  readonly error: string | null
  /** Whether a publish, revoke, preview, or import request is running. */
  readonly busy: boolean
}

/** Actions exposed by the controller for reusable Bot templates. */
export interface BotTemplateActions {
  /** Keep the current code in the workspace while the user edits it. */
  readonly setTemplateCode: (code: string) => void
  /** Publish the safe configuration of an existing Bot. */
  readonly publishTemplate: (request: {
    readonly botId: string
    readonly name?: string
    readonly description?: string
  }) => Promise<void>
  /** Revoke one published template without deleting its audit row. */
  readonly revokeTemplate: (templateId: string) => Promise<void>
  /** Resolve a share code into a safe preview. */
  readonly previewTemplate: (code?: string) => Promise<void>
  /** Import the current preview into a distinct Bot and Session. */
  readonly importTemplate: (name?: string) => Promise<void>
}

/** One active memory row exposed by the selected Bot's private manager. */
export interface BotMemorySummary {
  /** Stable memory identity used for edits and logical removal. */
  readonly id: string
  /** User-authored reference text retained by this Bot. */
  readonly text: string
  /** Unix milliseconds when the current text was remembered. */
  readonly createdAt: number
}

/** Bot-scoped memory management actions mounted by the Host. */
export interface BotMemoryManagerActions {
  /** Read the selected Bot's active private memories. */
  readonly list: (botId: string) => Promise<readonly BotMemorySummary[]>
  /** Replace one memory while retaining its stable identity. */
  readonly update: (botId: string, memoryId: string, text: string) => Promise<BotMemorySummary>
  /** Logically remove one memory from future Bot prompts. */
  readonly remove: (botId: string, memoryId: string) => Promise<void>
}

/** Metadata returned by one Bot's host-local skill catalog. */
export interface BotSkillManagerValue {
  /** Canonical policy currently stored for the Bot. */
  readonly policy: BotSkillPolicy
  /** Monotonic revision required for the next policy replacement. */
  readonly revision: number
  /** Available local skill metadata and the Bot's effective decisions. */
  readonly skills: readonly BotSkillSummary[]
}

/** Error returned when another actor changed the selected Bot's skill policy. */
export class BotSkillPolicyConflictError extends Error {
  /** Stable discriminator for conflict handling across Client components. */
  readonly code = 'bot/skill-policy-conflict' as const

  /**
   * @param message - Host-provided conflict description.
   */
  constructor(message: string) {
    super(message)
    this.name = 'BotSkillPolicyConflictError'
  }
}

/** Bot-scoped host-local skill management actions. */
export interface BotSkillManagerActions {
  /** Read skill metadata and the current Bot policy. */
  readonly list: (botId: string) => Promise<BotSkillManagerValue>
  /** Replace the complete Bot policy. */
  readonly update: (botId: string, policy: BotSkillPolicy, expectedRevision: number) => Promise<Pick<BotSkillManagerValue, 'policy'>>
}

/** Successful history response shown by the selected Bot's routine manager. */
export type BotRoutineHistory = Exclude<BotRoutineHistoryValue, { readonly code: string }>

/** Bot-scoped routine management actions mounted by the Host. */
export interface BotRoutineManagerActions {
  /** Read timed and event routines owned by one Bot. */
  readonly list: (botId: string) => Promise<readonly BotRoutineView[]>
  /** Pause one active routine and return its latest view. */
  readonly pause: (botId: string, routineId: string) => Promise<BotRoutineView>
  /** Resume one paused routine and return its latest view. */
  readonly resume: (botId: string, routineId: string) => Promise<BotRoutineView>
  /** Delete one routine and its bounded history. */
  readonly remove: (botId: string, routineId: string) => Promise<void>
  /** Read one bounded routine history page, optionally continuing an older timed page. */
  readonly history: (botId: string, routineId: string, before?: BotRoutineHistoryRequest['before']) => Promise<BotRoutineHistory>
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
  /** Admit and assign a user-selected PNG without image generation. */
  readonly upload?: (botId: string, preview: AvatarGenerationValue) => Promise<void>
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
  /** Durable workspace groups shown below the Bot roster. */
  readonly groups?: readonly BotGroupSummary[]
  /** Selected workspace group id, or null when a direct Bot is selected. */
  readonly selectedGroupId?: string | null | undefined
  /** Selected group loading or delivery failure, retained beside its transcript. */
  readonly groupError?: string | null | undefined
  /** Selected bot id, or null when no bot is selected. */
  readonly selectedBotId: string | null
  /** Select a bot and let the owner open its persistent Session. */
  readonly onSelectBot: (id: string) => void
  /** Select a workspace group without creating another Bot Session. */
  readonly onSelectGroup?: ((id: string) => void) | undefined
  /** Provision one Bot; rejects while the same request remains retryable. */
  readonly onCreateBot: (creation: BotCreation) => Promise<void>
  /** Persist a Bot's name and user-authored profile fields without changing its Session. */
  readonly onUpdateProfile?: ((id: string, profile: BotProfileUpdate) => Promise<void>) | undefined

  /** Persist a Bot's pinned, hidden, or section placement. */
  readonly onOrganizeBot?: ((id: string, patch: BotOrganizationPatch) => Promise<void>) | undefined

  /** Create a workspace group from existing Bot identities. */
  readonly onCreateGroup?: ((creation: BotGroupCreation) => Promise<void>) | undefined

  /** Rename a workspace group or replace its members. */
  readonly onUpdateGroup?: ((update: BotGroupUpdate) => Promise<void>) | undefined

  /** Optional callback for the connections action. */
  readonly onConnectApps?: (() => void) | undefined
  /** Loads the connected-app catalog and current access policy for one Bot. */
  readonly onLoadConnectedApps?: ((botId: string) => Promise<readonly BotConnectedAppAccess[]>) | undefined
  /** Persists one Bot's grant or revoke for a connected app. */
  readonly onSetConnectedAppAccess?: ((botId: string, appId: string, allowed: boolean) => Promise<void>) | undefined
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
  /** Reusable Bot templates, when the Host mounts the template capability. */
  readonly templates?: BotTemplateState | undefined
  /** Publish, revoke, preview, and import actions for reusable Bot templates. */
  readonly templateActions?: BotTemplateActions | undefined
  /** Optional host-local skill manager; absent when the owner does not supply both Remote methods. */
  readonly skillManager?: BotSkillManagerActions | undefined
}
