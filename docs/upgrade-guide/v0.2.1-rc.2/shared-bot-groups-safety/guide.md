---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have active membership on every Bot in the group. The browser client exposes these operations.

Each group Bot receives a separate `shared-bot` Session in a per-Session working directory; shared transcripts and delivery records never use owner-local Sessions or group rows. Recipient admission now holds an exclusive lock in that Session directory across follow-up, flush, and receipt commit. A new Host may take over only when the lock utility proves the recorded owner process exited, then it re-inspects the Session and releases or retries the fence. This PID evidence is valid only when Hosts share the same filesystem and OS PID namespace; other deployments fail closed. Legacy fences with no valid lock evidence return `recovery: 'operator-required'`; the shared route reports a failed delivery and does not schedule an endless retry. To recover one, an operator stops all Hosts that could own the Session, verifies the lock PID is gone, removes only `${sharedBotWorkingDirectory(sessionId)}/.delivery-${encodeURIComponent(messageId)}.lock`, and retries the same message id through the deployment's recovery procedure. Authority revisions, ACL checks, terminal delivery rows, bounded ledger pruning, and startup recovery remain durable and cross-Host as described in the package reference.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed durable delivery rows can resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after a transport failure.
4. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
