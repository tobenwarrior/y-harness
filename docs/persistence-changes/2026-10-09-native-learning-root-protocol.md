---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-native-learning-root-protocol

English | [中文](2026-10-09-native-learning-root-protocol.zh.md)

## Summary

Two new ignorable Session events retain bounded native evidence without changing Session format V4. skill/native-item stores provider-specific original identities, sanitized action metadata and optional safe procedure facts. claude-code/root-protocol separately stores bounded owned Claude root inputs, system text and public context frames, including native home and configuration path metadata.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-native-learning-root-protocol
baseline: false
changes:
  - root: "event:claude-code/root-protocol"
    previous: null
    after: "77e2c680b972fb40016c720849e5bea44b970eb828e1d67d64559d399483b903"
    decision: same-version
  - root: "event:skill/native-item"
    previous: null
    after: "3a2827d5603d94826b4c2bb9cebc12487b388f6e085ff8171254982f326695c6"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Codex native evidence keeps the same serialized provider/connection/session/turn/item fields; new opaque types are branded at validated SDK/JSON boundaries. Claude evidence uses sendId and actual sourceMessageId/resultMessageId rather than an invented turnId. The new protocol event has no model conversation or surface projection and older ignorable-event readers may omit it. The default plugin remains child-only unless rootRoute is explicitly configured. Public SDK records do not restore hidden native prompts, tool schemas or private state. This ephemeral root route does not support restart, external CLI continuation or alternating native writers. A separately chosen sequential handoff of an existing native session would need its own adapter and acceptance evidence; it is not implemented by these events. This acknowledgement covers only these two new Session event roots. Managed maintenance and coding mirrors use independent storage domains; separate Decision settings do not introduce a Session root. Neither public evidence nor a tool observation verifies task completion or complete native usage.

<a id="verification"></a>
## Verification

The final integrated fixture-only selection passed 499 tests across 37 files after the lint fixes. Production Loader, AgentLoop, Session JSONL and SkillLibrary execute normally; the new route suites mock external SDK transport, native subprocess and enforcement boundaries with fixture-owned profile environment and paths. An overlapping broader run passed 507 tests across 38 files, including eight existing tests that drive the installed Claude SDK/CLI against a local fake Messages server in temporary homes with a dummy key; those tests make no remote model call and do not read original native profiles. Built TypeScript SDK projection passed its selected replay (one test passed; 25 unrelated selections skipped), and the packaged macOS Python carrier projection passed replay. The same mocked projection passed from matching, non-editable SDK and runtime wheels in an isolated virtual environment outside the repository. Each projection also failed an intentional wrong-original-identity negative control and restored its exact expected bytes afterward. All five composed browser acceptance scenarios passed against the built production UI and fixture-only backend. Counts overlap and are not additive. Neither projections nor browser acceptance establish native successful usage, hidden context continuity or model quality. No real model call, original native session/history read, authentication operation or user-skill maintenance was run.

<a id="dev-note"></a>
## Dev Note

None.
