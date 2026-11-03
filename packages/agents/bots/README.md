---
description: "Durable user-owned Bot roster with one persistent Session per Bot, including stable visual identity and optional generated avatars."
kind: "package-reference"
---

# @yharness/bots

## Summary

Provide a named-Bot workspace with one durable Session per Bot, stable visual identity, and optional generated avatars. Bots reopen after Host restarts, retain roster organization, and recall untrusted memory stored in their Sessions. Retried creation reuses the requested Bot identity and Session. Per-Bot grants control access to connected apps.

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

Mount this Host plugin when a composition needs user-owned Bots that map one-to-one to ordinary Sessions. The roster is exposed through the Bot Remote and does not replace ordinary Session navigation. Each Bot scope receives tools to list, inspect, message, create, edit, remember, list memory, and forget memory; a native provider may expose the same actions through its own tool bridge. When Connection and credentials are present, the plugin also mounts the isolated self-hosted shared-Bot route.

The Bot Remote also exposes `listConnectedApps` and `setConnectedAppAccess`. The Client uses these methods for the selected Bot's Connected apps dialog. The catalog is derived from MCP tool definitions' Host-only source metadata and visible MCP resource servers; public names are not parsed because server and tool names may contain `__`. A grant is checked in the Bot Agent scope before approval, rechecked after approval, and checked again at the last-mile tool-body boundary after async wrappers settle, so hiding a control or revoking during a wait cannot bypass the policy.

### When to choose it

Choose this package when a Web surface needs named agents with durable visual identity, retryable provisioning, and one retained Session per row. Use the ordinary Session list instead when users should browse arbitrary conversations rather than a curated Bot roster.

### Configuration

Mount it with the storage domain, Session controller, Agent registry, system prompt service, tool runtime, attachment provider, and (for shared access) Connection and credentials supplied by the composition:

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

### Durable lifecycle

Creation writes a `provisioning` row before it asks the Session controller to activate the explicit Session id. A failed activation leaves the row and both ids available for retry. Repeating a request with the same id and metadata adopts that row; a metadata mismatch is rejected rather than silently changing the Bot.

### Visual identity and avatars

The Host accepts only the exported `BOT_IDENTITIES` and `BOT_ACCENTS` values, so the Client can map them to its own animated character components and design tokens. `updateAppearance` changes either family in place and keeps the one Session mapping. The first open after the animated character rollout removes selected image references from existing Bot rows while leaving their attachment data untouched; the durable marker makes this migration run once. A generated avatar is a verified `ImageAttachmentRef`; `updateAvatar` persists its canonical reference for future explicit selection, `uploadAvatar` validates and stores a user-selected PNG without an image-generation provider, `readAvatar` returns verified bytes for a preview, and `avatar: null` restores the semantic identity avatar.

### Durable memory

`remember_bot_memory` appends a `bot/memory` Session event and waits for the normal Session flush barrier before returning a memory receipt. `list_bot_memory` returns only active ids and timestamps, while `forget_bot_memory` appends a logical deletion event. Forgetting removes the entry from future memory prompts; the append-only Session log and prompts already sent to a model are not erased. Durable forget tombstones make a repeated forget idempotent after a Session restart. Memory text is bounded and presented as untrusted user-provided reference data, not as an instruction-isolation guarantee. Memory writes and deletions are approval-gated in both ordinary and native tool bridges. Ordinary scoped calls without `memoryId` derive a stable sender-and-text identity, so repeating identical normalized text reuses one active memory; supply distinct explicit ids when identical text should be retained as separate memories. Native retries recover an unsettled call's id from the Bot event log, while an explicit `memoryId` is the way to deduplicate intentionally across independent native turns.

### Shared Bot policy foundation

`SharedBotService` persists memberships, one-time invite associations, one private Session binding per `(Bot, principal)` pair, and durable private-session revocation tombstones in the `agent_bot_shares` domain. A credential-backed membership snapshot is refreshed before each operation and by a bounded watcher, so a second Host process observes membership revocation without relying on its in-memory table. The dedicated `/shared-bots` route accepts only `SHARED_BOT_ENDPOINTS`; it never mounts ordinary operator Remote APIs. Enrollment binds the cookie to the request authority, and every request derives its principal from the authenticated shared Peer. `owner`, `manager`, and `collaborator` roles authorize membership operations and shared-context reads or writes; manager profile edits are currently disabled because the separate authority and Bot-row stores do not yet provide one crash-atomic authorization transaction. Private conversation reads remain participant-owned and are never merged into shared context. Revocation removes membership, marks its private Session binding inaccessible until active Agents quiesce, and closes the authority's access.

Operator profile mutations update a credential-backed revision fence through a pending-row transaction. A crash between the Bot-row write and revision commit is repaired from the pending record, and a Host with a stale Bot domain receives a conflict instead of overwriting a newer rename, description, appearance, or avatar update. Owner-side collaborator invites are authorized against the current authority record in the same mutation that records the invite. Shared-context storage is bounded to 256 Bot policies, 4,096 entries per authority record, and 512 entries per Bot. The write `consent` field is a caller acknowledgement; membership authorization and the Bot's enabled policy remain the security checks.

Peer delivery uses a credential-backed, cross-process message ledger and the recipient Session log as its crash-recovery receipt. The ledger retains 4,096 accepted message identities and rejects new unique deliveries when full rather than evicting an identity and risking a duplicate.

The enrollment endpoint is `/shared-bots/bots/share/enroll`; an operator issues its one-time code through `ctx.remote.bots.createShareInvite`, reads the Bot-scoped roster with `listShareMembers`, reads or changes the shared-context policy with `getShareMemoryPolicy` and `setShareMemoryPolicy`, and removes non-owner members with `revokeShareMember`. Shared HTTP requests use `bots/share/list`, `bots/share/read-profile`, `bots/share/read-private-chat`, `bots/share/chat`, `bots/share/manage-members`, `bots/share/read-memory`, `bots/share/write-memory`, and `bots/share/manage-memory`; `bots/share/manage-profile` is deliberately not mounted until an atomic authority-plus-profile transaction exists. Network deployments must use TLS, configure matching `trustedHosts` on Connection and Bots, and set `shared.secureCookie: true`. Each shared request and the bounded membership watcher refresh the durable membership record; a process that observes a remote Bot revocation aborts that principal's active private turn and rejects subsequent requests, while the authority sweep closes revoked cookies within its bounded interval.

Private chat durability checkpoints are bounded for the caller. If a Host flush ignores cancellation or exceeds the checkpoint deadline, the shared request chain can continue and the underlying flush remains tracked; service disposal waits for tracked flushes and quiescence only up to the shared cancellation deadline before closing the shared-Bot domain, and unresolved operations remain inaccessible to the service. A binding whose backing Session no longer exists is removed during the next private chat or transcript read; chat creates a replacement Session and transcript reads return an empty conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns the durable `agent_bots` roster domain and, when no credential provider is mounted, a separate version-one `agent_bot_intents` write-ahead domain. It serializes writes that can allocate or update a Bot and validates stored keys and Session mappings before the service becomes ready. A pending no-credentials intent is retried before a later mutation and replayed by the next roster read after restart; older BotService versions do not consume this domain, so mixed-version operation is unsupported while a pending intent may exist. The service keeps provisioning rows durable across activation failures, while list and read operations project the stored row without waking a cold Session. `bots.list` omits hidden rows unless `includeHidden` is true and orders pinned rows before the stable creation-time order; `updateOrganization` changes pin, hidden, and section placement atomically.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Bot Remote methods, lifecycle serialization, Session provisioning, scoped prompt/tools, and attachment admission. |
| [`src/collaboration.ts`](src/collaboration.ts) | Provider-neutral roster inspection, bounded transcript projection, and durable peer delivery. |
| [`src/scoped-tools.ts`](src/scoped-tools.ts) | Ordinary Agent-scoped collaboration and connected-app tool schemas plus approval policy. |
| [`src/native-tools.ts`](src/native-tools.ts) | Native-provider action adapter and bounded durable action observations. |
| [`src/memory.ts`](src/memory.ts) | Bot memory event vocabulary, validation, projection, and provider-facing operations. |
| [`src/sharing.ts`](src/sharing.ts) | Explicit shared-Bot roles, fail-closed authorization, and private-conversation routing primitives. |
| [`src/shared-service.ts`](src/shared-service.ts) | Shared-Bot enrollment, role-authorized endpoints, durable private Sessions, and revocation. |
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

Selecting a Bot through `ctx.remote.bots` opens its linked ordinary Session; model-visible history remains owned by that Session and its composed plugins. While a Bot Agent is live, its scope exposes `list_bots` and `inspect_bot` for roster metadata and bounded visible transcript inspection. `send_bot_message`, `create_bot`, `edit_bot_profile`, `remember_bot_memory`, and `forget_bot_memory` are approval-gated actions. `list_bot_memory` is read-only. Picture generation uses the configured OpenAI avatar service and reports failure when it is unavailable.

#### Token effect

The collaboration tool descriptions and any returned roster/transcript data consume tokens only when the model uses them. A selected Session pays the tokens for its own history and current request.

#### KV Cache effect

The roster does not modify request prefixes until the scoped collaboration tools are assembled. Cache reuse follows the selected Session's existing model route and history; a changed Bot roster or tool schema may change the provider prefix.

### Bot identity

#### What the model sees

When a Bot Session is created or resumed, the Host adds a scoped system-prompt section with the Bot's current name and optional role description. The section is assembled for every model route, including the native Codex backend, and a rename is reflected on the next request without creating a second Session or rewriting earlier history. The scoped MCP tool runtime exposes `list_connected_apps` so a Bot can explain why an app is unavailable; the native Codex action bridge does not expose that catalog because its actions cannot dispatch MCP app tools.

#### Token effect

Each Bot request pays for the short identity section and optional role description.

#### KV Cache effect

The identity text stays prefix-stable until the Bot name or role description changes. A rename changes the system prompt for later requests while preserving the reusable prefix before the changed section.

### Connected-app access

#### What the model sees

The scoped model runtime can call `list_connected_apps` to see the MCP app catalog and each Bot's grant. An ordinary MCP tool or shared MCP resource operation whose named server is not granted fails before its body runs with a message that names the app and directs the user to Bot settings. The denial retains `BOT_APP_ACCESS_REQUIRED` structured metadata for Host routing while the model sees only the concise reason. The user can grant or revoke access from the connected-app dialog; the decision is durable and applies to later scoped MCP tool calls. Native Codex actions do not claim access to this catalog: their provider-independent action surface cannot dispatch an MCP app tool.

#### Token effect

The list tool and an access-denial message consume tokens only when the Bot calls an app or asks for the catalog. Access checks do not add a model-visible turn when a granted tool runs.

#### KV Cache effect

Changing a Bot grant does not rewrite Session history. The scoped tool set remains stable; only the result of a later app call changes.

### Bot collaboration

#### What the model sees

The service derives the sending identity from the live Bot Agent and rechecks the durable roster for every operation. Inspection excludes reasoning and tool blocks. A delivered message is framed with the sender's current name and persisted in the recipient's existing Session as an `agent-message`, so it becomes ordinary user context on the recipient's next turn. Native Codex actions also persist a required `bot/dynamic-tool` lifecycle record with the exact model-visible result. When a native cursor is lost, the Codex bridge replays a bounded, explicitly disclosed excerpt of those records before the next request; a missing settlement remains an uncertain delivery and is never treated as proof that no message was sent.

##### Native send retry contract

```markdown
If a native send reports uncertain-outcome, reuse its messageId when retrying. The same messageId prevents duplicate delivery; choose a new messageId only for an intentional repeat. Messaging follows the Session approval policy.
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
- **Group chat is not part of the private-session endpoint set** — each participant receives an isolated Bot conversation. Shared context is a separate, explicitly consented note stream; a future group-chat capability must define explicit membership, transcript visibility, and message attribution before it can share a Session.
- **MCP source metadata identifies connected apps** — this feature covers ordinary app tools and shared resource operations registered by the MCP bridge. The scoped model runtime and connected-app dialog can inspect and change this policy; native provider actions, browser integrations, and other non-MCP tools are not included, and native actions do not expose a misleading `list_connected_apps` action. The public `mcp__...` name is only a model-facing identifier and is never used to recover ownership. Registered server identifiers remain exact opaque strings, including empty, long, brace-bearing, and punctuation-prefixed values; each durable allow or deny list is capped at 128 ids.
- **Revocation applies at the tool-body boundary** — a revoke blocks the next MCP operation, including a call paused in an async `tools/execute` wrapper, before its provider body starts. It cannot interrupt provider work that has already begun.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
