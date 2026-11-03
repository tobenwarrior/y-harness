---
kind: upgrade-guide
description: "Bot template share codes change from Host-local identifiers to signed portable snapshots with owner-scoped publication and explicit recipient approval."
---

# Portable Bot template codes

## Change

`@yharness/bots` now publishes `yhbot-template-v2.` signed artifacts containing the safe profile, persona, declared capabilities, optional avatar bytes, and Agent preset. The previous `bot-template-<uuid>` values remain readable as stored rows but are not valid preview or import artifacts. Publication requires the configured `ownerId` to own the source Bot. A recipient can preview a valid copied artifact, but must explicitly approve its exact fingerprint and the target Host's resolved preset and tool view before import; approval and import fail with `bot-template/permissions-unavailable` when that local view cannot be resolved, and any change requires approval again. This is a Host-local trust decision for the embedded preset and profile, not a claim that the self-asserted signing-key fingerprint identifies its publisher. Revocation blocks new imports on that Host only; an already copied artifact or imported Bot is independent. `importTemplate` accepts an optional `importId` for retry-safe provisioning, but every retry and direct call rechecks the current approval binding before returning an existing Bot.

## Migration

1. After upgrading, list existing templates through `listTemplates` and republish any row whose `shareCode` does not begin with `yhbot-template-v2.`; distribute the new code instead of the old local identifier.
2. If a composition uses `BotTemplateView`, keep the existing flat fields and optionally render `persona`, `capabilities`, `profile`, `avatar`, `fingerprint`, and `portableVersion` from `packages/agents/bots/src/template-types.ts`.
3. For callers that retry an uncertain import, pass a stable caller operation key as `BotTemplateImportRequest.importId`. Reusing the key with different code or metadata returns `bot-template/import-conflict`; omitting it preserves one-new-Bot-per-call behavior.
4. Set `ownerId` in the `@yharness/bots` composition when one Host serves multiple owner scopes. Existing Bot rows without an owner field are read as `local-owner`; confirm that each configured owner publishes, lists, and revokes only its own locally owned rows, while a recipient can preview and then explicitly approve a valid copied signed code without the source row.
5. After upgrading, reapprove copied artifacts whose prior Host-local approval did not record the resolved preset and tool view. Approval is fail-closed when the signed preset or configured default cannot resolve; if the preset or effective tool names change, preview and approve the artifact again before importing or retrying it.
