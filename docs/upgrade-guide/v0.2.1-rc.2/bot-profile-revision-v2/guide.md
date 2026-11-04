---
kind: upgrade-guide
description: "Bot profile revision records move to a v2 credential successor when persona or specialty data is persisted."
---

# Bot profile revisions use a v2 successor

## Change

The Bot service now stores profile-revision snapshots containing persona and specialty declarations under `agent-bots/profile-revisions-v2`. A new Host migrates the released `agent-bots/profile-revisions` record on first read and keeps the v1 record unchanged. Released Hosts cannot interpret the v2 snapshot or the new Bot profile fields, so mixed-version access to one Bot store is unsupported after the v2 writer starts.

## Migration

1. Stop every Host using the Bot store before deploying the profile-editing build.
2. Start the upgraded Host once and confirm that its Bot roster loads; this creates the v2 successor without deleting the v1 record.
3. Keep upgraded Hosts together for future Bot edits. Do not roll back to a released Host after v2 profile fields have been written unless the store is restored from a backup taken before the migration.
