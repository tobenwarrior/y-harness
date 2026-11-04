---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have active membership on every Bot in the group. The browser client exposes these operations.

Each group Bot receives a separate Session using the fixed `shared-bot` preset and a per-Session working directory. The Session receives the shared Bot identity prompt and no host tools. Group transcripts and delivery records live in the shared authority extension; owner-local rows and private Sessions are never used for a shared group. Authority revisions reserve transcript, delivery, and response capacity before any isolated Session call. Each recipient claims its pending delivery under the authority lock with an attempt token and expiring lease before dispatch; another Host observes an in-progress claim as retryable pending instead of reporting a duplicate or dispatching the same row. The claim rechecks the sender's active authority principal and every Bot membership, and its lease is renewed while recipient dispatch is in flight. Before enqueue and flush, the recipient Host writes a per-Session/message admission fence. The fence is non-expiring while that operation is uncertain, so a timeout or late flush cannot reuse the token; the Session log is reconciled before the fence is released or the receipt is accepted. An unresolved fence remains retryable busy rather than risking a duplicate. Accepted and responded rows are terminal, so a late failure cannot overwrite them, and roster removal atomically fails pending or accepted rows and clears their response reservations. The recipient ledger keeps at most 4,096 identities and scans the bounded ledger to prune only accepted rows whose shared-group source and isolated Session metadata are proven, including retired Sessions without a live binding; unproven rows remain protected. Startup replays pending rows in bounded, concurrent batches with bounded authority operations and fair pagination past rows scheduled for backoff. Failed rows are not recovered without a new send that recreates the reservation. A revoke cannot erase a message or transcript admitted on another Host, and a response that arrives after transcript capacity is exhausted is recorded as a delivery failure instead of extending the snapshot.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed durable delivery rows can resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after a transport failure.
4. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
