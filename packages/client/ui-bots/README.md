---
description: "Bot roster and persistent-session workspace for the Y Harness Web client."
kind: "package-reference"
---

# @yharness/client-ui-bots

## Summary

Use a Bot workspace with a roster, persistent Sessions, animated avatars, profile editing, routines, and optional host-local skill assignment. Profile edits preserve the existing Session, working directory, and preset; capability labels do not grant permissions. Host callbacks provide connected apps, images, skills, and optional templates. Template imports require approval and the required permissions. Missing callbacks hide their controls, and request guards preserve newer drafts.

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

Mount the Client export alongside the Bot Remote, Session UI, conversation UI, locale, layout, sidebar, renderer, and Connection packages. The owner supplies plain roster rows and callbacks; the panel selects a Bot and renders the owner's persistent Session in its conversation slot. When Connection is mounted, the same Bot mode includes an invite and shared-context policy dialog for owner-side membership management and a shared workspace where an owner can create a group from accessible Bots and issue a group invite. Create or request a Bot invite for every Bot and redeem those invites before creating or joining a room; a group invite grants room access but does not replace those Bot memberships. Collaborators discover shared Bots and groups, chat through a private per-person Session, and publish explicitly acknowledged notes to a separate shared context. In shared groups, collaborators can mention specific Bots to address only those recipients.

Open **Group settings** in a shared room to see its Bots and people. Room owners can change the name or remove a member's access to the room.

### When to choose it


Choose this package for a second, switchable Bot mode with a dedicated roster and expressive identity marks. Use the ordinary Session workspace when users should browse conversations without named Bot records or when the composition cannot provide the required Remote callbacks.

### Minimal configuration

The Client package has no user configuration fields. Mount its browser entry in the Client composition:

```yaml
- name: '@yharness/client-ui-bots/client'
```

The composition must provide the injected Bot Remote, Session store, locale, layout, sidebar, conversation, renderer, and slot services. The avatar-generation Remote is optional; without it the workspace still supports character editing and image upload when the corresponding Bot Remote methods are available.

### Owner callbacks

`BotRoster` accepts the roster, selection, and creation callbacks. The setup dialog collects a name, role, persona, capabilities, character, and color. `BotDetail` renders the selected Bot's persistent Session and can edit its profile using the captured row revision to prevent stale changes. Optional actions support connected apps, organization, avatar editing and generation, sharing, templates, and host-local skill policies. When routine actions are mounted, the detail header opens a manager for timed and message-triggered routines with bounded history and confirmation for changes. Hidden and pinned Bots have dedicated sections.

### Visual identity

Animated characters use the selected accent color throughout their bodies. The persisted `identity` and `accent` select a character and its color; reduced-motion settings stop its animation. Generated or uploaded images remain an in-memory preview until the user chooses Use this avatar; only then does the owner commit and assign an attachment reference. Uploads accept PNG, JPEG, WebP, and GIF files up to 25 MiB and provide adjustable square cropping. Loading or failure falls back to the selected character.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client registration creates one controller for the Bot Remote, Session store, locale translator, and optional avatar-generation Remote. It injects the main panel, its selected-session conversation slot, and the sidebar entry as one effect; disposing the effect removes each registration and the change listener. Create retries retain the complete profile payload under one stable Bot id, and profile updates replace only user-authored fields in the roster projection while retaining the selected Session reference. Shared-group create and send retries use one principal-scoped localStorage record per operation, a server-issued principal scope, and Web Locks; a complete result clears the record, while expiry removes message text but keeps a tombstone id for reconciliation until the user explicitly recovers or discards it. New records use a versioned localStorage namespace, and the first access migrates valid records from the previous namespace before pruning; the queue acquires the catalog lock and the legacy per-operation lock, so a tab that has not loaded catalog-wide coordination must be reloaded before it retries unrelated shared-group operations. Each principal has a bounded retry quota; the Client never evicts an unresolved tombstone, and the UI asks the user to recover or explicitly discard records before accepting another operation. A reload restores the scope only through the authenticated shared-session endpoint; no operator identity is inferred in the browser. Browsers without durable storage or Web Locks fail closed before claiming safe retry. Targeted messages keep their exact Bot IDs in a separate versioned namespace, so a retry cannot silently become a broadcast; older tabs must reload to recover those messages. Invalid targeted retry records remain stored and block retry operations rather than losing the intended recipients. Template imports explicitly approve the pasted signed artifact only after the current code's preview, avatar, fingerprints, target-local tool view, and ephemeral approval token still match; the controller then retains an operation id while it retries the same code and name, so the Host can return one Bot after an uncertain response. Group transcripts show attributed messages and preserve the original message id for explicit retries; owner views may additionally render persisted per-recipient delivery states and safe model-turn failures. Skill policy updates carry the catalog revision and surface a conflict when another actor has changed it. Presentational components receive plain props, so Host persistence and Session navigation remain outside the UI package.

| File | Role |
|---|---|
| [`src/client/apply.ts`](src/client/apply.ts) | Client injections, locale registration, panel slots, sidebar entry, and controller lifecycle. |
| [`src/client/controller.ts`](src/client/controller.ts) | Bot roster loading, selection, Session binding, avatar loading, and owner-facing callbacks. |
| [`src/client/BotWorkspace.tsx`](src/client/BotWorkspace.tsx) | `BotRoster` sidebar and `BotDetail` main-panel surfaces with loading, error, empty, and creation states. |
| [`src/client/BotGroupAttachments.tsx`](src/client/BotGroupAttachments.tsx) | Group-message picker, image preview, retry, and message-scoped download presentation. |
| [`src/client/BotRoutineManager.tsx`](src/client/BotRoutineManager.tsx) | Selected-Bot routine list, details, bounded history, and lifecycle confirmations. |
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
- **Provider selection is not a profile field** — setup and editing intentionally do not promise dynamic provider or model switching; those choices remain owned by Session composition and Host presets.
- **Shared retry scope follows authenticated enrollment** — shared-group recovery requires the server-issued principal scope returned by Bot enrollment or the authenticated shared-session endpoint after reload; the Client does not fabricate an owner identity because the Host does not expose one through this package. The endpoint must be mounted by the shared route for reload recovery.
- **Shared retry needs browser coordination** — durable recovery requires localStorage and Web Locks. Unsupported browsers fail closed; the UI does not claim that a retry is safe when tabs cannot coordinate.
- **Skills are Host-local** — the manager edits only the selected Bot's policy on the current Host; it does not publish skills, copy policies through templates, or revoke a body already included in a completed model request.
- **Group-message attachments require Host admission** — local and shared composers stage browser files, preview images, and retain drafts after optional transport failures; the Host turns each file into an opaque ACL-scoped grant before the idempotent group send, and rejects attachment sends when the relevant admission callback or authenticated upload route is unavailable.
- **Template operation ids are controller-local** — a full browser reload before a failed import is reconciled loses the in-memory retry key; callers that need recovery across reloads can submit their own stable `importId` through the Host Remote.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
