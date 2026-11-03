---
kind: upgrade-guide
description: "Credential-less Bot hosts now recover roster writes through agent_bot_intents and cannot mix versions while an intent is pending."
---

# Credential-less Bot intent recovery

## Change

Hosts without a credential provider now write a version-one `agent_bot_intents` write-ahead record before each Bot roster create or update. A current host retries a retained intent before a later mutation and replays a durable pending intent on the next roster read after restart. Older BotService versions do not read this domain, so mixed-version operation is unsupported while a pending intent may exist; an older host could overwrite the Bot row without replaying the intent.

## Migration

1. Upgrade every Host process that opens the same `agent_bots` storage before using credential-less Bot writes. Do not run old and new BotService versions together while `agent_bot_intents` may contain a pending row.
2. Keep the existing Bot roster and let the upgraded host perform its next roster read or mutation. No manual rewrite is required; the current host writes the pending Bot row and clears its intent.
3. Confirm the upgraded host's normal `ctx.remote.bots.list({})` result contains the intended Bot profile before allowing another version to open the same storage.
