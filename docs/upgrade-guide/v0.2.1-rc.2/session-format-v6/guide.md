---
kind: upgrade-guide
description: "Session JSONL writers advance from V5 to V6 for Bot event-routine sources."
---

# Session format V6

## Change

Y Harness now writes Session JSONL with format V6. V6 records preserve durable Bot event-routine sources and their trigger metadata. V5 files remain valid historical inputs, but a V5 reader must not open a V6 file because it cannot interpret the new source union.

## Migration

1. Upgrade the Y Harness writer and every reader that opens its Session files together. The JSONL persistence provider migrates V5 input to V6 while preserving event bodies, identifiers, inherited cuts, and delivery history.
2. Keep existing V5 files in place. The provider writes a V6 successor beside the original; it does not rewrite or delete the V5 file.
3. Confirm the migration by reopening an existing Bot Session, triggering a Bot event-routine turn, and restarting Y Harness. The current Session file should use V6.
