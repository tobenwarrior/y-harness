---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-bot-collaboration

## Summary

Adds the required log-only `bot/collaboration` event for durable peer-delivery acceptance and cancellation recovery without changing the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-bot-collaboration
baseline: false
changes:
  - root: "event:bot/collaboration"
    previous: null
    after: "c18d481bf8e13be60dc6f553f37e9edd5163f4ae015724d7f3384c6520f301af"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such event and remain valid. Readers that predate this event refuse a log carrying it, as with other required-on-read events. The lifecycle record is not model-visible Bot conversation content; it records the durable peer receipt status so a later inbox cancellation can be recovered without rewriting the earlier acceptance result. No existing event or envelope changes.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/agents/bots/tests/service.spec.ts: 34 tests passed, including cancellation repair, retry, stale-repair race, and restart recovery coverage. pnpm run verify-persistence-catalog validated the current event inventory.

<a id="dev-note"></a>
## Dev Note

None.
