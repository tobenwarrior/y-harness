---
description: "Durable user-owned Bot roster with one persistent Session per Bot, including stable visual identity, event routines, and optional generated avatars."
kind: "package-reference"
---

# @yharness/bots

## Summary

Create a durable Bot roster with stable identities and one persistent Session per Bot. Web workspaces reopen Bots after Host restarts; routines react to user or peer-Bot messages and retain bounded delivery and result history. Bots support roster organization, untrusted memory, durable groups, per-Bot connected-app grants, and safe portable templates. Signed templates share profile, persona, declared capabilities, avatar bytes, and preset without Sessions, paths, transcripts, or credentials; each Host independently approves imports and admits avatars before creating local Sessions. Animated characters remain the default presentation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this Host plugin when a composition needs user-owned Bots that map one-to-one to ordinary Sessions. The roster is exposed through the Bot Remote and does not replace ordinary Session navigation. Each Bot scope receives tools to list, inspect, message, create, edit, remember, list memory, and forget memory, plus membership-scoped group inspection, creation, update, and delivery; a native provider may expose the same actions through its own tool bridge. When Connection and credentials are present, the plugin also mounts the isolated self-hosted shared-Bot route.

The Bot Remote also exposes `listConnectedApps` and `setConnectedAppAccess`. The Client uses these methods for the selected Bot's Connected apps dialog. The catalog is derived from MCP tool definitions' Host-only source metadata and visible MCP resource servers; public names are not parsed because server and tool names may contain `__`. A grant is checked in the Bot Agent scope before approval, rechecked after approval, and checked again at the last-mile tool-body boundary after async wrappers settle, so hiding a control or revoking during a wait cannot bypass the policy.

The Bot Remote also exposes `updateProfile` for owner-side editing of the name, role description, persona, and declared capabilities. Callers may supply the `expectedUpdatedAt` revision captured when an edit began; a changed Bot returns `gateway/conflict` without applying the stale draft. The mutation uses the same durable profile revision fence as rename and appearance updates, preserves the Bot's one Session, working directory, and preset, and treats capability values as model-facing declarations rather than permission grants. `null` clears an optional description, persona, or declaration list; provider and model switching remain outside this operation.

### When to choose it

Choose this package when a Web surface needs named agents with durable visual identity, retryable provisioning, and one retained Session per row. Use the ordinary Session list instead when users should browse arbitrary conversations rather than a curated Bot roster.

### Configuration

The plugin accepts an optional deployment-local template owner key. Mount it with the storage domain, Session controller, Agent registry, system prompt service, tool runtime, attachment provider, and (for shared access) Connection and credentials supplied by the composition:

```yaml
- name: '@yharness/bots'
```

| Field | Default | Meaning |
|---|---|---|
| `shared.enabled` | `true` | Mount shared-Bot enrollment and collaborator routes when Connection and credentials are available. |
| `shared.sessionMaxAgeMs` | 30 days | Maximum collaborator cookie lifetime. |
| `shared.inviteMaxAgeMs` | 15 minutes | Maximum unused invite lifetime. |
| `shared.secureCookie` | `false` | Mark collaborator cookies Secure; required with network `trustedHosts`. |
| `shared.trustedHosts` | `[]` | Additional exact authorities accepted by the shared route. |
| `shared.membershipPollIntervalMs` | 1 second | Maximum delay before cross-process membership revocation cancels active private turns. |
| `ownerId` | `local-owner` | Scope for publishing, listing, and revoking locally owned template rows; it is never embedded in a portable code. |

The Bot Remote also exposes `listTemplates`, `publishTemplate`, `revokeTemplate`, `previewTemplate`, `approveTemplate`, and `importTemplate`. Publication signs the Bot name, description, character, accent, persona, declared capabilities, portable avatar bytes, and optional Agent preset without including local runtime identities, and is allowed only for a Bot owned by the configured `ownerId`. A target Host verifies the signature and requires explicit approval of the exact preview fingerprint plus the resolved local preset and sorted tool view before a copied code can create a Bot; the preview exposes the self-asserted signing-key fingerprint, profile, persona, declared capabilities, portable avatar, and target-local effective preset/tool view so the user can make that trust decision. A resolved preview also returns an ephemeral Host-local approval token; `approveTemplate` must receive that token and the exact permission view from the same preview, so a preset or tool-permission change is rejected before any durable approval is written. Approval fails closed when that local view is unavailable, and the Host re-resolves and compares the stored view for every import, including idempotent retries and direct callers, so preset or tool-permission changes require approval again. The target then resolves its own Session, working directory, preset, and attachment reference. Supplying `importId` makes import idempotent for a caller operation: the durable binding is reserved before avatar admission and provisioning, so retries return the original Bot after a transient failure, rename, or source revocation, while different code or name metadata is rejected. Revocation is owner-scoped and Host-local: it blocks new preview/import requests that reach that Host, but it cannot revoke a copied artifact or an already imported Bot on another Host.

### Durable lifecycle

Creation writes a `provisioning` row before it asks the Session controller to activate the explicit Session id. A failed activation leaves the row and both ids available for retry. Repeating a request with the same id and metadata adopts that row; a metadata mismatch is rejected rather than silently changing the Bot. Profile edits update only the user-authored fields on the existing row and never allocate or replace its Session.

### Visual identity and avatars

The Host accepts only the exported `BOT_IDENTITIES` and `BOT_ACCENTS` values, so the Client can map them to its own animated character components and design tokens. `updateAppearance` changes either family in place and keeps the one Session mapping. The first open after the animated character rollout removes selected image references from existing Bot rows while leaving their attachment data untouched; the durable marker makes this migration run once. A generated avatar is a verified `ImageAttachmentRef`; `updateAvatar` persists its canonical reference for future explicit selection, `uploadAvatar` validates and stores a user-selected PNG without an image-generation provider, `readAvatar` returns verified bytes for a preview, and `avatar: null` restores the semantic identity avatar.

### Durable memory

`remember_bot_memory` appends a `bot/memory` Session event and waits for the normal Session flush barrier before returning a memory receipt. `list_bot_memory` returns only active ids and timestamps, while `forget_bot_memory` appends a logical deletion event. Forgetting removes the entry from future memory prompts; the append-only Session log and prompts already sent to a model are not erased. Durable forget tombstones make a repeated forget idempotent after a Session restart. Memory text is bounded and presented as untrusted user-provided reference data, not as an instruction-isolation guarantee. Memory writes and deletions are approval-gated in both ordinary and native tool bridges. Ordinary scoped calls without `memoryId` derive a stable sender-and-text identity, so repeating identical normalized text reuses one active memory; supply distinct explicit ids when identical text should be retained as separate memories. Edits save a private recovery intent before appending the forget and replacement events, so an interrupted flush or restart can finish the replacement without exposing the intent in Bot roster views. Native retries recover an unsettled call's id from the Bot event log, while an explicit `memoryId` is the way to deduplicate intentionally across independent native turns.

### Shared Bot policy foundation

`SharedBotService` persists memberships, one-time invite associations, one private Session binding per `(Bot, principal)` pair, and durable private-session revocation tombstones in the `agent_bot_shares` domain. Pair rows use `shared-v2_<bot-id>_<principal-id>` keys, where the underscore delimiter is excluded by both stored id schemas. Startup copies the prior percent-encoded colon keys to those path-safe keys before deleting the old rows; malformed or conflicting pairs fail closed. The copy/delete sequence is idempotent across concurrent current Hosts and retries after a durable write failure. Authority snapshots and invite rows are not rewritten by this migration. Upgrade all Hosts before reopening a shared store; a pre-migration binary must not write legacy keys during the migration. A credential-backed membership snapshot is refreshed before each operation and by a bounded watcher, so a second Host process observes membership revocation without relying on its in-memory table. The dedicated `/shared-bots` route accepts only `SHARED_BOT_ENDPOINTS`; it never mounts ordinary operator Remote APIs. Enrollment binds the cookie to the request authority, and every request derives its principal from the authenticated shared Peer; redeeming another invite while that cookie is active extends the same principal to the new Bot. `owner`, `manager`, and `collaborator` roles authorize membership operations and shared-context reads or writes; manager profile edits are currently disabled because the separate authority and Bot-row stores do not yet provide one crash-atomic authorization transaction. Shared group state is stored inside the credential-backed authority extension, with an explicit owner/member ACL, one-time group invites, a revisioned Bot roster, per-recipient delivery records, and a durable isolated `shared-bot` Session binding for each group Bot. A principal must hold an active membership on every group Bot and an explicit group ACL entry before the route returns the group or delivers a message. These Sessions use a separate working directory, expose only the Bot name, id, and role description in the shared identity prompt, exclude operator persona and capability declarations, and never read or append the owner-local group domain or private Bot transcript. Reads of the unreleased v1 snapshot derive response reservations for pre-reservation active deliveries; current writes persist the field explicitly. The authority lock reserves the message, per-recipient rows, and response capacity before fan-out; each recipient rechecks the sender principal, current Bot memberships, ACL, and exact Session binding immediately before dispatch. Recipient admission writes a durable per-Session/message fence before enqueue and flush. That fence is non-expiring while the admission is uncertain, so a timeout or late flush cannot reuse the token; the Session log is reconciled before the fence is released or the receipt is accepted. An unresolved admission remains busy rather than risking duplicate delivery. Recovery processes bounded pending batches with bounded concurrency and fair pagination that skips rows already scheduled for backoff; it retries only pending rows with a live response reservation and never reclaims failed rows by itself. A revocation blocks dispatches not yet admitted; a dispatch already in progress may finish, but its durable row cannot be changed back from a concurrent failure. The service never extends a full transcript and cannot revoke a copied transcript or a message another Host already persisted. Local operator groups remain available. Revocation removes membership, marks its private Session binding inaccessible until active Agents quiesce, and closes the authority's access.

Operator profile mutations update a credential-backed revision fence through a pending-row transaction. A crash between the Bot-row write and revision commit is repaired from the pending record, and a Host with a stale Bot domain receives a conflict instead of overwriting a newer rename, description, appearance, or avatar update. Owner-side collaborator invites are authorized against the current authority record in the same mutation that records the invite. Shared-context storage is bounded to 256 Bot policies, 4,096 entries per authority record, and 512 entries per Bot. The write `consent` field is a caller acknowledgement; membership authorization and the Bot's enabled policy remain the security checks.

Peer delivery uses a credential-backed, cross-process message ledger and the recipient Session log as its crash-recovery receipt. The ledger retains up to 4,096 message identities; when full, it scans the complete bounded ledger and prunes only accepted identities whose exact shared-group source and isolated Session metadata are still present, including retired Sessions without a live Host binding. Otherwise it returns a retryable capacity error rather than evicting an unproven receipt. A live foreign admission lease is reported as pending/busy, never as a duplicate. Each new admission holds an exclusive lock in the isolated Session directory across follow-up, flush, and receipt commit. Shared-group admissions disable PID-based lock takeover because a shared filesystem may be mounted by Hosts with different PID namespaces; they fail closed when a sidecar remains. A fence whose recipient Session log cannot prove delivery returns `recovery: 'operator-required'`, is durably marked failed in the shared-group transcript, and is not retried indefinitely. After quiescing every Host that could own the exact Session, an owner may call `recoverSharedGroupDelivery` with `confirmQuiescent: true`, the exact `groupId`, `botId`, `sessionId`, and `messageId`; `confirmQuiescent` is only an owner assertion, not a probe or verified fact, so a false assertion can race a live admission. The action removes only that sidecar, acquires a fresh lock without PID takeover, re-inspects the Session, and either records acceptance or releases the fence for the same message-id retry. A racing Host returns a busy/operator-required result. The operation is available on a fresh Host and does not rely on an in-memory takeover proof. The service never deletes an uncertain fence automatically, and transient inspections use bounded retries before requiring the same explicit action.

The enrollment endpoint is `/shared-bots/bots/share/enroll`; an operator issues its one-time code through `ctx.remote.bots.createShareInvite`, reads the Bot-scoped roster with `listShareMembers`, reads or changes the shared-context policy with `getShareMemoryPolicy` and `setShareMemoryPolicy`, and removes non-owner members with `revokeShareMember`. Shared HTTP requests use `bots/share/list`, `bots/share/read-profile`, `bots/share/read-private-chat`, `bots/share/chat`, `bots/share/manage-members`, `bots/share/read-memory`, `bots/share/write-memory`, `bots/share/manage-memory`, `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members`; `bots/share/manage-profile` remains withheld. Network deployments must use TLS, configure matching `trustedHosts` on Connection and Bots, and set `shared.secureCookie: true`. Each shared request and the bounded membership watcher refreshes the durable membership record; a process that observes a remote Bot revocation aborts that principal's active private turn and rejects subsequent requests, while the authority sweep closes revoked cookies within its bounded interval.

Private chat durability checkpoints are bounded for the caller. If a Host flush ignores cancellation or exceeds the checkpoint deadline, the shared request chain can continue and the underlying flush remains tracked; service disposal waits for tracked flushes and quiescence only up to the shared cancellation deadline before closing the shared-Bot domain, and unresolved operations remain inaccessible to the service. A binding whose backing Session no longer exists is removed during the next private chat or transcript read; chat creates a replacement Session and transcript reads return an empty conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns the durable `agent_bots` roster domain and, when no credential provider is mounted, a separate version-one `agent_bot_intents` write-ahead domain, plus an additive group domain. It serializes writes that can allocate or update a Bot or group and validates stored keys and Session mappings before the service becomes ready. A pending no-credentials intent is retried before a later mutation and replayed by the next roster read after restart; older BotService versions do not consume this domain, so mixed-version operation is unsupported while a pending intent may exist. The service keeps provisioning rows durable across activation failures, while list and read operations project the stored row without waking a cold Session. `bots.list` omits hidden rows unless `includeHidden` is true and orders pinned rows before the stable creation-time order; `updateOrganization` changes pin, hidden, and section placement atomically. Group messages have durable per-recipient delivery records, so retries resume failed recipients instead of sending a second copy to already accepted Sessions. Group delivery projections reconcile asynchronously when an Agent is created or resumed, with retries after inspection failures. Scoped group tools derive retry identities from the authenticated Bot and request contents rather than an ephemeral tool call id, while the Client persists pending operation ids and reconciles only the exact pending id before a retry.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Bot Remote methods, lifecycle serialization, Session provisioning, scoped prompt/tools, and attachment admission. |
| [`src/collaboration.ts`](src/collaboration.ts) | Provider-neutral roster inspection, bounded transcript projection, and durable peer delivery. |
| [`src/inbox.ts`](src/inbox.ts) | Durable inbox-splice folding for routine and peer-delivery reconciliation. |
| [`src/routine-tools.ts`](src/routine-tools.ts) | Bot-scoped event-routine tool schemas and approval policy layered over Host Schedule. |
| [`src/group-chat.ts`](src/group-chat.ts) | Durable 2–6-member groups, transcript projection, per-recipient delivery state, and response projection. |
| [`src/scoped-tools.ts`](src/scoped-tools.ts) | Ordinary Agent-scoped collaboration, group, and connected-app tool schemas plus approval policy. |
| [`src/template-types.ts`](src/template-types.ts) | Browser-safe template requests, safe configuration views, share-code brands, and Remote errors. |
| [`src/template-codec.ts`](src/template-codec.ts) | Signed portable code encoding, Ed25519 verification, bounded payload validation, and content fingerprints. |
| [`src/template-storage.ts`](src/template-storage.ts) | Owner-scoped durable template rows and Host-local signing-key storage. |
| [`src/native-tools.ts`](src/native-tools.ts) | Native-provider action adapter and bounded durable action observations. |
| [`src/memory.ts`](src/memory.ts) | Bot memory event vocabulary, validation, projection, and provider-facing operations. |
| [`src/sharing.ts`](src/sharing.ts) | Explicit shared-Bot roles, fail-closed authorization, and private-conversation routing primitives. |
| [`src/shared-service.ts`](src/shared-service.ts) | Shared-Bot enrollment, private Sessions, shared route dispatch, and revocation. |
| [`src/shared-group.ts`](src/shared-group.ts) | Authority-backed group ACLs, isolated shared-group Session bindings, transcript projection, and idempotent delivery. |
| [`src/storage.ts`](src/storage.ts) | Durable Bot domain, record schema, and image-reference validation. |
| [`src/types.ts`](src/types.ts) | Browser-safe Bot ids, identities, accents, views, requests, and Remote error details. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the Bot roster is not enough. They move from the package group to the Session and attachment owners.

- [Agents package map](../README.md) — adjacent Host agent packages.
- [Session controller](../../api/session-controller/README.md) — creates and resumes the Session linked to each Bot.
- [Attachment service](../../attachment/attachment/README.md) — owns validated image references used by generated avatars.
- [Client Bot workspace](../../client/ui-bots/README.md) — presents the roster and selected Bot conversation.

<a id="model-experience"></a>
## Model Experience

### Bot session selection

#### What the model sees

Selecting a Bot through `ctx.remote.bots` opens its linked ordinary Session; model-visible history remains owned by that Session and its composed plugins. While a Bot Agent is live, its scope and the native Codex provider expose `list_bots` and `inspect_bot` for roster metadata and bounded visible transcript inspection, together with `list_bot_groups`, `inspect_bot_group`, `create_bot_group`, `update_bot_group`, and `send_bot_group_message` for groups that include the calling Bot. `send_bot_message`, `create_bot`, `edit_bot_profile`, `remember_bot_memory`, `forget_bot_memory`, `create_bot_group`, `update_bot_group`, and `send_bot_group_message` are approval-gated actions; `list_bot_memory` is read-only. When the selected Agent preset mounts `@yharness/tool-schedule` and the Host Schedule service is available, the Bot reuses `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`, `schedule_pause`, `schedule_resume`, and `schedule_history`; every time-based routine remains bound to the Bot's one Session and is delivered there after restart. Bot-specific `schedule_event_create`, `schedule_event_list`, `schedule_event_update`, `schedule_event_delete`, `schedule_event_pause`, `schedule_event_resume`, and `schedule_event_history` tools manage message-triggered routines. Event routines support `event: { type: "message", source: "bot" | "user" }`; deliveries are durable, queued inbox admissions are reconciled without duplicate messages, paused routines retain pending deliveries until resumed, and history includes a bounded completed model-result projection with visible assistant text and terminal status. Roster views omit routine prompts, deliveries, and results; only the owning Bot's scoped routine history can read those details. Peer messages carry a bounded routine-chain marker so Bot-triggered routines cannot relay indefinitely. Picture generation uses the configured OpenAI avatar service and reports failure when it is unavailable.

#### Token effect

The collaboration tool descriptions and any returned roster/transcript data consume tokens only when the model uses them. A selected Session pays the tokens for its own history and current request.

#### KV Cache effect

The roster does not modify request prefixes until the scoped collaboration tools are assembled. Cache reuse follows the selected Session's existing model route and history; a changed Bot roster or tool schema may change the provider prefix.

### Bot identity

#### What the model sees

When an owner-local Bot Session is created or resumed, the Host adds a scoped system-prompt section with the Bot's current name, optional role description, persona, and declared capabilities. Collaborator shared Sessions receive only the public name, id, and role description. The section is assembled for every model route, including the native Codex backend, and a rename is reflected on the next request without creating a second Session or rewriting earlier history. A shared Session resumed with legacy private system-prompt history starts a fresh request series so the public projection replaces that model-visible prompt surface; append-only history is retained for audit but is not sent to the model. The replacement is written under the current open step or a fresh valid maintenance turn, never by appending a closed historical coordinate; if a durability attempt fails, admission remains fenced until a later retry flushes the pending migration. The LLM boundary then admits only the marked agent-loop request or an audited session-title and skill-learning envelope with no tool declarations, rejecting compaction, raw, tool-history, and unattributed calls before adapter dispatch. Ambient calls must carry the exact shared Session initiator unless they use that audited auxiliary capability; a missing Bot row remains fenced rather than becoming a marker-only shared Session. The scoped MCP tool runtime exposes `list_connected_apps` so a Bot can explain why an app is unavailable; the native Codex action bridge does not expose that catalog because its actions cannot dispatch MCP app tools.

#### Token effect

Each owner-local Bot request pays for the short identity section and optional role description, persona, and capability declaration; a collaborator shared request receives the shorter public projection.

#### KV Cache effect

The identity text stays prefix-stable until the Bot name or role description changes. A rename changes the system prompt for later requests while preserving the reusable prefix before the changed section.

### Connected-app access

#### What the model sees

The scoped model runtime can call `list_connected_apps` to see the MCP app catalog and each Bot's grant. An ordinary MCP tool or shared MCP resource operation whose named server is not granted fails before its body runs with a message that names the app and directs the user to Bot settings. The denial retains `BOT_APP_ACCESS_REQUIRED` structured metadata for Host routing while the model sees only the concise reason. If the durable Bot row is unavailable, MCP app execution also fails closed instead of treating missing policy as approval. The user can grant or revoke access from the connected-app dialog; the decision is durable and applies to later scoped MCP tool calls. Native Codex actions do not claim access to this catalog: their provider-independent action surface cannot dispatch an MCP app tool.

#### Token effect

The list tool and an access-denial message consume tokens only when the Bot calls an app or asks for the catalog. Access checks do not add a model-visible turn when a granted tool runs.

#### KV Cache effect

Changing a Bot grant does not rewrite Session history. The scoped tool set remains stable; only the result of a later app call changes.

### Bot collaboration

#### What the model sees

The service derives the sending identity from the live Bot Agent and rechecks the durable roster for every operation. Inspection excludes reasoning and tool blocks, and generic peer inspection removes user and assistant messages from turns containing group or routine inputs; use membership-scoped group inspection for that transcript. Group inspection frames every message as untrusted quoted data. A delivered message is framed with the sender's current name and persisted in the recipient's existing Session as an `agent-message`, so it becomes ordinary user context on the recipient's next turn. Native Codex actions also persist a required `bot/dynamic-tool` lifecycle record with the exact model-visible result. When a native cursor is lost, the Codex bridge replays a bounded, explicitly disclosed excerpt of those records before the next request; a missing settlement remains an uncertain delivery and is never treated as proof that no message was sent. An `accepted` peer-message result means the target Session durably retained the receipt when the sender was acknowledged. If the target inbox later cancels that receipt before it reaches the model-visible message surface, the target Session records a separate `bot/collaboration` cancellation status; a failed repair is retried once in-process and startup reconciliation repeats it after a process interruption. A later cancellation does not rewrite the earlier acceptance result, and retrying the same message id remains safe.

##### Native send retry contract

```markdown
If a native send reports uncertain-outcome, reuse its messageId when retrying. The same messageId prevents duplicate delivery; choose a new messageId only for an intentional repeat. Messaging follows the Session approval policy.
```

##### Native routine retry contract

```markdown
Time-based native routine creation supplies the Host Schedule service with an operation-specific durable identity derived from the Bot Session and native call. The operation is reserved before approval, so a concurrent retry remains uncertain while approval is live; denial or cancellation releases the reservation, and a reservation left by a Host restart is retired. Retrying that same operation reuses the existing task, including after Host restart; a new operation can intentionally create an identical routine after the earlier call settled. If the earlier native lifecycle has only a `started` record, the Schedule service resolves that operation in its serialized write queue: an unregistered replayed start is retired when no approval call is live, a committed task is replayed and both native lifecycles are durably settled, while a registered operation with no task is retired and permits one retry. Every new routine still requires approval. Bot event-routine creation uses a separate deterministic identity for the native call and persists the routine before delivering a matching message; a replay with that identity returns the original routine, while a new native call intentionally creates another routine. A delivery durably records its follow-up attempt before invoking the Agent; restart recovery never invokes an uncertain attempt again without an inbox or surface receipt, and an explicit resume starts a deliberate new attempt. Pause, resume, edit, and history preserve the Bot Session binding. Event routines currently support only message sources from the user or a peer Bot; arbitrary webhooks and external event sources are not silently accepted.
```

#### Token effect

Tool schemas and bounded inspection results add tokens when used. Peer delivery itself adds the framed message to the recipient's next request, not to the sender's history.

#### KV Cache effect

The collaboration tool set is stable for a Bot scope. A roster or tool-schema change can invalidate a provider's request prefix; delivered peer messages affect only the recipient's later context.

### Bot memory

#### What the model sees

The memory tools operate only on the Bot that owns the current live Session. The Host stores every remember and forget operation in that Session's append-only log, so a cold Session can reconstruct the same active memory set. A later system prompt includes bounded entries inside an explicit untrusted-reference section. The current system, developer, and user instructions remain authoritative; memory text is not a security boundary and may still require ordinary model judgment.

#### Token effect

The memory tool schemas add a small fixed prefix cost. Each active memory contributes its bounded text to the Bot's next system prompt; memory listing returns only ids and timestamps when requested, without echoing the stored text.

#### KV Cache effect

The memory section is stable until a memory mutation. Remembering or logically forgetting changes the later system-prompt suffix while preserving earlier identity and deployment sections; prior persisted prompt events remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current Bot roster. They are package constraints, not a general Session lifecycle policy.

- **No delete or archive operation** — the first roster API can create, rename, list, update appearance and avatars, but it does not remove a Bot or archive its Session.
- **Sections are user-defined labels** — the roster supports one optional section name per Bot, plus pin, hide, and restore; it does not provide nested folders or cross-user shared roster state.
- **Provisioning is retryable but not automatic** — a failed provisioning row stays visible for an explicit retry; Host startup does not wake every cold row.
- **One preset is selected at creation** — `agentPreset` applies when the linked Session is first created and is not a live per-turn selector.
- **Shared Bots use invite identities** — the self-hosted authority is intentionally local and invite-based; deployments that need account recovery, federated identity, or multi-device principal linking must layer an external identity provider above it.
- **Shared manager profile edits are disabled** — the route is withheld until authority authorization and the separate Bot-row commit can be made one crash-atomic transaction; operators can still edit the Bot profile through the local Bot service.
- **Credential-less roster recovery is version-scoped** — hosts without credentials recover pending rows through `agent_bot_intents`, but older BotService versions ignore that domain; do not mix versions while a pending intent may exist.
- **Routine delivery uses Host Schedule** — Bot routines inherit the Schedule service's recurrence, delivery, and retention behavior; disabling that service or omitting `@yharness/tool-schedule` from the selected preset removes routine tools without affecting the Bot roster.
- **Event triggers are Bot-specific** — message-triggered routines are handled by the Bot service and retain at most 200 deliveries and 200 completed model results per routine; generic Schedule does not expose arbitrary event sources such as webhooks.
- **Portable template approval and revocation are Host-local** — a copied signed code needs explicit approval on each recipient Host, and a copied code or already imported Bot remains usable after the publishing Host revokes its local row; target Hosts make their own permission and preset decisions.
- **Portable avatar admission has no ownership-safe rollback** — the attachment service exposes save/read but no safe delete for an unowned reference, so a failed import after avatar bytes are saved may retain content-addressed orphan bytes; the failed operation never publishes a Bot or exposes the attachment reference.
- **Declared capabilities are not permissions** — capability labels travel in the signed profile for presentation and application policy, but importing a template does not grant target-Host tools or credentials.
- **Group response attribution is causally bounded** — a response is projected only for the one accepted group delivery whose durable turn matches the assistant event and whose claim precedes that event; mixed private/group inputs, synthetic context, and concurrent group deliveries are left unprojected rather than guessed. Tool-call intermediate messages stay open until the final assistant response. Claims are rebuilt from raw durable inbox splices after restart, so surface replacements or later synthetic notices cannot make the Host attribute the next unrelated response to an old group message. Legacy logs without inbox splices retain their append-only compatibility fallback.
- **Shared groups require complete Bot membership** — a collaborator sees and can message a group only when the authenticated principal has an active membership on every Bot in that group; private Bot Sessions and their transcripts remain outside the group projection.
- **MCP source metadata identifies connected apps** — this feature covers ordinary app tools and shared resource operations registered by the MCP bridge. The scoped model runtime and connected-app dialog can inspect and change this policy; native provider actions, browser integrations, and other non-MCP tools are not included, and native actions do not expose a misleading `list_connected_apps` action. The public `mcp__...` name is only a model-facing identifier and is never used to recover ownership. Registered server identifiers remain exact opaque strings, including empty, long, brace-bearing, and punctuation-prefixed values; each durable allow or deny list is capped at 128 ids.
- **Revocation applies at the tool-body boundary** — a revoke blocks the next MCP operation, including a call paused in an async `tools/execute` wrapper, before its provider body starts. It cannot interrupt provider work that has already begun.
- **Bot roster permissions remain Host-wide** — `ownerId` scopes template publication, listing, and revocation, while Bot rows and groups still require the application identity layer for cross-account access control.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
