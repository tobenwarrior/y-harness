---
kind: upgrade-guide
description: "Bot peer-delivery lifecycle records are now required for durable cancellation recovery."
---

# Bot collaboration receipts

## Change

Bot Sessions now record required `bot/collaboration` lifecycle events when a peer message is accepted and when its inbox receipt is later canceled before reaching the model-visible message surface. Existing logs remain valid, but readers that do not recognize this event refuse a log that contains it. The [persistence acknowledgement](../../../persistence-changes/2026-11-03-bot-collaboration.md) records the same-version compatibility decision.

## Migration

1. Upgrade every reader that opens Bot Session logs before opening logs written by the upgraded Bot service. No existing Session rewrite is required.
2. Keep the `bot/collaboration` event in new logs; do not mark it ignorable or remove it to bypass an older-reader refusal.
3. Send a peer-Bot message and confirm that the upgraded reader can reopen the target Session after an inbox cancellation or process restart.
