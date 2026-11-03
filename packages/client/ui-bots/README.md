---
description: "Bot roster and persistent-session workspace for the Y Harness Web client."
kind: "package-reference"
---

# @yharness/client-ui-bots

## Summary

Add a Bot workspace to the Web client with a roster, persistent conversations, organization, status, animated avatars, and optional host-local skill assignment. Host callbacks provide Sessions, connected apps, generated images, skills, and optional templates. Signed templates preview their self-asserted issuer, avatar, configuration, and local permissions before approval and import. Missing permissions disable approval; missing callbacks hide their controls. Request guards preserve newer drafts and prevent duplicate submissions.

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

Mount the Client export alongside the Bot Remote, Session UI, conversation UI, locale, layout, sidebar, and renderer packages. The owner supplies plain roster rows and callbacks; the panel selects a Bot and renders the owner's persistent Session in its conversation slot.

### When to choose it

Choose this package for a second, switchable Bot mode with a dedicated roster and expressive identity marks. Use the ordinary Session workspace when users should browse conversations without named Bot records or when the composition cannot provide the required Remote callbacks.

### Minimal configuration

The Client package has no user configuration fields. Mount its browser entry in the Client composition:

```yaml
- name: '@yharness/client-ui-bots/client'
```

The composition must provide the injected Bot Remote, Session store, locale, layout, sidebar, conversation, renderer, and slot services. The avatar-generation Remote is optional; without it the workspace still supports character editing and image upload when the corresponding Bot Remote methods are available.

### Owner callbacks

`BotRoster` accepts the roster, selected id, selection callback, and asynchronous creation callback. Optional callbacks connect apps, organize a Bot (pin, hide/restore, or assign a section), open avatar settings, retry an owner error, load persisted avatar bytes, and generate a non-durable preview that can be committed and assigned after the user chooses it. Template state and actions are optional; when mounted, the existing Bot sidebar opens the share/import surface without adding another navigation column. `BotDetail` renders the selected Bot and receives the owner's persistent conversation as a child. An optional `skillManager` callback opens the selected Bot's host-local skill policy dialog; it lists metadata only, supports all-versus-selected access and explicit save, and is absent when the owner does not supply both skill Remote methods. A Bot Host without a mounted skill registry reports an empty catalog. The editor sends the revision it loaded, keeps a changed-elsewhere error visible, and requires a reload before saving again. Hidden Bots stay in a dedicated recoverable section, and pinned Bots receive a distinct leading section.

### Visual identity

Animated characters use the selected accent color throughout their bodies. The persisted `identity` and `accent` select a character and its color; reduced-motion settings stop its animation. Generated or uploaded images remain an in-memory preview until the user chooses Use this avatar; only then does the owner commit and assign an attachment reference. Uploads accept PNG, JPEG, WebP, and GIF files up to 25 MiB and provide adjustable square cropping. Loading or failure falls back to the selected character.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client registration creates one controller for the Bot Remote, Session store, locale translator, and optional avatar-generation Remote. It injects the main panel, its selected-session conversation slot, and the sidebar entry as one effect; disposing the effect removes each registration and the change listener. Group create/send retry ids are persisted in the browser store before the Remote call, restored when the controller is recreated, and removed only after a complete result. Template imports explicitly approve the pasted signed artifact only after the current code's preview, avatar, fingerprints, target-local tool view, and ephemeral approval token still match; the controller then retains an operation id while it retries the same code and name, so the Host can return one Bot after an uncertain response. Group transcripts render persisted per-recipient delivery states, show safe model-turn failures beside the source message, and retry only user-authored messages with their original message id. Skill policy updates carry the catalog revision and surface a conflict when another actor has changed it. Presentational components receive plain props, so Host persistence and Session navigation remain outside the UI package.

| File | Role |
|---|---|
| [`src/client/apply.ts`](src/client/apply.ts) | Client injections, locale registration, panel slots, sidebar entry, and controller lifecycle. |
| [`src/client/controller.ts`](src/client/controller.ts) | Bot roster loading, selection, Session binding, avatar loading, and owner-facing callbacks. |
| [`src/client/BotWorkspace.tsx`](src/client/BotWorkspace.tsx) | `BotRoster` sidebar and `BotDetail` main-panel surfaces with loading, error, empty, and creation states. |
| [`src/client/BotTemplatesPanel.tsx`](src/client/BotTemplatesPanel.tsx) | Safe template publishing, share-code preview/import, copy, and revocation controls. |
| [`src/client/BotSkillsManager.tsx`](src/client/BotSkillsManager.tsx) | Host-local skill catalog and per-Bot allow/deny policy editor. |
| [`src/client/BotAvatarEditor.tsx`](src/client/BotAvatarEditor.tsx) | Provider availability, description, preview, commit, and assignment flow. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the Bot workspace is not enough. They move from the Client package group to the Host roster and the ordinary Session surface.

- [Client package map](../README.md) — adjacent browser plugins and shared Client conventions.
- [Bot roster](../../agents/bots/README.md) — durable Bot records and linked Sessions.
- [Avatar generation](../../agents/avatar-generation/README.md) — Host-side preview and attachment flow.
- [Session workspace](../ui-session/README.md) — ordinary Session navigation and conversation ownership.
- [Web client architecture](../../../docs/subsystems/web-client.md) — browser plugin composition and slot ownership.

<a id="model-experience"></a>
## Model Experience

### Bot workspace interaction

#### What the model sees

The `BotRoster` and `BotDetail` surfaces add no prompt, tool schema, or Session event. Selecting a row invokes the owner callback for the linked Session; avatar previews and roster state remain Client presentation data until a Host-owned Bot service persists them.

#### Token effect

No direct effect. The selected Session and its composed plugins determine the model request and retained history.

#### KV Cache effect

The workspace does not modify model request prefixes. Cache reuse follows the Session that the owner opens for the selected Bot.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current Bot workspace. They are package constraints, not a substitute for Host persistence or Session navigation.

- **Owner-supplied data and callbacks** — the component does not fetch Bots, create Sessions, or persist selection without the supplied owner functions.
- **Generated avatars require a mounted capability** — when the avatar-generation Remote or generated-avatar update route is absent, the editor keeps its Character mode and omits Generate; generation also stays unavailable when the Host reports missing provider configuration.
- **Selected conversation is composed by the owner** — the panel provides a slot and scope but does not implement transcript loading or Session lifecycle policy.
- **Skills are Host-local** — the manager edits only the selected Bot's policy on the current Host; it does not publish skills, copy policies through templates, or revoke a body already included in a completed model request.
- **Template operation ids are controller-local** — a full browser reload before a failed import is reconciled loses the in-memory retry key; callers that need recovery across reloads can submit their own stable `importId` through the Host Remote.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
