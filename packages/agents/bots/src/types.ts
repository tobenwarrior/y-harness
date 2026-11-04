/** Browser-safe Bot requests, durable values, and Remote failure vocabulary. */

import { brandString, type Branded } from '@yharness/brand'
import type { ImageAttachmentRef } from '@yharness/attachment'
import type { MessageId } from '@yharness/llm/brand'
import type { SessionId } from '@yharness/session/types'
import type { BotPrincipalId, BotShareRole } from './sharing.ts'

/** Stable user-owned identity for one roster entry. */
export type BotId = Branded<'BotId'>

/** Opaque identity for one explicitly published shared-context note. */
export type BotShareMemoryId = Branded<'BotShareMemoryId'>

/** Apply the Bot identity brand to a value already admitted by the owner.
 * @param value - String value already validated as a Bot id.
 * @returns The branded Bot id.
 */
export function BotId(value: string): BotId {
  return brandString<BotId>(value)
}

/** Apply the shared-note identity brand to a validated storage or wire value.
 * @param value - String already validated as a shared-note id.
 * @returns The branded shared-note id.
 */
export function BotShareMemoryId(value: string): BotShareMemoryId {
  return brandString<BotShareMemoryId>(value)
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

/** Operator request to issue a one-time collaborator invite. */
export interface BotShareInviteRequest {
  /** Bot to share. */
  readonly botId: BotId
  /** Role granted by the invite. */
  readonly role: BotShareRole
}

/** Operator response containing a one-time collaborator invite. */
export interface BotShareInviteValue {
  /** Opaque code to deliver to the intended collaborator. */
  readonly code: string
  /** Absolute expiry of the code. */
  readonly expiresAt: number
}

/** Safe owner-facing summary of one person allowed to use a shared Bot. */
export interface BotShareMember {
  /** Bot whose member list contains this person. */
  readonly botId: BotId
  /** Authenticated principal minted by the shared access authority. */
  readonly principalId: BotPrincipalId
  /** Access level granted to the person. */
  readonly role: BotShareRole
  /** Person who granted this membership. */
  readonly grantedBy: BotPrincipalId
  /** Membership creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last membership mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Owner request to read one Bot's shared membership roster. */
export interface BotShareMembersRequest {
  /** Bot whose members should be listed. */
  readonly botId: BotId
}

/** Owner response containing the selected Bot's shared membership roster. */
export interface BotShareMembersValue {
  /** Bot whose members are returned. */
  readonly botId: BotId
  /** Current memberships, including the owner. */
  readonly members: readonly BotShareMember[]
}

/** Owner request to revoke one non-owner shared Bot member. */
export interface BotShareMemberRevokeRequest {
  /** Bot whose membership should be revoked. */
  readonly botId: BotId
  /** Authenticated principal to remove from this Bot only. */
  readonly principalId: BotPrincipalId
}

/** Owner response after a shared Bot member is revoked. */
export interface BotShareMemberRevokeValue {
  /** Bot whose membership changed. */
  readonly botId: BotId
  /** Principal removed from the selected Bot. */
  readonly principalId: BotPrincipalId
  /** Always true after the durable deletion commits. */
  readonly revoked: true
}

/** Operator request to change whether one Bot publishes shared context. */
export interface BotShareMemoryPolicyRequest {
  /** Bot whose shared-context policy should change. */
  readonly botId: BotId
  /** Whether members may read and publish shared context. */
  readonly enabled: boolean
}

/** Shared-context policy returned to an operator or collaborator. */
export interface BotShareMemoryPolicyValue {
  /** Bot whose policy is returned. */
  readonly botId: BotId
  /** Whether shared context is enabled. */
  readonly enabled: boolean
  /** Last policy mutation timestamp. */
  readonly updatedAt: number
}

/** One note explicitly published to a Bot's shared context. */
export interface BotShareMemoryEntry {
  /** Stable entry id. */
  readonly id: BotShareMemoryId
  /** Authenticated member who published the note. */
  readonly principalId: BotPrincipalId
  /** Bounded note text. */
  readonly text: string
  /** Entry creation timestamp. */
  readonly createdAt: number
}

/** Shared-context response for one authenticated member. */
export interface BotShareMemoryValue extends BotShareMemoryPolicyValue {
  /** Notes visible to every member while shared context is enabled. */
  readonly entries: readonly BotShareMemoryEntry[]
}

/** Shared-context write carrying a caller acknowledgement; membership and Bot policy authorize it independently. */
export interface BotShareMemoryWriteRequest {
  /** Bot whose context receives the note. */
  readonly botId: BotId
  /** Bounded note text. */
  readonly text: string
  /** Must be true when the caller knowingly publishes to all members; this acknowledgement is not an authorization credential. */
  readonly consent: true
}

/** Shared-context write response. */
export interface BotShareMemoryWriteValue {
  /** Newly published note. */
  readonly entry: BotShareMemoryEntry
}

/** Explicit owner assertion used to release one abandoned shared-roster fence. */
export interface BotSharedRosterFenceRecoveryRequest {
  /** Exact durable fence token observed before every possible Host was stopped. */
  readonly token: string
  /** Unverified assertion that no Host can still own the shared-roster admission. */
  readonly confirmQuiescent: true
}

/** Result of explicit owner-local shared-roster fence recovery. */
export interface BotSharedRosterFenceRecoveryValue {
  /** Durable recovery result. */
  readonly status: 'released' | 'busy' | 'absent'
}

/** Safe Bot profile returned through the collaborator-only route. */
export interface BotShareProfile {
  /** Stable Bot identity. */
  readonly id: BotId
  /** User-visible display name. */
  readonly name: string
  /** Optional role description. */
  readonly description?: string
  /** Semantic character family. */
  readonly identity: BotIdentity
  /** Accent family. */
  readonly accent: BotAccent
  /** Optional generated avatar reference. */
  readonly avatar?: BotAvatar
  /** Provisioning state. */
  readonly state: BotProvisioningState
  /** Live availability. */
  readonly availability: BotAvailability
}

/** Shared roster row visible to one authenticated collaborator. */
export interface BotShareRosterEntry extends BotShareProfile {
  /** Membership role for the authenticated collaborator. */
  readonly role: BotShareRole
}

/** Transcript entry projected from a collaborator's private Bot Session. */
export interface BotShareTranscriptEntry {
  /** Visible speaker role; tool and reasoning blocks are omitted by the Host. */
  readonly role: 'user' | 'assistant'
  /** Bounded visible text. */
  readonly text: string
}

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
  /** Stable source message identity used to deduplicate inbox and surface events. */
  readonly triggerMessageId?: MessageId | undefined
  /** Stable message id used for retrying delivery after a restart. */
  readonly messageId: MessageId
  /** Cross-Bot routine chain identity, when this delivery came from a peer Bot. */
  readonly chainId?: string | undefined
  /** Number of Bot-to-Bot hops already traversed by this delivery. */
  readonly depth?: number | undefined
  /** Whether the follow-up was persisted in the Bot Session. */
  readonly status: 'pending' | 'delivered'
  /** Time the Host durably recorded an invocation of Agent.followup. */
  readonly dispatchStartedAt?: string | undefined
  /** Time the event was admitted to this routine. */
  readonly createdAt: string
  /** Time Session persistence acknowledged the follow-up. */
  readonly deliveredAt?: string | undefined
}

/** Durable identity retained after an old routine delivery is pruned. */
export interface BotEventRoutineAdmissionTombstone {
  /** Session event sequence that was already considered for this routine. */
  readonly triggerEventSeq: number
  /** Stable source message identity when the source event provided one. */
  readonly triggerMessageId?: MessageId | undefined
}

/** Completed model result associated with one event-trigger delivery. */
export interface BotEventRoutineResult {
  /** Event-trigger message whose turn produced this result. */
  readonly messageId: MessageId
  /** Turn-ending reason, excluding private model reasoning. */
  readonly status: 'completed' | 'error' | 'aborted' | 'blocked' | 'max-tokens' | 'interrupted' | 'forked' | 'other'
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
  /** Highest source event sequence durably considered for this routine. */
  readonly admissionWatermark?: number | undefined
  /** Source identities retained when delivery records are pruned. */
  readonly admissionTombstones?: readonly BotEventRoutineAdmissionTombstone[] | undefined
  /** Bounded completed model results, oldest first. */
  readonly results: readonly BotEventRoutineResult[]
}

/** Browser/native view of one Bot event routine. */
export type BotEventRoutineView = Omit<BotEventRoutine, 'deliveries' | 'results'> & {
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
  /** Bot-scoped message routines; absent on rows written before event routines existed. */
  readonly eventRoutines?: readonly BotEventRoutine[] | undefined
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
  /** Whether the row has completed Session provisioning. */
  readonly state: BotProvisioningState
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last durable roster mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Browser-facing roster row enriched with live availability and no private fields. */
export type BotView = Omit<BotRecord, 'ownerId' | 'eventRoutines'> & {
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

/** Replace the user-authored profile fields without changing the Bot's Session. */
export interface BotProfileUpdateRequest {
  /** Bot whose profile should change. */
  readonly botId: BotId
  /** Optional row revision captured when an edit dialog opened. */
  readonly expectedUpdatedAt?: number
  /** Optional replacement display name. */
  readonly name?: string
  /** Replacement routing description, or null to clear it. */
  readonly description?: string | null
  /** Replacement model-facing persona, or null to clear it. */
  readonly persona?: string | null
  /** Replacement capability declarations, or null to clear them. */
  readonly capabilities?: readonly string[] | null
}

/** Bot profile update response. */
export interface BotProfileUpdateValue {
  /** The committed row with its existing Session binding. */
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
    /** A shared profile write observed a newer Bot row and must be retried. */
    'gateway/conflict': { readonly botId: BotId }
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
