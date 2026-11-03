---
kind: upgrade-guide
description: "Session JSONL writers advance from V4 to V5 to preserve Bot group-message source evidence."
---

# Session format V5

## Change

Y Harness now writes Session JSONL with format V5. V5 records preserve the replay-aware Bot group-message source and its isolation metadata. V4 files remain valid historical inputs, but a V4 reader must not open a V5 file because it cannot enforce the updated Bot collaboration rules.

## Migration

1. Upgrade the Y Harness writer and every reader that opens its Session files together. The JSONL persistence provider migrates V4 input to V5 while preserving event bodies, identifiers, inherited cuts, and delivery history.
2. Keep existing V4 files in place. The provider writes a V5 successor beside the original; it does not rewrite or delete the V4 file and does not change provider credentials.
3. Confirm the migration by reopening a Bot Session created before the upgrade, sending a group-message turn, and restarting Y Harness. The resumed Session should contain the prior V4 history and a V5 current writer file.
