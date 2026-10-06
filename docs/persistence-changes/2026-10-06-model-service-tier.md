---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-model-service-tier

English | [中文](2026-10-06-model-service-tier.zh.md)

## Summary

Adds an optional service tier (processing speed) to the durable model selection and to the logged request header config and adapter defaults.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-model-service-tier
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "7f460f65c6e3f83e46b1ac38db7eb243d64200ca5fc1406c9469b443926c8ae2"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "ea54488eedb946ef8492ce61969b03ffb773d77abbdcc0bb8e26213225054e05"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. The field is optional everywhere it appears; absence keeps the previous behavior, where the adapter's own default tier applies, and no reader requires the field. Producers write it only for a model whose catalog advertises selectable tiers, so sessions on every other route are byte-identical to before.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/api/session-controller packages/core/session packages/core/agent packages/core/agent-default-model packages/llm/llm packages/llm/llm-pi-ai: 169 files, 3794 tests passed. pnpm exec vitest run packages/client/ui-model-selection: 3 files, 81 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
