---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-02-bot-memory

## Summary

Adds the required bot/memory Session event used to persist Bot remember and forget operations without changing the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-02-bot-memory
baseline: false
changes:
  - root: "event:bot/memory"
    previous: null
    after: "8a530ef5e641ff7d754a5105cafe451f7ad5bca04f8d8cd283a1da406361ae1d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session logs contain no bot/memory events and remain valid. New readers reconstruct active Bot memories by folding remember and forget events; older readers reject a log containing this required event, as they do other unknown required events. The event is log-only and the memory text is inserted into later prompts only through the Bot-owned projection. Forget is logical: it removes a memory from future projections but cannot erase the append-only event or an earlier prompt already sent to a model.

<a id="verification"></a>
## Verification

CI=1 node_modules/.bin/vitest run packages/agents/bots/tests --maxWorkers=1: 5 files and 55 tests passed. pnpm run gen-persistence-catalog regenerated the event catalog and schema inventory; pnpm run gen-cordis-catalog refreshed the public Bot collaboration catalog.

<a id="dev-note"></a>
## Dev Note

None.
