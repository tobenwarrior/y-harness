---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-30-bot-dynamic-tool

## Summary

Adds the required log-only bot/dynamic-tool event for native Bot action recovery without changing the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-30-bot-dynamic-tool
baseline: false
changes:
  - root: "event:bot/dynamic-tool"
    previous: null
    after: "0bf1eedc74932bfd1594fab107fd835e5692d83dc7f3f3f6a6b6b388c7261213"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such event and remain valid. Readers that predate this event refuse a log carrying it, as with other required-on-read events. The event is never model-visible Bot conversation content; native Codex reconstruction uses its bounded lifecycle data when a cursor is lost. No existing event or envelope changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/agents/bots/tests/native-tools.spec.ts packages/agents/bots/tests/codex-composition.spec.ts: 2 files and 9 tests passed. pnpm run verify-persistence-catalog, pnpm run verify-persistence-formats, and pnpm run verify-persistence-changes validate the generated inventory and acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
