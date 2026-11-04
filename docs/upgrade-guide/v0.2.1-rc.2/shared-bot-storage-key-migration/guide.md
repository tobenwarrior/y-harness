---
kind: upgrade-guide
description: "Shared Bot membership and private-session rows move from colon-separated pair keys to path-safe keys for JSON storage."
---

# Shared Bot storage keys are path-safe

## Change

`agent_bot_shares` membership and private-session rows previously used percent-encoded `bot-id:principal-id` keys. Those keys cannot be written by the JSON per-record backend. The service now writes `shared-v2_<bot-id>_<principal-id>` keys; the underscore delimiter is excluded by the stored Bot and principal id schemas. On startup, a current Host copies legacy rows to successor keys, verifies duplicate values, and removes the legacy rows. Authority membership snapshots, private-session snapshots, and invite rows are preserved.

Current Hosts can repeat this migration concurrently and retry it after a failed durable write. A pre-migration binary can still write colon keys while the successor is being migrated, so mixed-version Hosts are unsupported for this store migration.

## Migration

1. Upgrade every Host that can open the shared Bot store before restarting any of them. Do not run a pre-migration Bot service beside the new service during migration.
2. Restart one or more upgraded Hosts. The `@yharness/bots` service migrates `agent_bot_shares` rows before loading memberships or private-session bindings; no invite reissue or authority reset is required.
3. Confirm that shared enrollment and existing private conversations still resolve. A storage failure leaves the legacy row in place; restart with the upgraded Host after correcting the backend failure.
