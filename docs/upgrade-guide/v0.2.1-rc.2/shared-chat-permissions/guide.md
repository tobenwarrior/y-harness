---
kind: upgrade-guide
description: The Web permission picker can share one access mode across private chats in a profile.
---

# Shared access for private chats

## Change

The General settings picker saves a shared mode as `permission.sharedPreset`. Open and reopened private chats in the same profile use it. The composer can change the shared mode once it is enabled. A chat using the shared policy directs an explicit `/permission <preset>` command to the picker or Settings. Existing choices remain in effect until the first shared selection in General settings.

## Migration

1. In an authenticated Web or desktop profile, open **Settings → General → Permission**.
2. Choose **Ask for approval** to share a workspace-limited mode with explicit approval for wider actions.
3. Open a second private chat in that profile and verify that the composer shows the same mode.
