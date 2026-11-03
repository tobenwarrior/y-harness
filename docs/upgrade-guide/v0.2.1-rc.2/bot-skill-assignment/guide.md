---
kind: upgrade-guide
description: "Bots can persist a Host-local skill discovery policy and expose it through the Bot workspace."
---

# Bot skill assignment

## Change

Bot records gain an optional `skillPolicy` field. Legacy rows default to `mode: "all"`; `listSkills` and `updateSkills` expose an empty catalog when the local skill registry is not mounted. The Bot-scoped provider filters both model and user skill discovery before loading denied bodies, while the existing `skill-catalog` and `skill-invocation` Session sources remain the durable record of model-visible skill inputs.

The Client exposes the policy editor only when both skill Remote methods are supplied. Assignments are Host-local and are not included in portable Bot templates, and changing a policy does not revoke a body already included in a completed model request or alter another Host's Bot copy.

## Migration

1. Upgrade the Bot Host and Client together. Ensure the `@yharness/skill` peer/dev dependency is installed, and mount its registry when local skill discovery is wanted; a Host that does not mount the registry returns an empty Bot skill catalog.
2. Keep existing `agent_bots` records in place. Domain version 6 accepts versions 1 through 5 and treats an omitted `skillPolicy` as all available skills; no manual rewrite is required.
3. If a Client composition supplies a custom Bot panel, pass `skillManager` only when both Remote methods are mounted. Keep the UI copy locale-owned and show metadata only; do not send skill bodies, paths, provider handles, credentials, or local ids to the browser.
4. Test one Bot in all mode, then selected mode with a denied skill. Confirm the denied skill is absent from model/user invocation paths and that a restart preserves the canonical policy.
