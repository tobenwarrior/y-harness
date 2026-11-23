---
kind: upgrade-guide
description: "Resuming a Bot message routine or changing its source writes a new eligibility sequence to the Bot store."
---

# Bot message routine recovery starts with new messages

## Change

Resuming a paused message routine or changing the message source of an active one saves the first eligible Session event sequence. The next startup skips older messages for that routine. Existing records remain readable and previously admitted runs still use their saved delivery records.

## Migration

1. Stop all Hosts using the Bot data before installing this update.
2. Keep a backup of the Bot store and `agent-bots/profile-revisions-v4` before the upgrade if you plan to roll back.
3. Start the upgraded Host and open the Bot’s **Routines** panel. Resume a paused message routine and send a new message to check that its run appears in **Results**.
4. To return to an older Host version, restore the pre-upgrade Bot store and matching profile record together.
