---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have active membership on every Bot in the group. The browser client exposes these operations.

Each group Bot receives a separate `shared-bot` Session in a per-Session working directory; shared transcripts and delivery records never use owner-local Sessions or group rows. Recipient admission now holds an exclusive lock in that Session directory across follow-up, flush, and receipt commit. Shared-group admissions disable PID-based lock takeover because a shared filesystem may be mounted by Hosts with different PID namespaces; they fail closed when a sidecar remains. A fence whose recipient Session log cannot prove delivery returns `recovery: 'operator-required'`, is durably marked failed in the shared-group transcript, and is not retried indefinitely. To recover one, an owner must quiesce every Host that could own the exact Session, then call `recoverSharedGroupDelivery` with `confirmQuiescent: true`, the exact `groupId`, `botId`, `sessionId`, and `messageId`. `confirmQuiescent` is only an owner assertion, not a probe or verified fact, so a false assertion can race a live admission. The action removes only that sidecar, acquires a fresh lock without PID takeover, re-inspects the Session, and either records acceptance or releases the fence for the same message-id retry. A racing Host returns a busy/operator-required result. This fresh-Host action does not rely on an in-memory takeover proof and never claims that an imported copy can be revoked offline. Authority revisions, ACL checks, terminal delivery rows, bounded ledger pruning, and startup recovery remain durable and cross-Host as described in the package reference.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed durable delivery rows can resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after a transport failure.
4. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
