---
kind: upgrade-guide
description: "Shared Bot membership and private-session rows move to bounded, case-preserving pair keys across JSON and SQLite storage."
---

# Shared Bot storage keys are path-safe

## Change

`agent_bot_shares` membership and private-session rows use bounded `shared-v3_<sha256(bot-id)>_<sha256(principal-id)>` keys. The digests preserve case distinctions while avoiding path-length and case-insensitive-filesystem collisions. Startup accepts both the predecessor `shared-v2_<bot-id>_<principal-id>` rows and older percent-encoded `bot-id:principal-id` rows, copies them to the v3 key, verifies duplicate values structurally, and removes the predecessor only after the successor is durable. Authority membership snapshots, private-session snapshots, and invite rows are preserved.

Current Hosts serialize this migration through the shared authority credential record, so a second current Host waits for the first Host's copy/delete transaction instead of racing a stale read. Upgrade every Host before opening the shared store and stop every pre-migration writer; older binaries can still write predecessor keys and are not concurrency-safe with this migration. A failed durable write leaves the predecessor row for a later retry.

## Migration

1. Upgrade every Host that can open the shared Bot store before restarting any of them. Do not run a pre-migration Bot service beside the new service during migration.
2. Restart one or more upgraded Hosts. The `@yharness/bots` service migrates `agent_bot_shares` rows before loading memberships or private-session bindings; no invite reissue or authority reset is required.
3. Confirm that shared enrollment and existing private conversations still resolve. A storage failure leaves the legacy row in place; restart with the upgraded Host after correcting the backend failure.
