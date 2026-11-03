---
kind: upgrade-guide
description: "Shared Bot group traffic uses isolated Sessions and explicit durable group access grants."
---

# Shared Bot groups use isolated Sessions

## Change

The collaborator-only `bots/share/list-groups`, `bots/share/create-group`, `bots/share/update-group`, `bots/share/inspect-group`, `bots/share/send-group-message`, and `bots/share/manage-group-members` endpoints now use the credential-backed shared authority. A group has an explicit owner/member ACL and a one-time invitation; every principal must also have an active membership on every Bot in the group. The browser `SharedBotsClient` exposes the group operations.

Each group Bot receives a separate durable Session using the fixed `shared-bot` preset and a per-Session working directory. The Session receives only the shared Bot identity prompt and no host tools. Group transcripts and delivery records live in the shared authority extension; owner-local group rows, private Bot Sessions, and their history are never used for a shared group. Authority revisions reserve transcript, delivery, and response capacity before any isolated Session call. Each recipient claims its pending delivery under the authority lock with an attempt token and expiring lease before dispatch; another Host observes an in-progress claim as retryable pending instead of reporting a duplicate or dispatching the same row. The claim rechecks the sender's active authority principal and every Bot membership, and its lease is renewed while recipient enqueue and flush are in flight. The recipient Host also keeps a durable per-Session/message admission lease, and checks that token before enqueue and flush, so a host that loses admission fails closed. Accepted and responded rows are terminal, so a late failure cannot overwrite them, and roster removal atomically fails pending or accepted rows and clears their response reservations. The recipient ledger keeps at most 4,096 identities and prunes only accepted rows whose exact shared-group source is proven in the isolated Session log; unproven rows remain protected. A Host replays durable pending rows after restart in bounded batches and concurrency with bounded authority reads, claims, and dispatch timeout, and retries only an expired pending lease; failed rows are not recovered without a new send that recreates the reservation. A revoke cannot erase a message or transcript already admitted on another Host, and a response that arrives after transcript capacity is exhausted is recorded as a delivery failure instead of extending the snapshot.

## Migration

1. Deploy the Host and Client together so the route list and group client agree.
2. Issue a group invitation only after the recipient has active shared-Bot membership on every Bot in the group; redeeming the invitation does not grant Bot membership.
3. Retry a partial result with the same `messageId` so pending or failed durable delivery rows can resume while accepted or responded rows remain duplicates; the Client preserves that id and refreshes per-recipient outcomes after a transport failure.
4. Treat `gateway/forbidden` after revocation as a durable access decision. Revocation is Host-local and linearizable for new delivery admissions; it cannot recall an imported or already persisted copy on another Host.
