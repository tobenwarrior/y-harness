---
description: "Sidebar update indicator and steps panel for the Compound skills vendored into Y Harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-compound-update

## Summary

The sidebar foot shows a small badge as soon as the released Compound skills version is newer than the one this Y Harness build ships. Opening it explains the difference and offers one button that applies it: the Host re-syncs the vendored tree, records the release, runs the package tests, and commits only when they pass, then asks the on-quit updater to rebuild and reopen the app. A failed attempt leaves the checkout untouched and reports why. The badge stays silent while the released version matches, cannot be read, or the deployment has no Host route to ask.

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
| Released version is newer | Badge with the released version; the panel names both versions and the upstream repository, and offers the update button. |
| Released version matches | No badge; the panel reports that this build already ships it. |
| Upstream unreadable | No badge; the panel reports why the check failed and offers another attempt. |

## Understand the implementation

| File | Responsibility |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Registrations, dictionary, and the single initial read. |
| [`src/client/controller.ts`](src/client/controller.ts) | Route request, response validation, and the shared reading state. |
| [`src/client/UpdateBadge.tsx`](src/client/UpdateBadge.tsx) | Sidebar-foot badge. |
| [`src/client/UpdatePanel.tsx`](src/client/UpdatePanel.tsx) | Released version, upstream link, and update steps. |

The controller validates the route body before anything renders it, keeps the last reading when a newer request fails, and drops a superseded response instead of publishing it.

## Further Exploration

- [`packages/skill/skill-compound`](../../skill/skill-compound/README.md) — the vendored skills and the route this package reads.
- [compound-skills](https://github.com/tobenwarrior/compound-skills) — the upstream repository whose release is reported.

## Model Experience

None. The indicator is browser chrome: it adds no prompt section, no tool, and no session event, and the model never sees its state.

## Known Limitations and Deferred Work

- The panel only reports. Updating the checkout, rebuilding, and restarting stay with the operator, because this fork's production checkout must not be rewritten by the running application.
- The reading is cached by the Host for six hours after success and fifteen minutes after a failure, so a release published in between appears on the next read rather than immediately.
- The package reads one route and renders no version of its own; a deployment that mounts it without `@deepseek-ai/dsh-skill-compound` shows no badge and reports the missing route as an unreadable check.

## Dev Note

The badge and panel share one reading controller; the Host caches the released version, so opening the panel does not re-request it.
