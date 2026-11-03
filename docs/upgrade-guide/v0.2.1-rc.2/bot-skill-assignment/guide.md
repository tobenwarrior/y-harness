---
kind: upgrade-guide
description: "Bots can persist a Host-local skill discovery policy and expose it through the Bot workspace."
---

# Bot skill assignment

## Change

Bot records gain an optional `skillPolicy` field and a monotonic `skillPolicyRevision`. Legacy rows default to `mode: "all"` and revision `0`; `listSkills` and `updateSkills` expose an empty catalog when the local skill registry is not mounted. The Bot-scoped provider filters both model and user skill discovery before loading denied bodies, then rechecks the current policy after asynchronous loads; the existing `skill-catalog` and `skill-invocation` Session sources remain the durable record of model-visible skill inputs.

The Client exposes the policy editor only when both skill Remote methods are supplied. Each replacement sends the revision returned by the latest catalog read; a stale replacement fails with a conflict and the editor requires a reload before another save. Assignments are Host-local and are not included in portable Bot templates, and changing a policy does not revoke a body already included in a completed model request or alter another Host's Bot copy.

## Migration

1. Upgrade the Bot Host and Client together. Ensure the `@yharness/skill` peer/dev dependency is installed, and mount its registry when local skill discovery is wanted; a Host that does not mount the registry returns an empty Bot skill catalog.
2. Keep existing `agent_bots` records in place. Domain version 7 accepts versions 1 through 6 and treats an omitted `skillPolicy` as all available skills with revision `0`; no manual rewrite is required.
3. If a Client composition supplies a custom Bot panel, pass `skillManager` only when both Remote methods are mounted. Keep the UI copy locale-owned and show metadata only; do not send skill bodies, paths, provider handles, credentials, or local ids to the browser.
4. Test one Bot in all mode, then selected mode with a denied skill. Confirm the denied skill is absent from model/user invocation paths, a delayed load is discarded after revocation, stale policy writes report a conflict, and a restart preserves the canonical policy and revision.
