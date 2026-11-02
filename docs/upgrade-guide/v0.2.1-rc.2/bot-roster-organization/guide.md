---
kind: upgrade-guide
description: "Bot roster listings omit hidden Bots by default and return pinned Bots first."
---

# Bot roster organization

## Change

The `bots.list` Remote returns visible Bots by default and orders pinned Bots before other Bots. Stored Bot records gain optional organization fields while existing Session mappings remain unchanged.

## Migration

1. Update consumers that need every Bot, including hidden Bots, to call `bots.list({ includeHidden: true })`.
2. Upgrade all readers of the Bot storage domain before opening the updated store. Keep existing Bot and Session data; no manual rewrite is required.
3. Confirm that hidden Bots remain available to collaboration and that clients relying on creation order account for pinned Bots appearing first.
