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

Mount this Host plugin when a composition needs user-owned Bots that map one-to-one to ordinary Sessions. The roster is exposed through the Bot Remote and does not replace ordinary Session navigation.

### When to choose it

Choose this package when a Web surface needs named agents with durable visual identity, retryable provisioning, and one retained Session per row. Use the ordinary Session list instead when users should browse arbitrary conversations rather than a curated Bot roster.

### Minimal configuration

The plugin has no user configuration fields. Mount it with the storage domain, Session controller, Agent registry, and attachment provider supplied by the composition:

```yaml
- name: '@yharness/bots'
```

| Field | Default | Meaning |
|---|---|---|
| none | — | The Bot service takes no configuration; its composition supplies storage and Session dependencies. |

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
| [`src/index.ts`](src/index.ts) | Bot Remote methods, lifecycle serialization, Session provisioning, and attachment admission. |
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

The roster adds no prompt, tool schema, or Session event. Selecting a Bot through `ctx.remote.bots` opens its linked ordinary Session; any model-visible history remains owned by that Session and its composed plugins.

#### Token effect

No direct effect. A selected Session pays the tokens for its own history and current request.

#### KV Cache effect

The roster does not modify request prefixes. Cache reuse follows the selected Session's existing model route and history.

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
