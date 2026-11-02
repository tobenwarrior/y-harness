---
kind: upgrade-guide
description: "Bot image avatar selections are replaced by animated character avatars while Bot records and Sessions remain available."
---

# Animated Bot avatars

## Change

The Bot workspace now renders animated character avatars from each Bot's `identity` and `accent`. The `BotIdentity` values include eight additional character shapes; clients that exhaustively handle identity values must accept them before those shapes are selected. Existing generated image selections are cleared from the persisted `agent_bots` records on the first startup after upgrade; their attachment files remain on disk, and Bot ids, names, settings, and Session mappings are preserved. The migration runs once and records its completion in the `agent_bots` domain global state.

## Migration

1. Upgrade and start Y Harness normally. The `@yharness/bots` service migrates existing `agent_bots` data automatically; no Session export or manual file conversion is required.
2. Open the Bot workspace and confirm that each existing Bot shows its animated character. Confirm that its linked Session and Bot settings are still present.
3. If startup is interrupted during migration, start Y Harness again. The migration is retryable and does not delete the retained image attachments.
4. Update clients that switch on `BotIdentity` to handle the values exported by `BOT_IDENTITIES` before selecting the additional shapes.
