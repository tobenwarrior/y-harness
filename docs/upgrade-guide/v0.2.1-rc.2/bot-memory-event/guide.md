---
kind: upgrade-guide
description: "Bot memory is persisted as a required Session event that older readers cannot open without the updated event vocabulary."
---

# Required Bot memory events

## Change

Bot memory writes and logical forgets now append `bot/memory` events to the Bot-owned Session. These events are required: readers from v0.2.1-rc.2 that do not recognize the event type refuse the Session instead of silently dropping memory changes. Existing Sessions without Bot memory events remain readable, and logical forget removes the entry from future memory projections without erasing append-only history.

## Migration

1. Upgrade the Y Harness Host and any Session-log reader that opens Bot Sessions together. The current reader registers `bot/memory` through `packages/agents/bots/src/memory.ts` and validates the event before projecting it.
2. Keep existing Session files in place. No export or manual rewrite is required; the upgraded reader accepts old logs and begins writing the required event only when Bot memory changes.
3. If an external reader reports an unknown `bot/memory` event, update its Session-event vocabulary before opening that log. Do not delete the log or mark the event ignorable to bypass the refusal.
4. Confirm the migration by remembering a value, restarting Y Harness, listing the Bot memory, then logically forgetting it and confirming it no longer appears in future Bot prompts.
