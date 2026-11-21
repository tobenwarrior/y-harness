---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-20-bot-routine-test

English

## Summary

Records an explicit routine test reservation and labels its invocation in the saved schedule message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-bot-routine-test
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-03-session-format-v6"
    after: "f02c80dac78a5a2f4a1772292f8f4fef93a5096666092a0f8a6a0bb7bbbed349"
    decision: same-version
  - root: "event:bot/routine-test"
    previous: null
    after: "bec6a74cfc6886699dc861d70957d4954f1612b21b1b5ee686e5d1237ebd929c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-03-session-format-v6"
    after: "40923f8628311717a6e7f8130af5b2df2c0d74ff01551d38d70647f6d2d6505d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-03-session-format-v6"
    after: "25ed3759effa86b73bf4377c8c1b280095355e4621a698c74f4dbe94c8c55a10"
    decision: same-version
  - root: "event:skill/learning-request"
    previous: "2026-11-03-session-format-v6"
    after: "c333ee88742fa2cd12410130cbe025fcced5f58c85497b16b5be8afd2b85b814"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-03-session-format-v6"
    after: "587e45a7b9adbfb1a8db078752b90bb96650b45bb4d1bbc5d681b22db5a08143"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

This build still reads earlier Session logs. A routine test reservation is required to reconcile a retry with the original attempt. The invocation field is optional on schedule messages.

<a id="verification"></a>
## Verification

The Bot Host tests exercise a paused routine, repeated requests, interrupted admissions, and result recovery after reopening the Session.

<a id="dev-note"></a>
## Dev Note

None.
