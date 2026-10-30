# Agents

The **agents** subsystem is [`packages/agents`](../../packages/agents/README.md) — durable user-owned Bot records and the Host-side avatar capability used by the Bot workspace. Each Bot keeps one ordinary Session mapping and one semantic visual identity; generated image bytes remain an explicit attachment choice. Package-specific behavior and browser presentation stay with the [Bot roster README](../../packages/agents/bots/README.md), the [avatar-generation README](../../packages/agents/avatar-generation/README.md), and the [Client workspace README](../../packages/client/ui-bots/README.md).

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
 * List the durable Bot roster without activating cold Sessions.
 * @param _request - Empty list request reserved for future paging.
 * @returns one row per Bot, ordered by creation time and id.
 */
@Remote('list') async list(_request: BotListRequest): Promise<BotListValue>

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
 * Rename one Bot while preserving its one Session mapping and visual identity.
 * @param request - Bot id and new display name.
 * @returns the committed row.
 */
@Remote('rename') async rename(request: BotRenameRequest): Promise<BotRenameValue>

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
 * Read the current Bot avatar through the Host attachment store.
 * @param request - Bot id whose selected avatar should be returned.
 * @returns canonical reference and bytes for a Client preview.
 */
@Remote('readAvatar') async readAvatar(request: BotAvatarReadRequest): Promise<BotAvatarReadValue>
```

Types: [Agent](core.md)

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
