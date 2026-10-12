---
description: "Y Harness brand occupants for the sidebar, active only in official builds; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package supplies an `official` client build with the shared Y mark and the configured plain-text app name. The sidebar renders the name alone; the conversation hero uses its own shared static Y fallback. Other build profiles use the sidebar's localized local-build label or configured display name. It has no runtime state and does not affect model requests.

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

Mount this plugin in the browser roster, then build the client with the `official` profile so the occupants register.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE` selects whether this package registers its `sidebar.brand.mark` and `sidebar.brand.name` occupants. An `official` build supplies the shared `YHarnessLogo` and the configured plain-text name; without `DSH_CLIENT_DISPLAY_NAME`, the name occupant retains its legacy `BrandWordmark` artwork. Other profile values leave the shell's name fallback in place. The sidebar renders only the name occupant and does not render the separate mark. The conversation hero uses the declaring package's static Y fallback regardless of profile. The plugin still loads and validates in both cases; only the registration is profile-gated.

### Replacing the brand

A rename uses the public [app display-name configuration](../../../apps/desktop/README.md#app-display-name); its build value `DSH_CLIENT_DISPLAY_NAME` supplies the plain-text name independently of the shared mark. A deployment can replace this package with another package occupying the sidebar slots, and can occupy the hero slot to replace its fallback. A sidebar mark occupant does not add artwork to the name row or collapsed rail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar declaration, so the set works whether this row activates before or after the declarer, withdraws both occupants when the declaration collapses, and leaves no partial brand mix during HMR. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders only the name row.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
