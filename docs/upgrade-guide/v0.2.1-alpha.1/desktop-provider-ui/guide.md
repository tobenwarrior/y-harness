---
kind: upgrade-guide
description: Desktop account controls move from the sidebar and Account category into Models, and saved welcome steps stop displaying.
---

# Desktop provider connection controls

English | [中文](guide.zh.md)

## Change

Desktop uses the neutral Settings launcher for fresh and existing profiles. The sidebar account menu and Account settings category are removed. Optional DeepSeek connection, confirmed disconnect, usage and balances are in Settings → Models. Account login no longer precedes the independent API-key editor. Saved welcome steps no longer display.

`AccountSectionProps` now uses the `settings.models.footer` owner props rather than `settings.section`. Existing credential records, settings keys, sessions and introduction progress retain their schema and contents.

## Migration

1. Open Settings → Models to manage the optional DeepSeek connection or an API-key provider. Cancelling or closing the page preserves existing grants.
2. Custom clients mounting `AccountSection` must use the Models footer seat instead of supplying section navigation props. Clients requiring a different login presentation should use their own explicit contribution.
3. Confirm that the workspace opens without an account dialog, the Settings navigation has no Account category, and previously configured providers remain available. No profile migration or credential deletion is required.
