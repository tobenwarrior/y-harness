---
description: "Browser-host wire layer for the web GUI: Remote RPC, event-stream delivery with reconnect, exact Fetch routes, the /api HTTP bridge, and the browser-trust fence."
kind: "package-reference"
---

# @yharness/client-connection

## Summary

The package carries browser-to-Host Remote calls, exact Fetch responses, and connection generations. The Client plugin mounts `ctx.connection` with current-page loopback state, generic RPC, the active generation and its Host facts, observable recovery state, an immediate reconnect command, and the registration point for one generation source. A generation becomes visible when its source reports ready; source completion, failure, withdrawal, or an explicit stop clears it before `ConnectionController` applies its retry policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Browser authentication and request trust](#browser-authentication-and-request-trust)
- [Self-hosted shared-Bot access](#self-hosted-shared-bot-access)
- [Connection generation](#connection-generation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A static desktop page can provide `__DSH_TRANSPORT__.streamBaseUrl` for the HTTP origin of its owned Host. The Gateway uses that origin for its WebSocket while HTTP transport remains independently selected. The desktop carrier owns authentication; setting the origin alone grants no access.

Unary RPC requests use JSON. A Host handler may return byte attachments that it has already separated from the JSON-compatible result value, with each attachment naming its result-relative path. Connection writes these values as multipart parts. The JSON `metadata` part contains the RPC response envelope with `null` placeholders and an attachment table recording each path, codec, and part identifier. Paths use string keys and numeric array indices; no business field name is reserved. The Client validates the envelope, `rpcId`, attachment table, and parts, then restores each byte value as an `ArrayBuffer`-backed view. Results without attachments, including base64 strings, and failures remain JSON. Logical RPC carriers return decoded native values directly. Connection does not discover binary fields or depend on Typert; the handler that owns a result protocol performs any type-directed or runtime projection before returning. Binary parameters, events, and streamed binary results are unsupported.

The browser uses HTTP POST for Remote unary calls. API Gateway owns the `/api/remote.mux` WebSocket and its logical streams; shell-owned compositions provide equivalent Remote streams, including a stream's uplink, through `connection.rpc.open` without opening a WebSocket. The browser plugin reads the page transport, recovery settings, and location, then delegates to `installConnection(ctx, options)`. A composition that owns its carrier may call the same installer directly; the whole-client test tier does so. Each invocation creates one Context-owned service, so several Client trees can use different carriers in one realm. The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. When a Web carrier is present it also owns the sole `/api` route, Fetch bridge, browser authentication, and Host/Origin checks; a shell-owned carrier dispatches the shared Fetch handler directly. Each exact route declares buffered or streaming request-body handling before the bridge reads any bytes. Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and unclaimed requests return 404. Loopback hostname classification remains package-internal to the browser-facing Client state. Browser raw-body transfer is provided by [`dsh-client-file-upload`](../file-upload/README.md).

-----

RPC and shared routes follow the web server lifecycle: registrations can be made before the server is available, and are removed with their owning plugin.

<a id="browser-authentication-and-request-trust"></a>
## Browser authentication and request trust

Every Host RPC method and WebSocket stream requires one browser session; there is no method-specific loopback tier. Each process mints a random launch token. `dsh-web-app` prints and opens its application URL with `?token=...`, preserving the caller's authority and mount; `frontend-static` delegates root and index requests to `ctx.connection.authorizeIndex`, which accepts that token only on `GET /`, writes an authority-bound signed cookie, and redirects to clean `./`, which drops the token and keeps the request's directory. A missing, expired, malformed, or wrong-authority cookie returns 401 before RPC dispatch. Static assets remain public. The HTTP carrier accepts no query token outside the root exchange and no Authorization-header token.

The cookie signing secret is the owner-scoped `client-connection/browser-session` grant record in `ctx.credentials`. The local provider persists it in `$DSH_HOME/.credentials.yaml`; `BrowserAuth` loads or creates the record during Connection activation and retains the secret in memory, so request authentication is synchronous. Deleting or replacing the record takes effect on the next Connection activation. Cookies carry an absolute issue/expiry interval, defaulting to 30 days through `cookieMaxAgeDays`, and bind the normalized hostname plus port in both their deterministic name and signed payload. They are host-only, `Path=/`, `HttpOnly`, and `SameSite=Strict`; they deliberately omit `Secure` because the shipped server uses loopback HTTP.

Before authentication, every request still passes `src/api-request-trust.ts`. Its `Host` must be loopback or match a `trustedHosts` entry: exact on `host:port`, any port on port-less entries, both sides WHATWG-normalized. An attached `Origin` must equal that Host and `sec-fetch-site: cross-site` is refused. Malformed configured authorities fail plugin load. These checks defend DNS rebinding and cross-site browser requests; they never establish identity. A failed Host/Origin check returns 403, while a trusted but unauthenticated request returns 401. `dsh web --host 0.0.0.0` remains unsupported. Decision records: [browser request trust](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md) and [browser token authentication](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md).

Every admitted request speaks for one Peer, the operator. `ctx.connection.operator` is that `PeerScope`: its `ctx` is a Cordis scope that owns connection-lifetime registrations and is disposed with the Connection. `ctx.connection.admit(request)` runs the trust and authentication checks and answers with the rejection status or the operator; the `/api` route and the Gateway's WebSocket upgrade admit through it, and every RPC handler receives the Peer of its call. `OperatorPeer` is exported so a composition without Connection, such as the Gateway's in-process carrier, owns an operator scope with the same contract.

Authenticated shared HTTP requests pass through the `connection/request` waterfall before body transfer. A listener may refuse new requests or await `next()` through response completion; removing its owning fiber removes admission behavior. Desktop uses this hook to lock new API work during an approved installation without canceling already-admitted work. Client disconnection aborts the handler signal; the bridge stops socket writes and drains any remaining response chunks. WebSocket stream ownership remains with API Gateway.

<a id="self-hosted-shared-bot-access"></a>
## Self-hosted shared-Bot access

`SharedAccessAuthority` provides a separate, self-hosted collaborator identity flow. An owner creates a one-time invite, the recipient redeems it once, and the authority stores the signing key, principal, invite digest, bounded non-secret association metadata, and session records in the owner-scoped `client-connection/shared-access` credential record. A valid collaborator cookie becomes a `SharedAccessPeer` carrying one principal id and the `shared-bots` audience; it never becomes the operator Peer. Admission reloads the credential record transactionally, so invite consumption and revocation remain single-use across authority instances.

Host-only extension consumers that correlate durable records use `mutateExtensions(keys, mutation)` so the selected extension reads and writes share the same exclusive authority transaction; a callback returns the next map for selected keys and treats an omitted or `undefined` value as deletion.

Admission and other read checks that must not write use `readLockedExtensions(keys, reader)`. Its synchronous reader receives only the selected extension values and the current principal snapshot while the credential record lock is held, so a concurrent revocation is ordered before the decision. The reader result is returned to the caller, but the credential mutation always returns `undefined`; reader, credential, and post-read refresh failures propagate without persisting an extension change.

When the reader starts an external action after authorizing it, use `readLockedExtensionsForActionStart(keys, reader)`. It has the same lock ordering and no-write semantics, but treats provider and post-read refresh failures after a successful reader as best-effort housekeeping so the already-started action is not reported as rejected. Callers must not use this action-start method for ordinary list or read paths.

`ctx.connection.sharedRpc.enroll('/shared-bots', handler)` registers the exact trust-fenced `POST /shared-bots/bots/share/enroll` route. The enrollment handler receives the request authority so a cookie can be bound to the exact Host and port; the resulting HttpOnly cookie is returned in `Set-Cookie`, while the bearer value is omitted from the JSON body. Normal invite redemption does not accept an operator cookie or ordinary Remote method; a Bot service may separately accept an operator-admitted owner-bootstrap or capability request on this route. `ctx.connection.sharedRpc.handle('/shared-bots', authority, handler, { endpoints: ['bots/share/session', 'bots/share/list', 'bots/share/chat'] })` registers the collaborator-only RPC path. The route applies the Host/Origin fence, collaborator cookie authentication, and the configured request-body limit, then passes the admitted Peer to the handler; only the exact endpoint names declared at registration are reachable, and handler failures return a generic internal error. `bots/share/session` returns only the authenticated principal id and its absolute session expiry, so a browser can restore retry partitioning after a reload without receiving a credential. Shared routes default to a 128 KiB body cap, two concurrently buffered body reads, a 30-second body-read timeout, and eight in-flight handler requests per registration; deployments may lower these limits but cannot raise them. Body admission is separate from handler admission, so a slow authenticated upload cannot consume a handler slot; an incomplete body receives 408 and a saturated body-read or handler pool receives 429. The existing `/api` route and all ordinary Remote APIs continue to require the operator browser cookie. WebSocket features must provide a positive `maxInboundBytes` option; the transport destroys a collaborator socket after that aggregate inbound limit and binds it to the admitted Peer so revocation closes it. Revocation aborts the admitted Peer's signal; shared handlers must pass it through to active work.

The shared handler must derive private conversation sessions from the admitted principal and Bot id, not from client-supplied principal or Session ids. One deployment should mount one authority against one credential provider; authorities in the same process share the durable state and close their active Peer scopes when another instance revokes a principal. Other processes observe the revocation on their next admission, but cannot close an already-upgraded socket without a deployment-level coordination channel. The collaborator invite flow is local self-hosted enrollment rather than federated account login; the operator owner-bootstrap path still requires ordinary Connection authentication. Deployments that need account recovery or multi-device identity must layer an external identity provider above it. Cookies default to loopback-compatible HTTP attributes; network deployments must provide the same `trustedHosts` authorities to `SharedAccessAuthority`, use TLS, and set `secureCookie: true`; otherwise direct collaborator admission fails closed.

The Bot owner-bootstrap payload uses this same trust-fenced enrollment route but is accepted only after the Bot service calls `ctx.connection.admit(request)`. It binds the browser to one authority-owned durable owner principal; ordinary invite redemption remains available for collaborators and never accepts a browser-supplied principal.

<a id="connection-generation"></a>
## Connection generation

API Gateway Client registers the internal `$events` logical stream as the sole generation source, independently of whether any `$on` listener exists. The Host attaches all incremental listeners in the API Remotes source factory, then sends one `{ type: 'ready', clientId, host: { home } }` item before events. `ConnectionController` publishes that generation and calls `onConnected` only after the ready item arrives, so baseline acquisition cannot race ahead of incremental observation.

An ended `$events` stream, a Remote stream error, a non-ready opening item, or a malformed event item invalidates the current generation. A pending handshake logs a slow-Host warning after 3 seconds and logs the readiness timeout and aborts after 15 seconds by default, including time spent waiting for the physical socket. The source must stop delivery, release resources, and settle after cancellation before a replacement starts; late readiness from a cancelled source cannot publish a generation. While the browser reports network availability, the controller publishes `connecting` and retries with 50%–100% jitter under caps of 500ms, 1s, 2s, 4s, 8s, and 10s, continuing at the final cap until recovery. Every retry asks Gateway to replace the physical WebSocket once and reopens `$events`.

`ctx.connection.reconnect()` interrupts active work, resets the sequence, and starts retry 1 immediately. Browser `offline` aborts active work, publishes `disconnected`, and suspends automatic attempts; the next `online` transition resets the sequence and starts at the 500ms tier. Only a ready item publishes `connected`. Gateway mux owns no independent retry schedule.

Set the Host Connection row's `config.recovery` to override retry caps, the growth factor, or handshake warning and cancellation times; the [configuration catalog](../../../docs/config-catalog.md#yharnessclient-connection) lists accepted fields. The Host validates these values and injects them into each served page. The Client validates the bootstrap data before providing Connection and uses those defaults when Gateway starts its loop; explicit `start()` timing overrides take precedence. The growth factor must be finite and at least one. Readiness, failure, cancellation, or a hard deadline that occurs before the warning cancels that warning. Reload the page after changing Host recovery configuration.

<a id="model-experience"></a>
## Model Experience

None, as the wire consumer layer moves already-composed messages between browser and host; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Buffered `/api` routes retain each request body in memory** — `maxRequestBodyBytes` (default 300 MiB, sized for the default 200 MiB aggregate image limit after base64 expansion plus envelope headroom) bounds ordinary image and RPC envelopes. Opt-in streaming routes receive backpressured chunks and bypass the aggregate cap; route implementations own persistence, cancellation, and any storage quota.
- **The browser cookie is not marked `Secure`** — loopback HTTP is the shipped transport, so exposing the same authority over plaintext networking can expose the bearer cookie in transit.
- **There is no logout operation** — clearing the browser cookie ends one browser session; deleting the owner credential record and restarting `dsh` revokes every session.
- **Shared WebSocket ownership is transport-level** — Connection enforces WebSocket frame and aggregate byte limits and closes revoked peers, but the protocol owner still defines message semantics and application-level flow control.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
