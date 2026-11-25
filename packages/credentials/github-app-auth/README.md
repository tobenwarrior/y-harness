---
description: "Host-only GitHub App device authorization for the GitHub MCP server. Tokens stay in the credential provider and never cross into client state or logs."
kind: "package-reference"
---

# @yharness/github-app-auth

## Summary

`@yharness/github-app-auth` owns the Host-side GitHub App device flow used by the official GitHub MCP endpoint. It stores access and refresh tokens as an opaque credential record, exposes only value-free status to the rest of the Host, and gives the MCP client a token only for the exact official endpoint. Configuration carries the public GitHub App client ID. Private grants stay in Host credential storage.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package when a Host profile offers the GitHub MCP connector with `githubAppAuthorization: true`. It registers `ctx.githubAppAuth`, which the MCP client consumes without becoming a credential store or exposing a token to the UI.

### Configuration

```yaml
- id: github-app-auth
  name: '@yharness/github-app-auth'
  config:
    clientId: 'your-public-github-app-client-id'
```

The client ID is public application metadata. The opt-in MCP entry uses `https://api.githubcopilot.com/mcp/` and gets its credentials from this service.

### Connect and disconnect

The Host authorization surface starts the registered device flow and displays only the GitHub verification page and short user code. After the user authorizes the app, the provider commits the grant and emits `github-app-auth/connection-changed`. Disconnect cancels active authorization or refresh work, removes the local grant, and emits the same event after removal.

The service reports `connected` when the stored access grant is usable or has a usable refresh grant. It reports `needs-auth` without refreshing or contacting GitHub when no usable grant exists. Changing the configured client ID requires a fresh grant.

### Service API

The service is available as `ctx.githubAppAuth`:

```ts
interface GitHubAppAuthService {
  status(): Promise<'connected' | 'needs-auth'>
  tokenFor(endpoint: URL): Promise<string | undefined>
  disconnect(): Promise<void>
}
```

`tokenFor()` returns a token only for the exact GitHub MCP URL. It refreshes an expired access token through the serialized credential-record path and does not emit a connection event for an ordinary refresh. The caller must treat `undefined` as unauthenticated or unavailable.

### Official device flow

GitHub documents the device flow in [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app). The provider exports `GITHUB_DEVICE_VERIFICATION_URL` as the canonical verification page and uses `https://github.com/login/device/code`, `https://github.com/login/device`, and `https://github.com/login/oauth/access_token` exactly as documented.

<a id="understand-the-implementation"></a>
## Understand the implementation

The provider keeps the private grant inside `ctx.credentials`. Device expiry, denial, invalid verification, and invalid refresh grants end authorization with a redacted result. Requests use bounded timeouts and refuse redirects.

The provider emits `github-app-auth/connection-changed` after completed sign-in, disconnect, or definitive grant invalidation. It does not emit for normal access-token refreshes. Definitive invalidation replaces the old grant with a secret-free marker while preserving a newer grant written by another Host.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host service, authorization flow, grant lifecycle, and endpoint-pinned token projection |
| [`tests/github-app-auth.spec.ts`](tests/github-app-auth.spec.ts) | Offline authorization, refresh, invalidation, cancellation, and event coverage |

<a id="further-exploration"></a>
## Further Exploration

- [Credentials subsystem reference](../../../docs/subsystems/credentials.md) — credential records, authorization flows, and the generated service surface.
- [MCP client configuration](../../mcp/mcp-client/README.md#connect-github) — the consumer-side endpoint and Bot access configuration.
- [GitHub App device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app) — GitHub's protocol documentation.

<a id="model-experience"></a>
## Model Experience

### GitHub MCP authorization

#### What the model sees

The `ctx.githubAppAuth` provider adds no prompt text or model tools. The MCP client exposes GitHub tools only after the provider reports a usable grant and the official endpoint connects. Tokens are never included in model requests or session events.

#### Token effect

After sign-in, GitHub tool schemas and results enter model requests through the MCP client. The credential record stays on the Host.

#### KV Cache effect

Sign-in and token refresh change Host connection state. The MCP client owns tool registration and its effect on model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The device flow needs an interactive Host surface** — a headless deployment must authorize from a connected Y Harness surface before its Bots can use the connector.
- **The grant is endpoint-pinned** — `tokenFor()` refuses every URL except the exact official GitHub MCP endpoint.
- **GitHub revocation** — Disconnect removes the saved grant from Y Harness. Revoke the app authorization in GitHub settings.
- **One configured client ID owns the grant** — changing it invalidates the previous grant for this Host and requires authorization again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The provider uses fixed GitHub device-flow URLs and sends access credentials through the official GitHub MCP connection. The refresh path replaces expiring credentials while the MCP connection stays live.

</details>
