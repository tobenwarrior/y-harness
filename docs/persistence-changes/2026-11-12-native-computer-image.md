---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-native-computer-image

## Summary

Records an optional attachment reference for a native Computer observation.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-native-computer-image
baseline: false
changes:
  - root: "event:bot/dynamic-tool"
    previous: "2026-10-30-bot-dynamic-tool"
    after: "6eebf6368950ede361f0ece53861dc120ef9b6f86db90b8def54b569f90f5d54"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The reference is an additive change in the current Session format. Existing text-only results retain their meaning. The attachment store retains the screen image for the recorded reference.

<a id="verification"></a>
## Verification

The 98 focused tests cover the native adapter, Bot composition, and VPS Computer controller. The Codex fixture receives the image while the Session records its attachment reference.

<a id="dev-note"></a>
## Dev Note

None.
