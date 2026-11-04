---
kind: upgrade-guide
description: "Bot routine profile revisions use a v3 successor that reads the immutable setup-release v2 record."
---

# Bot routine profile revisions use a v3 successor

## Change

The Bot routine writer stores its profile-revision snapshots under `agent-bots/profile-revisions-v3`. The v3 schema adds the durable roster and bounded timed-routine projection while preserving the setup-release v2 fields. A new Host reads v2 and the released v1 predecessor as migration sources, writes v3, and leaves both predecessors unchanged. v2 readers must not be extended to accept v3-only fields.

After v3 has committed, keep all Hosts that can mutate one Bot store on the v3 reader and writer. A Host that only understands v2 may be used with a pre-v3 backup, but must not be mixed with a store that contains routine-era v3 state.

## Migration

1. Stop Hosts that can mutate the Bot store.
2. Preserve the existing `agent-bots/profile-revisions` and `agent-bots/profile-revisions-v2` records.
3. Start the routine-capable Host and confirm that the Bot roster loads; the first read or mutation creates `agent-bots/profile-revisions-v3`.
4. Keep routine-capable Hosts together for future Bot edits. Do not delete or regenerate either predecessor record.
