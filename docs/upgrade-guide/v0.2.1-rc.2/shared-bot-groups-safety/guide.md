---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have an active membership on every Bot in the group. The browser `SharedBotsClient` exposes the group operations.

Each group Bot receives a separate durable Session using the fixed `shared-bot` preset and a per-Session working directory. The Session receives only the shared Bot identity prompt and no host tools. Group transcripts and delivery records live in the shared authority extension; owner-local group rows, private Bot Sessions, and their history are never used for a shared group. Authority revisions serialize ACL changes with message admission. A revoke blocks later operations but cannot erase a message or transcript already admitted on another Host.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
