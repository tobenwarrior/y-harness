---
kind: upgrade-guide
description: "Bot profile revision records use a compatible v2 successor for setup data and Bot routine projections."
---

# Bot profile revisions use a v2 successor

## Change

The Bot service stores profile-revision snapshots under `agent-bots/profile-revisions-v2`. The v2 snapshot is a compatible superset: it retains the released top-level persona and capability fields, and may add a complete setup roster or a bounded timed-routine projection. A new Host migrates the released `agent-bots/profile-revisions` record on first read and keeps the v1 record unchanged. If a v2 routine projection predates the setup roster, one serialized convergence pass copies only fields that are absent from that incomplete snapshot; a v2 roster and explicit `null` clears remain authoritative. Released Hosts cannot interpret the v2 snapshot or the new Bot profile fields, so mixed-version access to one Bot store is unsupported after the v2 writer starts. Deploy the routine and setup writers and readers as one release; if setup is shipped after a v2 writer is already deployed, add a v3 successor instead of extending v2.

## Migration

1. Stop every Host using the Bot store before deploying the profile-editing build, including Hosts that already write the v2 successor.
2. Start the upgraded Host once and confirm that its Bot roster loads; this creates the v2 successor without deleting the v1 record.
3. Keep upgraded Hosts together for future Bot edits. Do not roll back to a released Host after the v2 successor is created, even before v2-only fields are written; restore a backup taken before migration before using the released Host.
