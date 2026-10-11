# Agent Note: Optional Desktop account access

Status: implemented

English | [中文](2026-10-11-optional-desktop-account.zh.md)

## Problem

Credential-first startup prevents access to local projects and files before a user chooses a model provider. A successful account login also previously replaced a saved default model, and API-key discovery applied introduction preferences without an explicit choice.

## Decision

Desktop opens the workspace after Host readiness and locale resolution without using account state or provider credentials to gate entry. Account sign-out, expiry and transport failure retain that document. The [account login](2026-09-14-deepseek-account-login.md) provider continues to own optional PKCE, credential persistence, cancellation and inference authentication. This decision partially supersedes the startup policy in the [native welcome record](2026-09-08-desktop-welcome-window-material.md); its retained renderer, native material and restricted preload remain separate components.

Introduction progress stays invisible, including saved credit, purpose and process steps. Startup writes no completion marker or preference defaults. Stored values retain their schema and remain untouched. The [provider-only UI decision](2026-10-11-provider-only-desktop-ui.md) partially supersedes the earlier saved-step presentation policy.

Optional login initializes an account model only when no provider API-key reference or saved model override exists. Initialization rereads redacted settings after asynchronous discovery and writes against the observed revision, preserving concurrent model choices. Existing sessions keep their own selections.

Account-free application access grants no inference entitlement. The bundled DeepSeek routes call the remote official service using either a Platform account grant or an independently configured API key. Account models require valid sign-in and available account credits; other providers retain their authentication and billing requirements. [Official billing documentation](https://api-docs.deepseek.com/quick_start/pricing/) describes token charges against granted or topped-up balances.

## Alternatives considered

**Persist a skip flag for credential-first startup.** This still makes account setup the default entry and adds persistence merely to open local features. Direct workspace startup removes that dependency without changing existing profiles.

**Complete the introduction automatically when a key exists.** Credential metadata does not express a user's transcript, usage or developer-tools preferences. Those choices remain explicit.

**Replace the default model after every login.** Login expresses authorization for a provider, not permission to replace a saved model selection.

## Consequences

Users can open local features offline and choose account or provider setup when inference needs it. Authentication and quota failures still prevent inference; no credentials, account grants or credits are supplied implicitly. The app preserves profiles, sessions and stored introduction progress without a migration. The dormant welcome renderer remains bundled; removing it is a separate cleanup.

Desktop startup, account UI and model-initialization regressions cover credential-free entry, existing profiles, cancellation, errors and repeat launches. The built browser and installed-app checks remain necessary for final visual and operating-system acceptance.
