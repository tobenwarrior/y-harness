---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-linked-context-sequential-evidence

English | [中文](2026-10-10-linked-context-sequential-evidence.zh.md)

## Summary

Ordinary-Y linked imports add an attribution-only historical context source and a log-only initializer ownership receipt. Sequential native continuations add start, native-turn, sanitized native-item, and end records tied to one admitted current Y task. Native patch observations retain bounded add/update/delete/move facts for independently verified learning proposals. These records preserve original provider/profile/session/turn identities and distinguish dispatch admissions from task correctness.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-linked-context-sequential-evidence
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-09-skill-learning"
    after: "88b51ccec6b454bff196b5cd956d21235e2fc971528d235530550c3cd265910d"
    decision: same-version
  - root: "event:coding-session/import-initialization"
    previous: null
    after: "3346bc09a8edab78ee6e631001882eaae8ade37e91c606068146234790297406"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-09-skill-learning"
    after: "e17a602e9d977b0f715960a4f5d9ef79a098fd7ea7096a63d30d16e0efb2a5b8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-09-skill-learning"
    after: "e1772de50c8b56961a81e637967742fbc01d998e089cba9b9092928a09059d31"
    decision: same-version
  - root: "event:skill/learning-request"
    previous: "2026-10-09-skill-learning"
    after: "177245cad7f338896d19c5d5b6d35a7650058863b984d439dac34cc3bb95d715"
    decision: same-version
  - root: "event:skill/native-item"
    previous: "2026-10-09-native-learning-root-protocol"
    after: "9ee3e528407bcaab064bebcc639624bac95aa2ab2e00b1ee26488b11d1a2bc11"
    decision: same-version
  - root: "event:skill/sequential-native-item"
    previous: null
    after: "1f68ab61681d3a55ebd0c6a333fc6450f6267913c6a01f5de72ec7074a537aae"
    decision: same-version
  - root: "event:skill/sequential-task-end"
    previous: null
    after: "4302630c0dd064feeea889e5a10f2a41725ff96e37f65bc1035145074138f70b"
    decision: same-version
  - root: "event:skill/sequential-task-native-turn"
    previous: null
    after: "42a11b7a6487a7a8db34ca28b924378a50e313a81afece69ec6872b7bba5893d"
    decision: same-version
  - root: "event:skill/sequential-task-start"
    previous: null
    after: "6259f110e38f73bf58e0afb00aa75761c705ffe7eff36c6eb446186360ec2ea9"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-09-skill-learning"
    after: "19244c1fbd3e2c980c606016437bb84109f0226fc51c4bb4dba72bb72a60c0a4"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The Session format remains V4. New events are informational and are appended with literal ignorable: true; omission does not change reconstructed model history. The coding-session-import source is framed quoted user context with source attribution, not a human command, permission, replay, or tool-routing grant. Existing source compatibility preserves unknown attribution kinds. The initializer uses the existing blocked dispatch barrier and a blank protected system head; its separate ownership receipt introduces no new turn-end variant. Coding handoff journal v2 is a distinct deployment format and refuses existing v1 units; its separately documented offline conversion is not performed here.

<a id="verification"></a>
## Verification

The final mock-only feature selection passed 1,422 tests across 84 files, including actual Loader imports, exact immutable captured-event admission, linked transactions, cancellation, sequential learning, bounded maintenance, native observation parsers, Core lifecycle markers and client/SDK transport fixtures. Final strict Host and Client types, whole-repository lint and production builds passed. All eight composed browser scenarios passed. The two-turn TypeScript SDK fixture passed actual recording and replay; the existing recorded native-item projection passed refresh and replay with 25 other cases filtered out. Both native-item and linked-context Python projections passed actual recording and replay against the freshly packaged Mac ARM carrier, then passed from the exact fresh SDK/runtime wheels in an isolated noneditable environment with Python -I and no PYTHONPATH. These overlapping checks are not added together. Fixtures cover complete UTF-8 byte preflight, stable ownership after edited timestamps, exact source and destination revisions, write-ahead recovery, cancellation and append-only rollback. Full GUI verification reported 10,131 passed, two retained baseline branding failures and one skipped test. No real model call, original native-session acceptance, credential change, live install or actual user-skill cleanup is included; runtime initialization and native metadata projection do not establish native Skill usage or task correctness.

<a id="dev-note"></a>
## Dev Note

None.
