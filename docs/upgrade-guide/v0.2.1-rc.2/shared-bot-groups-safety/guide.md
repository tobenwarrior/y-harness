---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have active membership on every Bot in the group. The browser client exposes these operations.

Each group Bot receives a separate `shared-bot` Session in a per-Session working directory; shared transcripts and delivery records never use owner-local Sessions or group rows. On startup, the Host replaces legacy private `system/message` history with the public projection under an open step or fresh valid maintenance turn, then flushes before model access; a failed flush leaves a dirty marker and keeps admission fenced until retry. While pending, only the marked agent-loop request or an audited session-title or skill-learning envelope with no tools can cross the LLM boundary, and ambient calls need the exact shared Session initiator. A missing Bot row remains fenced, not a marker-only shared Session. Recipient admission holds an exclusive lock in that Session directory across follow-up, flush, and receipt commit. Shared-group admissions disable PID-based lock takeover because a shared filesystem may use different PID namespaces; they fail closed when a sidecar remains. A fence whose Session log cannot prove delivery returns `recovery: 'operator-required'`, is durably marked failed, and is not retried indefinitely. To recover one, an owner must quiesce every Host that could own it, then call `recoverSharedGroupDelivery` with `confirmQuiescent: true`, the exact `groupId`, `botId`, `sessionId`, and `messageId`. `confirmQuiescent` is only an owner assertion, not a probe or verified fact, so a false assertion can race a live admission. The action removes only that sidecar, acquires a fresh lock without PID takeover, re-inspects the Session, and either records acceptance or releases the fence for the same message-id retry. Racing Hosts return busy/operator-required. This action needs no in-memory takeover proof and cannot revoke imported copies offline. Authority revisions, ACLs, terminal rows, bounded ledger pruning, and startup recovery remain durable across Hosts.

If a shared-group admission leaves the owner profile fence retained, the owner-only `inspectSharedRosterFence` route returns its opaque token. After stopping every Host that could still own the admission, the owner may call `recoverSharedRosterFence` with that token, `confirmQuiescent: true`, and `acceptRaceRisk: true`. The UI requires both acknowledgements because a paused or partitioned Host cannot be disproven; there is no heartbeat, clock, PID, or timeout-based release. Recovery performs an exact-token compare-and-clear under the credential-provider write lock, but a false quiescence assertion can race a live Host; inspect the durable group state and retry the idempotent operation as needed.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed durable delivery rows can resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after a transport failure.
4. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
