---
kind: upgrade-guide
description: "Coding-session ownership journals use version 2 and refuse version-1 data and predecessor readers."
---

# Coding-session ownership journal

English | [中文](guide.zh.md)

## Change

The `coding_session_handoffs` ownership journal uses version 2 to retain restart recovery checkpoints and unresolved native admissions. Existing version-1 journals refuse activation. Predecessor readers refuse version-2 journals rather than discard recovery fields. Native histories and the separate `coding_sessions` mirror domain retain their existing formats.

## Migration

1. Stop every Host using the selected storage backend before upgrading. A fresh storage backend has no journal to convert; its first ownership write creates version 2.
2. For an existing JSON backend, retain the exact `coding_session_handoffs.json` file and its digest as a backup. For other backends, preserve the complete `coding_session_handoffs` unit. Do not delete the unit or open a replacement empty journal to bypass refusal.
3. Existing version-1 data needs a separately reviewed offline conversion preserving every ownership marker and all existing fields. Validate the complete source unit, exact version, marker identities and byte/count limits, and require the unchanged input digest before publication. There is no automatic conversion or supported downgrade; do not change the stamp blindly. See the [ownership package](../../../../packages/session/coding-session/README.md#known-limitations-and-deferred-work).
4. Confirm the converted unit opens under the current ownership schema without losing marker counts, owner tokens or unresolved admissions. Startup must refuse malformed data or a mismatched version.
5. Preserve the version-2 journal when reverting code. The old reader must fail closed. Restoring a pre-upgrade backup after later admissions would lose new uncertainty and is not a supported rollback.
