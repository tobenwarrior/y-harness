---
kind: upgrade-guide
description: "Bot profile revision records keep the setup-release v2 generation immutable."
---

# Bot profile revisions keep setup-release v2 immutable

## Change

The setup release stores profile-revision snapshots under `agent-bots/profile-revisions-v2`. That record is frozen with the setup release's fields and remains readable as a predecessor. Routine-era fields such as the durable roster and bounded timed-routine projection belong to the separate `agent-bots/profile-revisions-v3` successor; they must not be added to the strict v2 schema. The v1 predecessor is also retained unchanged.

## Migration

1. Keep the setup-release v2 record and its predecessor in place; do not rewrite either record to add routine fields.
2. Deploy a routine-capable Host that reads v2 and writes the v3 successor. See the v3 guide for the mixed-version deployment rule.
3. Do not roll back a Bot store after a v3 writer has committed routine-era state; restore a backup taken before the v3 migration before using a Host that only understands v2.
