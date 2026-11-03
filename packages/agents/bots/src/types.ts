/** Browser-safe Bot requests, durable values, and Remote failure vocabulary. */

import { brandString, type Branded } from '@yharness/brand'
import type { ImageAttachmentRef } from '@yharness/attachment'
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

/** Per-Bot host-local skill discovery policy. */
export interface BotSkillPolicy {
  /** Whether the Bot receives every discovered skill or only the enabled names. */
  readonly mode: 'all' | 'selected'
  /** Skill names explicitly enabled when `mode` is `selected`. */
  readonly enabled: readonly string[]
  /** Skill names denied in either mode. */
  readonly disabled: readonly string[]
}

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
  /** Deployment-local owner scope used for template publication authorization. */
  readonly ownerId: string
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
  /** Optional model-facing persona text. */
  readonly persona?: string | undefined
  /** Safe capability declarations retained by the Bot. */
  readonly capabilities?: readonly string[] | undefined
  /** Connected MCP app ids this Bot may use; absent means legacy rows retain all available apps. */
  readonly connectedAppIds?: readonly string[] | undefined
  /** Connected MCP app ids explicitly denied for a legacy allow-all Bot. */
  readonly connectedAppDenyIds?: readonly string[] | undefined
  /** Whether the Bot is kept at the top of its roster view. */
  readonly pinned?: boolean | undefined
  /** Whether the Bot is excluded from the default visible roster. */
  readonly hidden?: boolean | undefined
  /** Optional user-defined roster section. */
  readonly group?: string | undefined
  /** Absolute working directory used for the Bot's Session. */
  readonly cwd: string
  /** Optional preset selected when the backing Session is created. */
  readonly agentPreset?: string | undefined
  /** Optional host-local skill discovery policy; absent means all available skills. */
  readonly skillPolicy?: BotSkillPolicy | undefined
  /** Monotonic compare-and-swap revision for host-local skill policy updates. */
  readonly skillPolicyRevision?: number | undefined
  /** Whether the row has completed Session provisioning. */
  readonly state: BotProvisioningState
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last durable roster mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Browser-facing Bot row enriched with live availability. */
export type BotView = Omit<BotRecord, 'ownerId' | 'skillPolicyRevision'> & {
  /** Current live Agent state; `offline` means the Session is cold, not deleted. */
  readonly availability: BotAvailability
  /** Whether the Bot is kept at the top of its roster view. */
  readonly pinned: boolean
  /** Whether the Bot is excluded from the default visible roster. */
  readonly hidden: boolean
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
  /** Optional host-local skill discovery policy. */
  readonly skillPolicy?: BotSkillPolicy
  /** Optional model-facing persona text. */
  readonly persona?: string
  /** Safe capability declarations retained as declarations, not permissions. */
  readonly capabilities?: readonly string[]
}

/** Bot create response. */
export interface BotCreateValue {
  /** The newly active or still-provisioning durable Bot row. */
  readonly bot: BotView
}

/** Bot catalog request; cursor is reserved for a future bounded roster. */
export interface BotListRequest {
  /** Reserved cursor; version one returns the complete visible roster. */
  readonly cursor?: string
  /** Include hidden Bots for the restore surface; the default omits them. */
  readonly includeHidden?: boolean
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

/** Change one Bot's roster placement without changing its Session mapping. */
export interface BotOrganizationUpdateRequest {
  /** Bot whose roster placement should change. */
  readonly botId: BotId
  /** Keep the Bot at the top of its roster section when true. */
  readonly pinned?: boolean
  /** Exclude the Bot from the default roster when true. */
  readonly hidden?: boolean
  /** Roster section name, or null to remove the section. */
  readonly group?: string | null
}

/** Organization update response. */
export interface BotOrganizationUpdateValue {
  /** The committed row. */
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

/** Upload and assign one browser-encoded PNG avatar. */
export interface BotAvatarUploadRequest {
  /** Bot whose avatar should change. */
  readonly botId: BotId
  /** Canonical base64-encoded PNG bytes. */
  readonly data: string
  /** Media type of the encoded image. */
  readonly mediaType: 'image/png'
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

/** One connected MCP app visible to a Bot, with its durable access decision. */
export interface BotConnectedAppAccess {
  /** Stable MCP server namespace used as the connected-app id. */
  readonly id: string
  /** Human-readable connected-app name. */
  readonly name: string
  /** Optional app-provided description of the MCP tools. */
  readonly description?: string | undefined
  /** Whether the selected Bot may call this app's tools. */
  readonly allowed: boolean
}

/** Request the connected MCP apps visible to one Bot. */
export interface BotConnectedAppsRequest {
  /** Bot whose access policy should be returned. */
  readonly botId: BotId
}

/** Connected MCP app catalog and current per-Bot grants. */
export interface BotConnectedAppsValue {
  /** Bot row whose policy was read. */
  readonly bot: BotView
  /** Available apps and their current access decisions. */
  readonly apps: readonly BotConnectedAppAccess[]
}

/** Change one Bot's access to one connected MCP app. */
export interface BotConnectedAppAccessRequest {
  /** Bot whose policy should change. */
  readonly botId: BotId
  /** Stable MCP server namespace. */
  readonly appId: string
  /** Whether to permit this Bot to call the app. */
  readonly allowed: boolean
}

/** Result of a connected MCP app access update. */
export interface BotConnectedAppAccessValue {
  /** Bot row whose policy was changed. */
  readonly bot: BotView
  /** Connected MCP app whose access changed. */
  readonly app: BotConnectedAppAccess
}

/** One host-local skill visible to a Bot and its current grant decision. */
export interface BotSkillAccess {
  /** Stable kebab-case skill name. */
  readonly name: string
  /** Short description supplied by the local skill provider. */
  readonly description: string
  /** Optional provider guidance for deciding when to use the skill. */
  readonly whenToUse?: string
  /** Whether this Bot may discover and load the skill. */
  readonly enabled: boolean
  /** Whether the skill is currently available on this Host. */
  readonly available: boolean
}

/** Request the host-local skills visible to one Bot. */
export interface BotSkillListRequest {
  /** Bot whose skill policy should be returned. */
  readonly botId: BotId
}

/** Host-local skill catalog and current per-Bot policy. */
export interface BotSkillListValue {
  /** Bot row whose policy was read. */
  readonly bot: BotView
  /** Current canonical policy, defaulting to all for legacy rows. */
  readonly policy: BotSkillPolicy
  /** Monotonic revision required for the next policy replacement. */
  readonly revision: number
  /** Available local skills and their current decisions. */
  readonly skills: readonly BotSkillAccess[]
}

/** Replace one Bot's host-local skill policy. */
export interface BotSkillUpdateRequest {
  /** Bot whose skill policy should change. */
  readonly botId: BotId
  /** Revision returned by the latest list; stale replacements are rejected. */
  readonly expectedRevision: number
  /** Whether the Bot receives every skill or only the enabled names. */
  readonly mode: BotSkillPolicy['mode']
  /** Skill names explicitly enabled in selected mode. */
  readonly enabled: readonly string[]
  /** Skill names denied in either mode. */
  readonly disabled: readonly string[]
}

/** Result of a host-local skill policy update. */
export interface BotSkillUpdateValue {
  /** Updated Bot row. */
  readonly bot: BotView
  /** Canonical policy written for the Bot. */
  readonly policy: BotSkillPolicy
  /** Monotonic revision after the policy replacement. */
  readonly revision: number
}

/** Browser-safe view of one active memory owned by a Bot. */
export interface BotMemoryView {
  /** Stable identity used when editing or removing the memory. */
  readonly id: string
  /** User-authored reference text retained by the Bot. */
  readonly text: string
  /** Session-log timestamp of the latest remember operation. */
  readonly createdAt: number
}

/** Request to list the private memories belonging to one Bot. */
export interface BotMemoryListRequest {
  /** Bot whose memory projection should be read. */
  readonly botId: BotId
}

/** Response containing active private memories for one Bot. */
export interface BotMemoryListValue {
  /** Active memories in creation order. */
  readonly memories: readonly BotMemoryView[]
}

/** Request to replace one private memory while retaining its stable id. */
export interface BotMemoryUpdateRequest {
  /** Bot that owns the memory. */
  readonly botId: BotId
  /** Existing memory identity to update. */
  readonly memoryId: string
  /** New non-empty memory text. */
  readonly text: string
}

/** Response containing the updated private memory. */
export interface BotMemoryUpdateValue {
  /** Updated memory row. */
  readonly memory: BotMemoryView
}

/** Remote request to logically remove one private memory. */
export interface BotMemoryForgetRemoteRequest {
  /** Bot that owns the memory. */
  readonly botId: BotId
  /** Existing memory identity to remove. */
  readonly memoryId: string
}

/** Empty response for a successful logical memory removal. */
export interface BotMemoryForgetValue {
  /** Stable response marker for generated remote clients. */
  readonly removed: true
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
    /** The requested connected MCP app is not currently available. */
    'bot/app-not-found': { readonly botId: BotId; readonly appId: string }
    /** A Bot skill policy replacement was based on an older revision. */
    'bot/skill-policy-conflict': {
      readonly botId: BotId
      readonly expectedRevision: number
      readonly actualRevision: number
    }
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
