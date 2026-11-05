---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/*` endpoints now use credential-backed shared authority. Each group has an owner/member ACL and one-time invitation; every principal must also have active membership on every group Bot.

Each group Bot receives a separate `shared-bot` Session; shared records never use owner-local Sessions or group rows. On startup, the Host replaces legacy private `system/message` history with the public projection under an open or fresh valid maintenance turn, then flushes before model access; a failed flush leaves a dirty marker and fences admission until retry. Only the marked agent-loop request or audited no-tool session-title/skill-learning envelope may cross the LLM boundary while pending; ambient calls need the exact shared Session initiator. A missing Bot row remains fenced, not a marker-only shared Session. Recipient admission holds an exclusive Session-directory lock through follow-up, flush, and receipt commit. Shared-group admissions disable PID-based takeover across PID namespaces and fail closed when a sidecar remains. A fence whose Session log cannot prove delivery returns `recovery: 'operator-required'`, is durably marked failed, and is not retried indefinitely. To recover one, an owner must quiesce every Host that could own it, manually migrate any legacy PID sidecar without replacing a live lock pathname, then call `recoverSharedGroupDelivery` with `confirmQuiescent: true`, the exact `groupId`, `botId`, `sessionId`, and `messageId`. This is an owner assertion, not a probe; a false assertion can race a live admission. Recovery never removes or replaces a lock pathname or inode, re-inspects the Session, and records acceptance or releases the same message-id fence for retry. Racing Hosts return busy/operator-required. Authority revisions, ACLs, and recovery state persist across Hosts.

If admission leaves an owner profile fence, `inspectSharedRosterFence` returns its token; after stopping every possible owner Host, call `recoverSharedRosterFence` with token, `confirmQuiescent: true`, and `acceptRaceRisk: true`. The UI requires both acknowledgements because a paused or partitioned Host cannot be disproven; no heartbeat, clock, PID, or timeout releases it. Recovery performs an exact-token compare-and-clear under the credential-provider write lock, but a false quiescence assertion can race a live Host; inspect durable group state and retry the idempotent operation as needed.

The owner Bot sharing dialog exposes the exact identities needed to recover recipient fences without exposing transcripts or admission tokens. See the [Bot package reference](../../../../packages/agents/bots/README.md) for the recovery requirements.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue an invitation only after the recipient has active shared-Bot membership on every group Bot; redeeming it does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed delivery rows resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after transport failure.
4. Treat `gateway/forbidden` after revocation as durable. Revocation is Host-local and linearizable for new admissions; it cannot recall imported or persisted copies on another Host.
