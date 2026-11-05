---
kind: upgrade-guide
description: "Bot group and shared-message attachment uploads add new authenticated routes and an additive grant store."
---

# Bot group input attachments

## Change

Bot group and shared private messages can now carry image and verbatim-file references. Existing `agent_bots`, `agent_bot_groups`, and Session generations are unchanged. Hosts create the additive `agent_bot_input_attachments` domain and expose opaque message-scoped grants; old Hosts do not understand these routes or grants.

## Migration

1. Upgrade every Host that shares the same Bot storage and shared authority before enabling attachment UI or sending attachment grants. Do not copy attachment grant rows between Hosts.
2. Ensure the composition mounts the existing `attachments` provider. It owns byte validation, content-addressed storage, and streaming backpressure; the Bot service never persists filesystem paths.
3. Send image admission requests with an explicit `messageId`, then include the returned `grantId` in the matching group or private send. Use `/api/bots/group/uploadAttachment` for owner file streams and `/shared-bots/bots/share/uploadAttachment` for authenticated collaborator streams. Preserve the same message id when retrying an uncertain result.
4. Confirm the migration with `pnpm run typecheck`, the focused Bot attachment tests, and `pnpm run test:docs`. Existing V1 group snapshots and V5/V6 Session fixtures must remain byte-for-byte unchanged.
