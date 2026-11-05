---
kind: upgrade-guide
description: "Targeted shared-group message retries use a separate browser storage namespace."
---

# Shared-group mention retries use a new namespace

## Change

Shared-group messages that mention specific Bots retain their recipient IDs in a new browser storage namespace. Older clients cannot recover these targeted messages. Existing untargeted retry records remain in their original namespace.

## Migration

1. Reload every Y Harness browser tab before sending messages with Bot mentions.
2. Recover or discard pending messages in the updated client. Keep browser storage until pending operations are resolved.
