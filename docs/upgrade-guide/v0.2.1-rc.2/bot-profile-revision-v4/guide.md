---
kind: upgrade-guide
description: "Per-Bot skill policies use a v4 successor to the immutable v3 profile record."
---

# Bot skill profile revisions use a v4 successor

## Change

Bot skill settings are stored in `agent-bots/profile-revisions-v4`. A Host reads the earlier profile records and preserves them while writing the v4 successor. Hosts that only understand v3 cannot safely edit a store after v4 has been written.

## Migration

1. Stop every Y Harness Host that can access the Bot store, including background Hosts.
2. Keep the existing `agent-bots/profile-revisions`, `agent-bots/profile-revisions-v2`, and `agent-bots/profile-revisions-v3` records.
3. Start the updated Host and confirm that the Bot roster and routines load. The first profile read or mutation creates `agent-bots/profile-revisions-v4`.
4. Update all Hosts before using them with this store. Do not delete the predecessor records.
