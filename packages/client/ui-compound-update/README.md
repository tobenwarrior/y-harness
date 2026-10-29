---
description: "Sidebar update indicator and steps panel for the Compound skills vendored into Y Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compound-update

## Summary

The sidebar foot shows a small status badge only when a Compound revision is pending or its latest check failed. A successful current check stays quiet so the app-update affordance remains the only persistent update signal; the Compound updater checks and applies revisions automatically in the Host. Opening a pending or failed badge explains the result and keeps the deliberate refresh/apply actions available. When an update is available, one button applies it: the Host downloads the commit-pinned skill tree into a private overlay, verifies every file, and publishes the complete revision atomically. A failed attempt leaves the active revision untouched and reports why.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use this package"></a>
## Use this package

Mount beside `@deepseek-ai/dsh-skill-compound`, which registers the `api/skill-compound.update` reading route and the `api/skill-compound.update.apply` route the button posts to.

```yaml
- name: '@deepseek-ai/dsh-client-ui-compound-update'
```

The badge registers into `sidebar.footer.action` and the steps panel into `shell.overlay`; both share one reading controller, so the panel shows the state the badge announced.

| Reading | What the user sees |
|---|---|
| Released version is newer | Pending badge with the released version; the panel names both versions and the upstream repository, and offers the update button. |
| Released version matches | No sidebar badge; the automatic updater stays quiet after confirming the bundled revision is current. |
| Upstream unreadable | Check-failed badge; the panel reports why the check failed and offers another attempt. |
| First reading has not completed | No badge yet; the panel shows a concise loading state when opened. |

## Understand the implementation

| File | Responsibility |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Registrations, dictionary, and periodic status reads. |
| [`src/client/controller.ts`](src/client/controller.ts) | Route request, response validation, and the shared reading state. |
| [`src/client/UpdateBadge.tsx`](src/client/UpdateBadge.tsx) | Sidebar-foot badge. |
| [`src/client/UpdatePanel.tsx`](src/client/UpdatePanel.tsx) | Released version, upstream link, and update steps. |

The controller validates the route body before anything renders it, keeps the last reading when a newer request fails, and drops a superseded response instead of publishing it.

## Further Exploration

- [`packages/skill/skill-compound`](../../skill/skill-compound/README.md) — the vendored skills and the route this package reads.
- [compound-skills](https://github.com/tobenwarrior/compound-skills) — the upstream repository whose release is reported.

## Model Experience

None, as the browser indicator adds no prompt section, tool, or session event and the model never sees its state.

#### KV Cache effect

The indicator does not alter model request prefixes.

## Known Limitations and Deferred Work

- The panel applies a verified user-owned overlay. The managed production checkout is intentionally left unchanged, so applying a revision does not depend on a detached Git checkout or a live-app rebuild.
- The reading is cached by the Host for six hours after success and fifteen minutes after a failure, so a release published in between appears on the next read rather than immediately.
- The package reads one route and renders no version of its own; a deployment that mounts it without `@deepseek-ai/dsh-skill-compound` shows no badge and reports the missing route as an unreadable check.

### Dev Note

The badge and panel share one reading controller; the Host caches the released version, so opening the panel does not re-request it.
