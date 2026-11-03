---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-session-format-v5

English

## Summary

Advances the Session writer from V4 to V5 and records the replay-aware Bot group-message source in the message and inbox event roots.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-10-linked-context-sequential-evidence"
    after: "0d29c68b02d32ea0ff738c65dbe91ccfeaf4f01bd8ba0b30e3a82248610238d0"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-10-10-linked-context-sequential-evidence"
    after: "908ca99629c37933174682f19ab4715c13012ee9bfee2fb2d9f9dce17dc29e95"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-10-10-linked-context-sequential-evidence"
    after: "f7f2d8340be5b1c3f8e8c239563ea8791e9b96a6f20ff08342d66ffb25a5dead"
    decision: version-bump
  - root: "event:skill/learning-request"
    previous: "2026-10-10-linked-context-sequential-evidence"
    after: "85a842623eed97a9d09abf7b52cea18f5b1ac199e51795b44f2bdfa710661a50"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-10-10-linked-context-sequential-evidence"
    after: "cda2bd98b341843c9cbe18b2ad21736ae80b7297b955a6d235eae720d3c46ae2"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

V4 files remain immutable and readable through the adjacent V4-to-V5 migration. The migration preserves event bodies, identifiers, inherited cuts, and delivery history while the V5 reader applies the current Bot group-message source rules. V4 readers must not open V5 files because they cannot enforce the Bot collaboration replay and isolation semantics. JSONL writes publish V5 successors beside unchanged V4 files; no historical file or provider credential is rewritten or deleted.

<a id="verification"></a>
## Verification

The V4-to-V5 format and JSONL migration tests pass, including header validation, delivery ownership, inherited cuts, and preserved event data. The generated persistence catalog, current schema inventory, V4 historical schema, and V0–V5 format references were regenerated and checked with pnpm run verify-persistence-catalog and pnpm run verify-persistence-formats. The focused migration/catalog suite passes 125 tests with 1 skipped; the V3-to-V4 regression suite passes 382 tests.

<a id="dev-note"></a>
## Dev Note

None.
