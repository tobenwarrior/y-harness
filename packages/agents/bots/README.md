---
description: "Durable user-owned Bot roster with one persistent Session per Bot, including stable visual identity and optional generated avatars."
kind: "package-reference"
---

# @yharness/bots

## Summary

Provide a named-Bot workspace with one durable Session per Bot, stable visual identity, and optional generated avatars. Bots reopen after Host restarts, retain roster organization and untrusted memory, collaborate in durable groups, and use per-Bot grants to control access to connected apps and host-local skills. Retried creation reuses the requested Bot identity and Session. Signed portable templates share profile, persona, declared capabilities, avatar bytes, and preset without Sessions, paths, transcripts, or credentials; target Hosts admit the avatar before activating a local Bot, then create local Sessions and attachments.

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

Mount this Host plugin when a composition needs user-owned Bots that map one-to-one to ordinary Sessions. The roster is exposed through the Bot Remote and does not replace ordinary Session navigation. Each Bot scope receives tools to list, inspect, message, create, edit, remember, list memory, and forget memory, plus membership-scoped group inspection, creation, and delivery; a native provider exposes the same actions for a live Bot Session.

The Bot Remote also exposes `listConnectedApps` and `setConnectedAppAccess`. The Client uses these methods for the selected Bot's Connected apps dialog. The catalog is derived from MCP tool definitions' Host-only source metadata and visible MCP resource servers; public names are not parsed because server and tool names may contain `__`. A grant is checked in the Bot Agent scope before approval, rechecked after approval, and checked again at the last-mile tool-body boundary after async wrappers settle, so hiding a control or revoking during a wait cannot bypass the policy.

The Bot Remote exposes `listSkills` and `updateSkills`; when the Host mounts `@yharness/skill`, `listSkills` returns its metadata-only catalog, and otherwise it returns an empty catalog. The Client uses these methods for the selected Bot's host-local Skills dialog. Skill bodies, filesystem paths, provider locators, credentials, and local ids stay on the Host. A Bot's scoped skill provider shadows denied names before body loading and rechecks the policy after an asynchronous body load, so revocation cannot return a delayed body to either model or user invocation. Changing the policy invalidates the live catalog. Legacy rows default to `mode: "all"`, while selected mode is a canonical, deduplicated allow list with an explicit deny list. Policy replacements use a persisted compare-and-swap revision against the backend's current row; fresh reads and fenced updates are required across Hosts, and a backend without those primitives fails closed with `bot/profile-coordination-unavailable` instead of accepting a profile write. Skill catalog and invocation inputs continue using the existing `skill-catalog` and `skill-invocation` Session sources, so the policy itself adds no unlogged model-visible input.

### When to choose it

Choose this package when a Web surface needs named agents with durable visual identity, retryable provisioning, and one retained Session per row. Use the ordinary Session list instead when users should browse arbitrary conversations rather than a curated Bot roster.

### Minimal configuration

The plugin accepts an optional deployment-local template owner key. Mount it with the storage domain, Session controller, Agent registry, system prompt service, tool runtime, and attachment provider supplied by the composition:

```yaml
- name: '@yharness/bots'
```

| Field | Default | Meaning |
|---|---|---|
| `ownerId` | `local-owner` | Scope for publishing, listing, and revoking locally owned template rows; it is never embedded in a portable code. |

Bot skill assignments are Host-local and are not included in portable templates. A copied template receives the target Host's default skill policy and must be configured separately by its owner.

The Bot Remote also exposes `listTemplates`, `publishTemplate`, `revokeTemplate`, `previewTemplate`, `approveTemplate`, and `importTemplate`. Publication signs the Bot name, description, character, accent, persona, declared capabilities, portable avatar bytes, and optional Agent preset without including local runtime identities, and is allowed only for a Bot owned by the configured `ownerId`. A target Host verifies the signature and requires explicit approval of the exact preview fingerprint plus the resolved local preset and sorted tool view before a copied code can create a Bot; the preview exposes the self-asserted signing-key fingerprint, profile, persona, declared capabilities, portable avatar, and target-local effective preset/tool view so the user can make that trust decision. A resolved preview also returns an ephemeral Host-local approval token; `approveTemplate` must receive that token and the exact permission view from the same preview, so a preset or tool-permission change is rejected before any durable approval is written. Approval fails closed when that local view is unavailable, and the Host re-resolves and compares the stored view for every import, including idempotent retries and direct callers, so preset or tool-permission changes require approval again. The target then resolves its own Session, working directory, preset, and attachment reference. Supplying `importId` makes import idempotent for a caller operation: the durable binding is reserved before avatar admission and provisioning, so retries return the original Bot after a transient failure, rename, or source revocation, while different code or name metadata is rejected. Revocation is owner-scoped and Host-local: it blocks new preview/import requests that reach that Host, but it cannot revoke a copied artifact or an already imported Bot on another Host.

### Durable lifecycle

Creation writes a `provisioning` row before it asks the Session controller to activate the explicit Session id. A failed activation leaves the row and both ids available for retry. Repeating a request with the same id and metadata adopts that row; a metadata mismatch is rejected rather than silently changing the Bot.

### Visual identity and avatars

The Host accepts only the exported `BOT_IDENTITIES` and `BOT_ACCENTS` values, so the Client can map them to its own animated character components and design tokens. `updateAppearance` changes either family in place and keeps the one Session mapping. The first open after the animated character rollout removes selected image references from existing Bot rows while leaving their attachment data untouched; the durable marker makes this migration run once. A generated avatar is a verified `ImageAttachmentRef`; `updateAvatar` persists its canonical reference for future explicit selection, `uploadAvatar` validates and stores a user-selected PNG without an image-generation provider, `readAvatar` returns verified bytes for a preview, and `avatar: null` restores the semantic identity avatar.

### Durable memory

`remember_bot_memory` appends a `bot/memory` Session event and waits for the normal Session flush barrier before returning a memory receipt. `list_bot_memory` returns only active ids and timestamps, while `forget_bot_memory` appends a logical deletion event. Forgetting removes the entry from future memory prompts; the append-only Session log and prompts already sent to a model are not erased. Durable forget tombstones make a repeated forget idempotent after a Session restart. Memory text is bounded and presented as untrusted user-provided reference data, not as an instruction-isolation guarantee. Memory writes and deletions are approval-gated in both ordinary and native tool bridges. Ordinary scoped calls without `memoryId` derive a stable sender-and-text identity, so repeating identical normalized text reuses one active memory; supply distinct explicit ids when identical text should be retained as separate memories. Edits save a private recovery intent before appending the forget and replacement events, so an interrupted flush or restart can finish the replacement without exposing the intent in Bot roster views. Native retries recover an unsettled call's id from the Bot event log, while an explicit `memoryId` is the way to deduplicate intentionally across independent native turns.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns the Bot roster and a separate additive group domain. It serializes writes that can allocate or update a Bot or group. Domain opening validates stored keys and Session mappings before the service becomes ready. The service keeps provisioning rows durable across activation failures, while list and read operations project the stored row without waking a cold Session. `bots.list` omits hidden rows unless `includeHidden` is true and orders pinned rows before the stable creation-time order; `updateOrganization` changes pin, hidden, and section placement atomically. Group messages have durable per-recipient delivery records, so retries resume failed recipients instead of sending a second copy to already accepted Sessions. Scoped group tools derive retry identities from the authenticated Bot and request contents rather than an ephemeral tool call id, while the Client persists pending operation ids and reconciles only the exact pending id before a retry.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Bot Remote methods, lifecycle serialization, Session provisioning, scoped prompt/tools, and attachment admission. |
| [`src/collaboration.ts`](src/collaboration.ts) | Provider-neutral roster inspection, bounded transcript projection, and durable peer delivery. |
| [`src/group-chat.ts`](src/group-chat.ts) | Durable 2–6-member groups, transcript projection, per-recipient delivery state, and response projection. |
| [`src/scoped-tools.ts`](src/scoped-tools.ts) | Ordinary Agent-scoped collaboration, group, and connected-app tool schemas plus approval policy. |
| [`src/template-types.ts`](src/template-types.ts) | Browser-safe template requests, safe configuration views, share-code brands, and Remote errors. |
| [`src/template-codec.ts`](src/template-codec.ts) | Signed portable code encoding, Ed25519 verification, bounded payload validation, and content fingerprints. |
| [`src/template-storage.ts`](src/template-storage.ts) | Owner-scoped durable template rows and Host-local signing-key storage. |
| [`src/native-tools.ts`](src/native-tools.ts) | Native-provider action adapter and bounded durable action observations. |
| [`src/memory.ts`](src/memory.ts) | Bot memory event vocabulary, validation, projection, and provider-facing operations. |
| [`src/skills.ts`](src/skills.ts) | Canonical per-Bot skill policy and scoped provider that prevents denied body loads. |
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

Selecting a Bot through `ctx.remote.bots` opens its linked ordinary Session; model-visible history remains owned by that Session and its composed plugins. While a Bot Agent is live, its scope and the native Codex provider expose `list_bots` and `inspect_bot` for roster metadata and bounded visible transcript inspection, together with `list_bot_groups`, `inspect_bot_group`, `create_bot_group`, `update_bot_group`, and `send_bot_group_message` for groups that include the calling Bot. `send_bot_message`, `create_bot`, `edit_bot_profile`, `remember_bot_memory`, `forget_bot_memory`, `create_bot_group`, `update_bot_group`, and `send_bot_group_message` are approval-gated actions. `list_bot_memory` is read-only. Picture generation uses the configured OpenAI avatar service and reports failure when it is unavailable.

#### Token effect

The collaboration tool descriptions and any returned roster/transcript data consume tokens only when the model uses them. A selected Session pays the tokens for its own history and current request.

#### KV Cache effect

The roster does not modify request prefixes until the scoped collaboration tools are assembled. Cache reuse follows the selected Session's existing model route and history; a changed Bot roster or tool schema may change the provider prefix.

### Bot identity

#### What the model sees

When a Bot Session is created or resumed, the Host adds a scoped system-prompt section with the Bot's current name, optional role description, persona, and declared capabilities. The section is assembled for every model route, including the native Codex backend, and a rename is reflected on the next request without creating a second Session or rewriting earlier history. The scoped MCP tool runtime exposes `list_connected_apps` so a Bot can explain why an app is unavailable; the native Codex action bridge does not expose that catalog because its actions cannot dispatch MCP app tools.

#### Token effect

Each Bot request pays for the short identity section and optional role description, persona, and capability declaration.

#### KV Cache effect

The identity text stays prefix-stable until the Bot name or role description changes. A rename changes the system prompt for later requests while preserving the reusable prefix before the changed section.

### Connected-app access

#### What the model sees

The scoped model runtime can call `list_connected_apps` to see the MCP app catalog and each Bot's grant. An ordinary MCP tool or shared MCP resource operation whose named server is not granted fails before its body runs with a message that names the app and directs the user to Bot settings. The denial retains `BOT_APP_ACCESS_REQUIRED` structured metadata for Host routing while the model sees only the concise reason. The user can grant or revoke access from the connected-app dialog; the decision is durable and applies to later scoped MCP tool calls. Native Codex actions do not claim access to this catalog: their provider-independent action surface cannot dispatch an MCP app tool.

#### Token effect

The list tool and an access-denial message consume tokens only when the Bot calls an app or asks for the catalog. Access checks do not add a model-visible turn when a granted tool runs.

#### KV Cache effect

Changing a Bot grant does not rewrite Session history. The scoped tool set remains stable; only the result of a later app call changes.

### Host-local skill assignment

#### What the model sees

The Host discovers skill metadata through the existing skill registry, then installs a scoped provider for each Bot. In `all` mode the Bot can discover and load every current local skill except names in `disabled`; in `selected` mode it can discover and load only names in `enabled` that are not disabled. Denied candidates remain non-invocable and their bodies are never loaded, including when a user or model requests a denied name directly. The durable policy is read again for every discovery and load, and policy-backed discovery is non-cacheable so a revocation made by another Host is observed before the next model-visible catalog. Skill catalog and explicit invocation messages retain the existing durable source records, so a policy edit does not create an unlogged model-visible message.

#### Token effect

Skill metadata and bodies consume tokens only when the Bot's existing skill discovery or invocation path uses them. A denied skill contributes no body to a model request; the policy itself adds no prompt section.

#### KV Cache effect

Changing a Bot skill policy may change its scoped skill catalog and therefore the later request prefix, while preserving the Session log and unrelated Bot identity sections.

### Bot collaboration

#### What the model sees

The service derives the sending identity from the live Bot Agent and rechecks the durable roster for every operation. Inspection excludes reasoning and tool blocks, and generic peer inspection removes group-origin turns and their assistant replies; use membership-scoped group inspection for that transcript. Group inspection frames every message as untrusted quoted data. A delivered message is framed with the sender's current name and persisted in the recipient's existing Session as an `agent-message`, so it becomes ordinary user context on the recipient's next turn. Native Codex actions also persist a required `bot/dynamic-tool` lifecycle record with the exact model-visible result. When a native cursor is lost, the Codex bridge replays a bounded, explicitly disclosed excerpt of those records before the next request; a missing settlement remains an uncertain delivery and is never treated as proof that no message was sent.

##### Native send retry contract

```markdown
If a native Bot or group send reports uncertain-outcome, reuse its messageId when retrying. The same messageId prevents duplicate delivery; choose a new messageId only for an intentional repeat. A group result with `status: "partial"` is returned as an explicit `partial-delivery` failure and includes each recipient's outcome; a retry without the returned messageId is rejected as uncertain, while a retry with that id resumes only failed recipients. Scoped tools derive a stable group id or message id from the authenticated Bot and request contents when the model omits one, so a fresh tool call cannot fan out a second copy. Remote callers should provide a stable `id` or `messageId`; the Client persists and reuses those ids after a lost or partial response, and fails closed when it cannot reconcile an untracked operation. Group creation reports an uncertain outcome instead of guessing after a lost settlement. Messaging follows the Session approval policy.
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

### Bot groups

#### What the model sees

The Host exposes `listGroups`, `createGroup`, `updateGroup`, `inspectGroup`, and `sendGroupMessage` through the Bot Remote. Live Bot Agents also receive membership-scoped group tools, including `update_bot_group`, and the native Codex provider exposes the same operations. A group has two through six existing active Bots, a durable transcript, and one delivery record per recipient for each message. A Bot-created group request names one to five other Bots from `list_bots`; the live calling Bot is added from its authenticated Session identity, so model arguments cannot omit or spoof membership. Human and Bot-authored group messages are delivered as normal user-role messages to selected members' existing Sessions, framed with the originating Bot name when applicable; a missing target list broadcasts to every other member, while the Client's @mention picker sends only to the selected members. Groups preserve their durable identity while the user or an authorized member Bot renames the group or replaces its roster. They never route all members through one coordinator model. The Host records an assistant response only when the exact group delivery is claimed by that Bot in the same durable turn, with the final response allowed in a later step of that turn, and only when that delivery is the sole user input in the step. Group inspection also returns each recipient's persisted `pending`, `accepted`, `responded`, or `failed` state; `accepted` means the message reached the Bot Session, while `failed` is written from the matching durable turn outcome and includes a safe recovery description.

#### Token effect

Group membership and transcript rows add tokens only when a Client or model-facing surface reads them. A group send adds the framed user message to each recipient's next request independently.

#### KV Cache effect

Group metadata does not change a Bot's prompt prefix. A delivered group message invalidates only the receiving Bot Session's later request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current Bot roster. They are package constraints, not a general Session lifecycle policy.

- **No delete or archive operation** — the first roster API can create, rename, list, update appearance and avatars, but it does not remove a Bot or archive its Session.
- **Sections are user-defined labels** — the roster supports one optional section name per Bot, plus pin, hide, and restore; it does not provide nested folders or cross-user shared roster state.
- **Provisioning is retryable but not automatic** — a failed provisioning row stays visible for an explicit retry; Host startup does not wake every cold row.
- **One preset is selected at creation** — `agentPreset` applies when the linked Session is first created and is not a live per-turn selector.
- **Portable template approval and revocation are Host-local** — a copied signed code needs explicit approval on each recipient Host, and a copied code or already imported Bot remains usable after the publishing Host revokes its local row; target Hosts make their own permission and preset decisions.
- **Portable avatar admission has no ownership-safe rollback** — the attachment service exposes save/read but no safe delete for an unowned reference, so a failed import after avatar bytes are saved may retain content-addressed orphan bytes; the failed operation never publishes a Bot or exposes the attachment reference.
- **Declared capabilities are not permissions** — capability labels travel in the signed profile for presentation and application policy, but importing a template does not grant target-Host tools or credentials.
- **Skill assignments are Host-local** — the policy controls the Bot's current skill registry view and is persisted with the Bot, but it is not portable, does not revoke bodies already loaded into a prior model request, and does not change another Host's copy or the source of a template.
- **Group response attribution is causally bounded** — a response is projected only for the one accepted group delivery whose durable turn matches the assistant event and whose claim precedes that event; mixed private/group inputs, synthetic context, and concurrent group deliveries are left unprojected rather than guessed. Tool-call intermediate messages stay open until the final assistant response. Claims are rebuilt from raw durable inbox splices after restart, so surface replacements or later synthetic notices cannot make the Host attribute the next unrelated response to an old group message. Legacy logs without inbox splices retain their append-only compatibility fallback.
- **Shared multi-user permissions are not included** — groups are durable in the local Host roster; cross-account sharing and access control still require the application identity layer.
- **MCP source metadata identifies connected apps** — this feature covers ordinary app tools and shared resource operations registered by the MCP bridge. The scoped model runtime and connected-app dialog can inspect and change this policy; native provider actions, browser integrations, and other non-MCP tools are not included, and native actions do not expose a misleading `list_connected_apps` action. The public `mcp__...` name is only a model-facing identifier and is never used to recover ownership. Registered server identifiers remain exact opaque strings, including empty, long, brace-bearing, and punctuation-prefixed values; each durable allow or deny list is capped at 128 ids.
- **Revocation applies at the tool-body boundary** — a revoke blocks the next MCP operation, including a call paused in an async `tools/execute` wrapper, before its provider body starts. It cannot interrupt provider work that has already begun.
- **Bot roster permissions remain Host-wide** — `ownerId` scopes template publication, listing, and revocation, while Bot rows and groups still require the application identity layer for cross-account access control.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
