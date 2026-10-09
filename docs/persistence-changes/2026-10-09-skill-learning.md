---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-skill-learning

English | [中文](2026-10-09-skill-learning.zh.md)

## Summary

Adds log-only bounded skill-learning request and response records, attribution for auxiliary learning messages, and optional relevance metadata on skill catalogs. Auxiliary request traces preserve optional captured reasoning effort and processing tier.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-skill-learning
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "6e2b0679c9c08e55de27dd42f102f86f9ded9315a22e3a6770c33b4e050e8614"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "00f73361fda4c2b07a3deb9c81c9aea7f2908a8c35b05a374720314ebc1c88c9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "65932af36f8385707da4033898ed6e5147c98407a29a71f3eb8cf16196fcd684"
    decision: same-version
  - root: "event:skill/learning-request"
    previous: null
    after: "21fe393b993d059b929b8738f700cf96c09611592c764d51086ee66ddd4c1401"
    decision: same-version
  - root: "event:skill/learning-response"
    previous: null
    after: "a3418efc158ae910f0469136bd4dabd29ef047795949199f900831199e132b87"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "9ba9ddf329039aa14c79eff48acf0160fff7e25a38cfb4ffc8ed496ca75afd2c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. Learning traces are appended with ignorable: true and never enter the conversation surface or task replay. The skill-learning source kind supplies attribution only; readers preserve user and developer messages without this producer. Existing skill catalogs may omit every relevance field. No existing value type, event envelope, header, or writer version changes, and no adjacent migration is required. Captured effort and tier remain optional for existing trace records; absent controls never imply a verified default.

<a id="verification"></a>
## Verification

The isolated mock and fixture run of core Session, skill library/runtime, skill registry/filesystem/tools, Skills/account UI and LLM metadata tests passed 1,276 tests across 62 files. The archive-reference and interrupted-review regression run passed 27 tests after reproducing three failures. The persistence preview classifies only optional catalog properties, attribution-only source additions, and two new event roots, with no required version increase. No live model or user-skill operation was exercised. The response-only admission and captured-control correction passed 170 mocked tests across four LLM/learning suites after reproducing six admission/control failures and three evidence-route failures. No real provider or native process was invoked.

<a id="dev-note"></a>
## Dev Note

None.
