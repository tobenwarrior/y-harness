---
description: "Durable user-owned Bot roster with one persistent Session per Bot, including stable visual identity and optional generated avatars."
kind: "package-reference"
---

# @yharness/bots

## Summary

Create a durable Bot roster whose rows keep one stable identity and one persistent Session. Use it for a second-mode Web workspace that can reopen a Bot after a Host restart and show whether its Session is currently resumed. Retried creation reuses the requested Bot id and Session instead of allocating a duplicate. Generated images can be assigned through verified attachment references; clearing one restores the semantic identity mark.

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

Mount this Host plugin when a composition needs user-owned Bots that map one-to-one to ordinary Sessions. The roster is exposed through the Bot Remote and does not replace ordinary Session navigation. Each Bot scope also receives provider-neutral `list_bots`, `inspect_bot`, and approval-gated `send_bot_message` tools; a native provider may expose the same actions through its own tool bridge.

### When to choose it

Choose this package when a Web surface needs named agents with durable visual identity, retryable provisioning, and one retained Session per row. Use the ordinary Session list instead when users should browse arbitrary conversations rather than a curated Bot roster.

### Minimal configuration

The plugin has no user configuration fields. Mount it with the storage domain, Session controller, Agent registry, system prompt service, tool runtime, and attachment provider supplied by the composition:

```yaml
- name: '@yharness/bots'
```

| Field | Default | Meaning |
|---|---|---|
| none | — | The Bot service takes no configuration; its composition supplies storage, Session, Agent, system prompt, tools, and attachment dependencies. |

### Durable lifecycle

Creation writes a `provisioning` row before it asks the Session controller to activate the explicit Session id. A failed activation leaves the row and both ids available for retry. Repeating a request with the same id and metadata adopts that row; a metadata mismatch is rejected rather than silently changing the Bot.

### Visual identity and avatars

The Host accepts only the exported `BOT_IDENTITIES` and `BOT_ACCENTS` values, so the Client can map them to its own icon components and design tokens. `updateAppearance` changes either family in place and keeps the one Session mapping; generated avatars stay selected unless the request explicitly sets `clearAvatar: true`. A generated avatar is a verified `ImageAttachmentRef`; `updateAvatar` persists its canonical reference, `readAvatar` returns verified bytes for a preview, and `avatar: null` restores the semantic identity avatar.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns one storage-domain table and serializes writes that can allocate or update a Bot. Domain opening validates stored keys and Session mappings before the service becomes ready. The service keeps provisioning rows durable across activation failures, while list and read operations project the stored row without waking a cold Session.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Bot Remote methods, lifecycle serialization, Session provisioning, scoped prompt/tools, and attachment admission. |
| [`src/collaboration.ts`](src/collaboration.ts) | Provider-neutral roster inspection, bounded transcript projection, and durable peer delivery. |
| [`src/scoped-tools.ts`](src/scoped-tools.ts) | Ordinary Agent-scoped collaboration tool schemas and approval policy. |
| [`src/native-tools.ts`](src/native-tools.ts) | Native-provider action adapter and bounded durable action observations. |
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

Selecting a Bot through `ctx.remote.bots` opens its linked ordinary Session; model-visible history remains owned by that Session and its composed plugins. While a Bot Agent is live, its scope exposes `list_bots` and `inspect_bot` for roster metadata and bounded visible transcript inspection. `send_bot_message` is available only as an explicit, approval-gated side effect; merely mentioning or inspecting another Bot never sends anything.

#### Token effect

The collaboration tool descriptions and any returned roster/transcript data consume tokens only when the model uses them. A selected Session pays the tokens for its own history and current request.

#### KV Cache effect

The roster does not modify request prefixes until the scoped collaboration tools are assembled. Cache reuse follows the selected Session's existing model route and history; a changed Bot roster or tool schema may change the provider prefix.

### Bot identity

#### What the model sees

When a Bot Session is created or resumed, the Host adds a scoped system-prompt section with the Bot's current name and optional role description. The section is assembled for every model route, including the native Codex backend, and a rename is reflected on the next request without creating a second Session or rewriting earlier history.

#### Token effect

Each Bot request pays for the short identity section and optional role description.

#### KV Cache effect

The identity text stays prefix-stable until the Bot name or role description changes. A rename changes the system prompt for later requests while preserving the reusable prefix before the changed section.

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

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current Bot roster. They are package constraints, not a general Session lifecycle policy.

- **No delete or archive operation** — the first roster API can create, rename, list, update appearance and avatars, but it does not remove a Bot or archive its Session.
- **Provisioning is retryable but not automatic** — a failed provisioning row stays visible for an explicit retry; Host startup does not wake every cold row.
- **One preset is selected at creation** — `agentPreset` applies when the linked Session is first created and is not a live per-turn selector.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
