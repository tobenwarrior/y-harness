# Agents

The **agents** subsystem is [`packages/agents`](../../packages/agents/README.md) — durable user-owned Bot records and the Host-side avatar capability used by the Bot workspace. Each Bot keeps one ordinary Session mapping and one semantic visual identity; generated image bytes remain an explicit attachment choice. Package-specific behavior and browser presentation stay with the [Bot roster README](../../packages/agents/bots/README.md), the [avatar-generation README](../../packages/agents/avatar-generation/README.md), and the [Client workspace README](../../packages/client/ui-bots/README.md).

Shared connected-app calls use a separate per-Bot allowlist and the authenticated shared Session identity. When the composed approval policy asks for a decision, the service stores one durable request in the shared authority and pauses the provider call before its body runs; only the initiating collaborator can list or decide that request, and `allow` authorizes that call once. Requests expire after the configured TTL, defaulting to 15 minutes, and membership or app-grant revocation cancels a waiting request or blocks the later body-admission check. Approval previews expose only bounded JSON arguments with sensitive-looking values redacted; oversized or unsafe values may be omitted or marked truncated.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxavatargeneration--avatargenerationservice"></a>

### `ctx.avatarGeneration` — `AvatarGenerationService`

Host service that discovers the configured OpenAI credential per operation.

```ts cordis-catalog
/**
 * Read current capability state without resolving or returning a secret.
 * @returns whether the existing OpenAI provider can generate an avatar now.
 */
@Remote async status(): Promise<AvatarGenerationStatus>

/**
 * Generate one validated PNG avatar preview through the configured OpenAI route.
 * @param request - bounded natural-language avatar description.
 * @param signal - caller cancellation signal.
 * @returns exact preview bytes for immediate Client display; persistence waits for {@link commit}.
 * @throws {RemoteError} when configuration, provider, response, or attachment admission fails.
 */
@Remote async generate(request: AvatarGenerationRequest, signal: AbortSignal): Promise<AvatarGenerationValue>

/**
 * Persist one preview after the user explicitly chooses it.
 * @param request - canonical preview bytes returned by {@link generate}.
 * @returns the durable image reference for Bot assignment.
 * @throws {RemoteError} when the preview is malformed or attachment admission fails.
 */
@Remote async commit(request: AvatarGenerationCommitRequest): Promise<AvatarGenerationCommitValue>
```

Source: [`packages/agents/avatar-generation/src/index.ts`](../../packages/agents/avatar-generation/src/index.ts)

<a id="ctxbots--botservice"></a>

### `ctx.bots` — `BotService`

Host service that owns the durable roster and its Session mappings.

```ts cordis-catalog
/**
 * Issue one collaborator invite for an operator-owned Bot.
 * @param request - Bot id and role to grant on redemption.
 * @returns the one-time code and its expiry.
 */
@Remote('createShareInvite') async createShareInvite(request: BotShareInviteRequest): Promise<BotShareInviteValue>

/**
 * List the shared members of one operator-owned Bot.
 * @param request - Bot id to inspect.
 * @returns the safe member summaries without private Session data.
 */
@Remote('listShareMembers') async listShareMembers(request: BotShareMembersRequest): Promise<BotShareMembersValue>

/**
 * Read the shared-context policy for one operator-owned Bot.
 * @param request - Bot id to inspect.
 * @returns the current shared-context policy.
 */
@Remote('getShareMemoryPolicy') async getShareMemoryPolicy(request: BotShareMembersRequest): Promise<BotShareMemoryPolicyValue>

/**
 * Enable or disable the explicit shared context for one Bot.
 * @param request - Bot id and desired policy.
 * @returns the committed policy.
 */
@Remote('setShareMemoryPolicy') async setShareMemoryPolicy(request: BotShareMemoryPolicyRequest): Promise<BotShareMemoryPolicyValue>

/**
 * Revoke one non-owner member from one operator-owned Bot.
 * @param request - Bot id and the principal to remove.
 * @returns the scoped revocation result.
 */
@Remote('revokeShareMember') async revokeShareMember(request: BotShareMemberRevokeRequest): Promise<BotShareMemberRevokeValue>

/**
 * Bind peer-Bot operations to the live Agent that owns the current turn.
 *
 * The provider bridge must supply this Agent from its runtime context; the
 * returned client never accepts a model-supplied sender Session id. Each
 * operation rechecks that the Session remains owned by a durable Bot.
 * @param agent - live Agent supplied by the provider bridge or scoped tool.
 * @returns collaboration operations attributed to that Bot.
 */
collaborationFor(agent: Pick<Agent, 'id'>): Promise<BotCollaborationClient>

/**
 * Read the available connected apps and one Bot's current grants.
 * @param request - Bot id whose connected-app policy should be projected.
 * @returns The Bot view and stable connected-app access rows.
 */
@Remote('listConnectedApps') async listConnectedApps(request: BotConnectedAppsRequest): Promise<BotConnectedAppsValue>

/**
 * Read the independent connected-app grants used by shared Bot Sessions.
 * @param request - Bot id whose shared-session policy should be projected.
 * @returns Connected-app metadata and the authority revision for the policy.
 */
@Remote('listSharedAppAccess') async listSharedAppAccess(request: BotSharedAppAccessRequest): Promise<BotSharedAppAccessValue>

/**
 * Change one independent shared-session connected-app grant.
 * @param request - Bot, app, desired grant, and expected policy revision.
 * @returns The refreshed shared-app catalog and committed revision.
 */
@Remote('setSharedAppAccess') async setSharedAppAccess(request: BotSharedAppAccessUpdateRequest): Promise<BotSharedAppAccessValue>

/**
 * Persist one Bot's grant or revoke for a connected app.
 * @param request - Bot id, connected-app id, and desired access state.
 * @returns The updated Bot view and connected-app access row.
 */
@Remote('setConnectedAppAccess') async setConnectedAppAccess(request: BotConnectedAppAccessRequest): Promise<BotConnectedAppAccessValue>

/**
 * Read host-local skill metadata and one Bot's current discovery policy.
 * Bodies, paths, provider handles, and credentials never cross this Remote.
 * @param request - Bot id whose skill view should be projected.
 * @returns the Bot view, canonical policy, and metadata-only skill rows.
 */
@Remote('listSkills') async listSkills(request: BotSkillListRequest): Promise<BotSkillListValue>

/**
 * Persist a canonical host-local skill policy for one Bot.
 * @param request - Bot id and complete replacement policy.
 * @returns the committed Bot view and canonical policy.
 */
@Remote('updateSkills') async updateSkills(request: BotSkillUpdateRequest): Promise<BotSkillUpdateValue>

/**
 * List the durable Bot roster without activating cold Sessions.
 * @param request - Optional hidden-row inclusion for the restore surface.
 * @returns visible rows by default, with pinned rows first and creation time as the stable tie-breaker.
 */
@Remote('list') async list(request: BotListRequest): Promise<BotListValue>

/**
 * List published Bot configuration snapshots, including revoked rows.
 * @param _request - Empty list request reserved for future cursor paging.
 * @returns Published template rows in stable creation order.
 */
@Remote('listTemplates') async listTemplates(_request: BotTemplateListRequest): Promise<BotTemplateListValue>

/**
 * Publish a safe Bot configuration snapshot without runtime or credential fields.
 * @param request - Source Bot and optional display overrides.
 * @returns Newly persisted safe template row.
 */
@Remote('publishTemplate') async publishTemplate(request: BotTemplatePublishRequest): Promise<BotTemplatePublishValue>

/**
 * Revoke one published Bot template while retaining its row for the owner.
 * @param request - Template identity to revoke.
 * @returns The retained template row with its revocation timestamp.
 */
@Remote('revokeTemplate') async revokeTemplate(request: BotTemplateRevokeRequest): Promise<BotTemplateRevokeValue>

/**
 * Preview one active Bot template by exact opaque share code.
 * @param request - Opaque share code to resolve.
 * @returns Safe template configuration used by import.
 */
@Remote('previewTemplate') async previewTemplate(request: BotTemplatePreviewRequest): Promise<BotTemplatePreviewValue>

/**
 * Approve one exact verified portable artifact before it can provision a Bot.
 * @param request - Signed code inspected by the recipient.
 * @returns The verified template marked approved on this Host.
 */
@Remote('approveTemplate') async approveTemplate(request: BotTemplateApproveRequest): Promise<BotTemplateApproveValue>

/**
 * Import an active template as a new Bot with a newly allocated Session.
 * @param request - Opaque share code and optional replacement Bot name.
 * @returns Newly provisioned Bot and the source template row.
 */
@Remote('importTemplate') async importTemplate(request: BotTemplateImportRequest): Promise<BotTemplateImportValue>

/**
 * List durable multi-Bot groups and current member projections.
 * @param request - Group list filters and paging request.
 * @returns Durable group rows with current member projections.
 */
@Remote('listGroups') async listGroups(request: BotGroupListRequest): Promise<BotGroupListValue>

/**
 * Create or idempotently reuse one durable multi-Bot group.
 * @param request - Group name and requested Bot membership.
 * @returns The created or reused durable group.
 */
@Remote('createGroup') async createGroup(request: BotGroupCreateRequest): Promise<BotGroupCreateValue>

/**
 * Update a durable multi-Bot group from the human workspace.
 * @param request - Group identity and requested changes.
 * @returns The updated durable group.
 */
@Remote('updateGroup') async updateGroup(request: BotGroupUpdateRequest): Promise<BotGroupUpdateValue>

/**
 * Read one durable group transcript.
 * @param request - Group identity and transcript query.
 * @returns The group and bounded transcript projection.
 */
@Remote('inspectGroup') async inspectGroup(request: BotGroupInspectRequest): Promise<BotGroupInspectValue>

/**
 * Persist and fan out one human group message to every member Bot.
 * @param request - Group message and optional caller-provided operation id.
 * @returns Per-recipient delivery outcomes.
 */
@Remote('sendGroupMessage') async sendGroupMessage(request: BotGroupSendRemoteRequest): Promise<BotGroupSendValue>

/** Add or remove the owner's fixed reaction on one durable group message.
 * @param request - Group, message, fixed emoji, and explicit add/remove action.
 * @returns The aggregate reaction projection after the idempotent mutation.
 */
@Remote('reactGroupMessage') async reactGroupMessage(request: BotGroupReactionRequest): Promise<BotGroupReactionValue>

/**
 * Read owner-visible recipient fences that require explicit shared-group recovery.
 * This owner Remote returns only the exact identities needed for a later recovery;
 * collaborator endpoints do not mount it.
 * @param request - Recipient Bot to inspect.
 * @returns Exact group, Bot, Session, and message identities without transcript data.
 */
@Remote('inspectSharedGroupDeliveryFences') async inspectSharedGroupDeliveryFences( request: { readonly botId: BotId }, ): Promise<BotSharedGroupDeliveryFenceDiagnosticValue>

/**
 * Admit one owner-local encoded image for an explicitly identified group message.
 * @param request - Group, message, recipient, and encoded image.
 * @returns Opaque grant id and safe image metadata.
 */
@Remote('admitGroupImage') async admitGroupImage(request: BotGroupImageAdmissionRequest): Promise<BotAttachmentGrantValue>

/**
 * Reconcile one isolated shared-group recipient fence after an explicit
 * owner confirmation that every Host able to own the Session is quiesced.
 * @param request - Exact group, Bot, Session, and message identities.
 * @returns The durable recovery status for the recipient fence.
 */
@Remote('recoverSharedGroupDelivery') async recoverSharedGroupDelivery(request: BotGroupDeliveryRecoveryRequest): Promise<BotGroupDeliveryRecoveryValue>

/**
 * Release one abandoned shared-roster admission after every possible Host
 * has been stopped and the exact durable fence token was inspected. The
 * caller must explicitly accept that a paused or partitioned Host cannot be
 * disproven and may race this recovery.
 * @param request - Exact fence token plus the unverified quiescence and race-risk assertions.
 * @returns The durable recovery status.
 */
@Remote('recoverSharedRosterFence') async recoverSharedRosterFence( request: BotSharedRosterFenceRecoveryRequest, ): Promise<BotSharedRosterFenceRecoveryValue>

/**
 * Read the owner-local shared-roster fence needed for explicit recovery.
 * This method is not part of the collaborator endpoint allowlist.
 * @returns The current fence status and, when held, its opaque recovery token.
 */
@Remote('inspectSharedRosterFence') async inspectSharedRosterFence(): Promise<BotSharedRosterFenceDiagnosticValue>

/**
 * List timed and message-triggered routines owned by one Bot.
 *
 * This lookup never activates the Bot Session. Timed rows are read from the
 * Host Schedule catalog and event rows from the Bot record, after checking
 * the configured owner scope.
 * @param request - Bot identity whose routine catalog should be returned.
 * @returns The Bot's active, paused, and ended routine rows.
 */
@Remote('listRoutines') async listRoutines(request: BotRoutineListRequest): Promise<BotRoutineListValue>

/**
 * Pause one routine owned by a Bot without waking its Session.
 * @param request - Bot and routine identity.
 * @returns The paused routine or a bounded lookup/ended result.
 */
@Remote('pauseRoutine') async pauseRoutine(request: BotRoutineLifecycleRequest): Promise<BotRoutinePauseValue>

/**
 * Resume one paused routine owned by a Bot without waking its Session.
 * @param request - Bot and routine identity.
 * @returns The active routine or a bounded lookup/ended result.
 */
@Remote('resumeRoutine') async resumeRoutine(request: BotRoutineLifecycleRequest): Promise<BotRoutineResumeValue>

/**
 * Delete one routine owned by a Bot and its bounded run history.
 * @param request - Bot and routine identity.
 * @returns A stable deletion marker or a bounded lookup result.
 */
@Remote('deleteRoutine') async deleteRoutine(request: BotRoutineLifecycleRequest): Promise<BotRoutineDeleteValue>

/**
 * Read one bounded routine history page without activating the Bot Session.
 * @param request - Bot, routine, page size, and optional timed-delivery cursor.
 * @returns Newest-first timed receipts or event deliveries/results.
 */
@Remote('routineHistory') async routineHistory(request: BotRoutineHistoryRequest): Promise<BotRoutineHistoryValue>

/**
 * Read a private recovered archive without activating the Bot Session.
 * @param request - Bot identity.
 * @returns Recovered history or null if the Bot has no archive.
 */
@Remote('readGrokHistory') async readGrokHistory(request: BotGrokHistoryRequest): Promise<BotGrokHistoryArchive | null>

/**
 * Store a reviewed transcript without delivering it to the Bot or changing its Session.
 * @param request - Existing Bot and versioned transcript JSON.
 * @returns The number of recovered messages.
 */
@Remote('importGrokHistory') async importGrokHistory(request: BotGrokHistoryImportRequest): Promise<{ readonly messages: number }>

/**
 * Import private memories, workspace skills, and paused cron routines into an existing Bot.
 * @param request - Destination Bot, version-one export, and optional preview.
 * @param signal - Cancellation between durable entries. Retrying the same export preserves completed entries.
 * @returns Counts for the selected source Bot and names of missing routine skill definitions.
 */
@Remote('importGrokBot') async importGrokBot(request: BotGrokImportRequest, signal?: AbortSignal): Promise<BotGrokImportValue>

/**
 * List active memories for a Bot without accepting a model-supplied Session id.
 * @param request - Durable Bot id whose private projection should be read.
 * @returns active memory rows owned by that Bot.
 */
@Remote('listMemory') async listMemory(request: BotMemoryListRequest): Promise<BotMemoryListValue>

/**
 * Replace one active memory for a Bot while preserving its stable id.
 * @param request - Bot id, memory id, and replacement text.
 * @returns the updated memory row.
 */
@Remote('updateMemory') async updateMemory(request: BotMemoryUpdateRequest): Promise<BotMemoryUpdateValue>

/**
 * Logically remove one active memory for a Bot.
 * @param request - Bot id and memory id to remove.
 * @returns a stable success marker after the forget event is durable.
 */
@Remote('forgetMemory') async forgetMemory(request: BotMemoryForgetRemoteRequest): Promise<BotMemoryForgetValue>

/**
 * Create one durable Bot and its exactly-one ordinary Session.
 *
 * A provisioning row is committed before Session creation. If Session creation
 * or activation cannot finish, the row remains visible and the same Bot id can
 * be retried safely; no second Session is allocated for that Bot.
 *
 * @param request - Name, visual identity, optional working directory, and preset.
 * @returns the active row or a retryable provisioning row.
 */
@Remote('create') async create(request: BotCreateRequest): Promise<BotCreateValue>

/**
 * Resolve a server-owned Bot by its exact backing Session.
 * @param sessionId - Session identity from the live Agent or authenticated UI.
 * @returns The owner Bot, including provisioning state, or undefined for other Sessions.
 */
async ownerBotForSession(sessionId: string): Promise<{ readonly id: BotId readonly sessionId: SessionId readonly state: 'active' | 'provisioning' } | undefined>

/**
 * Rename one Bot while preserving its one Session mapping and visual identity.
 * @param request - Bot id and new display name.
 * @returns the committed row.
 */
@Remote('rename') async rename(request: BotRenameRequest): Promise<BotRenameValue>

/**
 * Update a Bot's user-authored profile without changing its Session binding.
 * @param request - Bot id and profile fields; null clears optional text or declarations.
 * @returns the committed row.
 */
@Remote('updateProfile') async updateProfile(request: BotProfileUpdateRequest): Promise<BotProfileUpdateValue>

/**
 * Update a Bot's roster placement without changing its Session mapping.
 * @param request - Bot id and at least one pin, hidden, or section change.
 * @returns the committed row.
 */
@Remote('updateOrganization') async updateOrganization(request: BotOrganizationUpdateRequest): Promise<BotOrganizationUpdateValue>

/**
 * Update a Bot's semantic identity and/or accent without creating or changing
 * its one backing Session. Generated avatars remain selected unless the
 * caller explicitly sets `clearAvatar` to true.
 * @param request - Bot id, optional appearance fields, and optional avatar clear.
 * @returns the committed row.
 */
@Remote('updateAppearance') async updateAppearance(request: BotAppearanceUpdateRequest): Promise<BotAppearanceUpdateValue>

/**
 * Persist or clear a generated avatar while preserving the Bot's Session mapping.
 * @param request - Bot id and generated avatar payload, or null to clear it.
 * @returns the updated Bot row.
 */
@Remote('updateAvatar') async updateAvatar(request: BotAvatarUpdateRequest): Promise<BotAvatarUpdateValue>

/**
 * Admit and assign a user-selected PNG without requiring image generation.
 * @param request - Bot identity and canonical base64 PNG bytes.
 * @returns The Bot with its newly assigned avatar.
 */
@Remote('uploadAvatar') async uploadAvatar(request: BotAvatarUploadRequest): Promise<BotAvatarUpdateValue>

/**
 * Read the current Bot avatar through the Host attachment store.
 * @param request - Bot id whose selected avatar should be returned.
 * @returns canonical reference and bytes for a Client preview.
 */
@Remote('readAvatar') async readAvatar(request: BotAvatarReadRequest): Promise<BotAvatarReadValue>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/agents/bots/src/index.ts`](../../packages/agents/bots/src/index.ts)

<a id="bots-events"></a>

### `bots/*` events

<a id="botschanged--emit"></a>

#### `bots/changed` — emit

Post-commit notification for roster writes; listeners refetch `bots.list`.

```ts cordis-catalog
/**
 * Post-commit notification for roster writes; listeners refetch `bots.list`.
 * @mode emit
 */
'bots/changed'(): void
```

Source: [`packages/agents/bots/src/types.ts`](../../packages/agents/bots/src/types.ts)
<!-- END GENERATED cordis-surface -->
