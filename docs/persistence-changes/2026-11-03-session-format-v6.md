---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-03-session-format-v6

English

## Summary

Advances the Session writer from V5 to V6 for the durable Bot event-routine message source and keeps the V5 group-message generation immutable.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-03-session-format-v6
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-11-03-session-format-v5"
    after: "2f59bdc20b513c0b072ce0f0f3d6421bfe88bd6b866dccfbae315090081b2d63"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-03-session-format-v5"
    after: "a3dca8b4ca916e6e574186cc579a55cec3a71d78ed31fdca25be0a763c683e91"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-11-03-session-format-v5"
    after: "075246fadb3af0f7a3ed0d1d8b5f0bdf06e14620b7f9c4fc54aaa593e73b3742"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-11-03-session-format-v5"
    after: "ee0d410fd254722ec23883d1dbfd4ecf024094d9eb82d19e347c5a55d0002a79"
    decision: version-bump
  - root: "event:skill/learning-request"
    previous: "2026-11-03-session-format-v5"
    after: "788694497248a47c5e3c6364964d80ffcc213191b168dd57eb036834fad5f380"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-11-03-session-format-v5"
    after: "1365574dd46e8a12e289a00c113c3b71a10a25d537311b27c8d70d06c6296e9f"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The V5 inventory is frozen from integration/group before routine additions. The adjacent V5-to-V6 migration preserves event bodies, identities, inherited cuts, and V5 delivery history while the V6 reader validates event-routine source fields. V5 readers must not open V6 files because they cannot interpret the new source union; persistence publishes V6 successors beside unchanged V5 files.

<a id="verification"></a>
## Verification

The V5-to-V6 format test passes 6 tests. The current persistence catalog and schema were regenerated, and the frozen V5 schema was captured from the integration/group tree before V6 generation.

<a id="dev-note"></a>
## Dev Note

None.
