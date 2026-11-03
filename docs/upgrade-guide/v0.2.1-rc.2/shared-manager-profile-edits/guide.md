---
kind: upgrade-guide
description: "Shared manager profile edits are temporarily unavailable until authorization and Bot-row persistence can commit atomically."
---

# Shared manager profile edits are disabled

## Change

The collaborator-only `bots/share/manage-profile` endpoint is no longer mounted. A shared owner or manager cannot rename or change the identity or accent of an operator-owned Bot through the shared route. The browser `SharedBotsClient` no longer exposes `manageProfile` or `SharedBotProfileUpdate`. Local operator Bot management remains available. The endpoint is withheld because its authority record and Bot roster row are separate durable stores and cannot yet provide one crash-atomic authorization transaction.

## Migration

1. Remove calls to `bots/share/manage-profile` from collaborator clients and remove any use of the former `SharedBotsClient.manageProfile` method or `SharedBotProfileUpdate` type. Use the operator-owned Bot service for profile changes.
2. Do not treat a `gateway/forbidden` response for that endpoint as a transient membership problem; the endpoint is intentionally unavailable in this release.
3. Confirm the deployed route list is derived from `SHARED_BOT_ENDPOINTS` and does not contain `bots/share/manage-profile`.
