---
description: "Permission preset surfaces for the Web GUI: the shared permission selector in General settings and private chats; for users and maintainers of permission policy."
kind: "package-reference"
---

# @yharness/client-ui-permission-presets

## Summary

Choose a shared permission preset in General settings, the composer, or the `/permission` picker. The Host publishes the effective mode through each private chat’s permissions projection. Full access requires acknowledgement of the profile-wide effect. Separate session policies can offer experimental Auto review.

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

Mount this plugin alongside the settings, commands, and conversation packages. General settings receives the shared access row; the composer receives the `conversation.input.permission` control, and bare `/permission` opens the slash picker. Current-session controls require both the Session projection and a complete catalog snapshot. A permission-less composition exposes neither current-session controls nor the Settings row.

### The picker

After the first shared selection in General settings, private chat pickers save `permission.sharedPreset` through the same Settings API. The session-specific pickers submit `/permission <preset>`. The built-in English labels are `Read Only`, `Ask for approval`, `Approve for me`, `Full access`, and `Auto review`; localized deployments may provide equivalent labels. Explicit host labels remain unchanged, unknown kebab-case names render in title case, and `auto` carries an `EXP` badge plus an experimental-risk confirmation. `custom` is display state, never a target.

When the live catalog withdraws a preset, the composer closes its pending confirmation and shows the Session's current value instead of an unavailable optimistic pick. Every catalog invalidation — the payload-free notification or a connection-generation change — closes an open slash picker or its confirmation without consuming the draft, while publishing the result of a read the picker waits for leaves it open with its failure and retry state; reopening reads the current catalog. A submitted command remains busy until its response settles.

### The Settings row

The row takes its choices from the configured preset catalog. Selecting a mode applies it to open, new, and reopened private chats in the profile. The row uses the legacy future-session default when connected to an older Host.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The General row reads the explicitly exposed `permission` Settings descriptor through `ctx.configForms` and writes one `settings.mutate` path operation with the descriptor revision; its observable rides the slot system's `hooks` compartment, so the renderer owns React hook binding, and a push invalidation refetches the descriptor. The chooser writes through the Host settings provider and uses its revision to reject stale edits. A popupSelect decoration for the bare `/permission` command opens the composer picker. One process-scoped directory subscribes to the payload-free catalog notification before its first Remote read and publishes only the latest complete success for the active connection generation. A winning failure or connection reset clears the old snapshot, which hides the composer seat until a later existing trigger retries, while the slash picker stays available and shows the failure with its retry; stale-generation and disposed settlements are ignored. Its public observables are `{ value }` and `invalidations`, one tick per catalog notification or connection-generation change; failures remain internal to imperative loading. Both the slash popup and composer seat consume that shared catalog, while the Session `permissions` projection supplies only `currentValue`. Full access and Auto review each carry localized confirmation copy; Auto also carries the badge rendered by the shared popup shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the permission surface is not enough. They move from the browser surfaces to the host policy and the command shell.

- [dsh-permission-presets](../../interaction/permission-presets/README.md) — the host-side permission preset policy these surfaces write.
- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/permission` decoration registers into.
- [ui-conversation](../ui-conversation/README.md) — the composer seat that joins this shared catalog with the Session's current value.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the durable permission facts the Host writes for each affected session. Sandbox and approval consumers resolve their own knob events; selecting `auto` additionally activates the host Auto integration's independent per-call reviewer.

#### KV Cache effect

No direct invalidation; the knob consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current permission surfaces. They are current package constraints, not a general policy comparison or a task backlog.

- **The Settings row is Web-only** — non-Web clients may still switch the current session through `/permission`, but do not receive this browser contribution.
- **Auto review is current-session-only** — the General-settings row intentionally omits it, and only visible picker selection receives the experimental confirmation; an explicitly typed `/permission auto` is already explicit consent.
- **Preset descriptions come from the host** — localized built-in labels may therefore appear beside a description written in another language.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
