---
kind: upgrade-guide
description: "Native Bot action records are now required so a lost native cursor can be reconstructed safely."
---

# Native Bot action replay

## Change

`bot/dynamic-tool` records written by the Bot provider no longer carry the optional `ignorable` marker. The records remain outside the ordinary Bot conversation surface, but the native Codex route reads them after a cursor loss or restart to reconstruct prior Bot actions. Replay is byte-bounded and discloses omitted records; an unsettled send remains an uncertain delivery.

## Migration

1. Keep existing Session logs. The current reader recognizes records written by the previous build with `ignorable: true`; no manual rewrite is required.
2. Run the upgraded Y Harness profile and confirm that a Bot Session can continue after the native Codex process is restarted. The next native request should include a bounded action-history disclosure before the current request.
3. If another reader cannot recognize `bot/dynamic-tool`, upgrade that reader before opening these Sessions. Do not mark future records ignorable or delete the Session log to bypass the refusal.
