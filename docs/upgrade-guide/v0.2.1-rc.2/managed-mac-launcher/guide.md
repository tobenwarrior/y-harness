---
kind: upgrade-guide
description: "Older GitHub-managed Mac launchers may need macOS Computer permission approval after updating."
---

# Managed Mac launcher permissions

## Change

Older GitHub-managed Mac bundles opened the source checkout embedded in their launcher when started from Finder or the Dock. The update replaces those launchers so Finder and Dock use the supervisor's active version. The new bundle keeps the existing bundle identifier and has a new signature. macOS can require Screen Recording and Accessibility approval again.

## Migration

1. Install the update using the Y Harness update control. Reopen the usual Y Harness app from Finder or the Dock and confirm it opens your workspace.
2. If the Mac Computer panel shows a missing permission, follow the [Mac Computer permission prompts](../../../user/guide/index.md#let-a-bot-use-your-mac). Confirm the panel recognizes the permission afterward.
