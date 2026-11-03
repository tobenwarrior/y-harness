---
kind: upgrade-guide
description: "Shared Bot group endpoints are withheld until group traffic has isolated Sessions and explicit durable access grants."
---

# Shared Bot groups are disabled

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, and `bots/share/send-group-message` endpoints are no longer mounted. The browser `SharedBotsClient` does not advertise shared-group operations, so the shared workspace hides that surface. Existing owner-local Bot groups and private shared-Bot Sessions are unchanged.

The shared group domain currently delivers messages through owner-local Bot Sessions and does not persist a per-group sharing grant. Keeping the endpoints available could disclose an owner-local transcript or inject collaborator traffic into an owner-visible Session. Requests sent directly to the removed endpoints receive `gateway/forbidden`.

## Migration

1. Remove shared-group endpoint calls and do not retry `gateway/forbidden` as a transient membership failure.
2. Use owner-local group operations until a later release provides isolated shared-group Sessions and explicit durable group invitations.
3. Confirm the deployed route list is derived from `SHARED_BOT_ENDPOINTS` and contains none of the removed group endpoints.
