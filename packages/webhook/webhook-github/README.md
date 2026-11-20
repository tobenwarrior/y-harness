---
description: "Signed GitHub webhook adapter for deployments routing authenticated JSON events into the webhook runtime."
kind: "package-reference"
---

# @yharness/webhook-github

## Summary

`dsh-webhook-github` registers one exact HTTP route on the injected `ctx.webServer`. It bounds and verifies GitHub's raw JSON body, and projects a provider-neutral delivery. The default route dispatches to the Webhook runtime. A route with `botRoutines: true` acknowledges after the Bot service reserves matching runs.

## Table of Contents

- [Configuration](#configuration)
- [HTTP contract](#http-contract)
- [Dedicated listener composition](#dedicated-listener-composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Meaning |
|---|---|
| `source` | Non-empty adapter instance carried to rules, such as `primary-github`. |
| `path` | Exact non-root pathname without trailing slash, query, or fragment. |
| `secretEnv` | Credential reference containing the GitHub webhook secret. |
| `maxBodyBytes` | Positive safe-integer ceiling for the untouched request body. |
| `botRoutines` | Route matching events to registered Bot routines. Defaults to `false`. |

The source, path, secret reference, and body limit are required. The secret reference is resolved for every request, so rotation affects the next delivery without reloading the plugin.

<a id="http-contract"></a>
## HTTP contract

Only `POST application/json` is accepted. The adapter reads a bounded UTF-8 body, requires `X-Hub-Signature-256`, `X-GitHub-Delivery`, and `X-GitHub-Event`, resolves the secret, verifies HMAC before JSON parsing, and requires a top-level lossless-JSON object. It never logs the secret, signature, or payload.

| Status | Meaning |
|---|---|
| `202` | Verified JSON was dispatched, or matching Bot runs were durably reserved. |
| `400` | Required header, UTF-8, JSON, or top-level object was invalid. |
| `401` | Signature was invalid. |
| `405` | Method was not `POST`. |
| `413` | Declared or streamed body exceeded `maxBodyBytes`. |
| `415` | Media type was not `application/json`. |
| `503` | Credential, dispatcher, or Bot admission was unavailable. |

Unmatched signed deliveries also return `202`. The rule or Bot service validates the GitHub event fields it consumes.

<a id="dedicated-listener-composition"></a>
## Dedicated listener composition

The normal Web profile already owns `ctx.webServer`. Mount another `dsh-host-webserver` and this adapter inside a group that isolates only `webServer`; the adapter still inherits credentials and `webhookRuntime`. The [GitHub review guide](../../../docs/user/guide/github-review.md) uses `127.0.0.1:3081/github` behind a TLS reverse proxy while the UI remains on port 3080.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the prompt supplied by the webhook rule or Bot routine.

#### KV Cache effect

Independent. Authentication and HTTP dispatch do not touch a model request; any new Session prefix belongs to the consuming rule and runtime.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No TLS** — the injected development WebServer is normally loopback-only behind a TLS reverse proxy or tunnel.
- **Generic payload validation only** — rules own validation of the GitHub event fields they consume.
- **Acknowledgement before completion** — a reserved Bot run can still be pending when the adapter answers.
- **No form encoding** — GitHub must send `application/json`; `application/x-www-form-urlencoded` is rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
