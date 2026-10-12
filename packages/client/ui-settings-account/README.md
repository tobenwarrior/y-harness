---
description: "Desktop Models offers an optional DeepSeek provider connection, browser authorization, usage, balances and explicit disconnect."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md). The Models connection dialog emits no authentication analytics events.

Server-expired credentials clear the provider details. Account state never changes the application identity or gates the workspace.

## Summary

Settings → Models contains the optional DeepSeek connection card. It offers browser authorization, cancellation and confirmed disconnect; connected profiles can inspect balances, usage and top-up. The sidebar and Settings navigation remain independent of this provider.

The sign-in dialog offers network troubleshooting only for `no-response` failures. HTTP, business, response-validation, storage, and account-stream failures retain the generic retry message.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

Account authentication and quota errors retain the existing task failure path. Billing controls belong to Models; this plugin installs no global account or quota dialog.

<a id="use-this-package"></a>
## Use this package

The client activates only inside Desktop, identified by its preload bridge. Plain Web clients keep the standard Settings launcher and API-key onboarding without the account-state subscription or connection card.

The provider card displays a circular 32px profile image with the account icon as fallback when its URL is absent or fails to load. The profile name and masked contact remain inside Models.

The card registers through `settings.models.footer`, independently of the authenticated account model catalog. A disconnected provider remains discoverable even while its model row is hidden. One plugin-owned account Remote stream survives carrier reconnects through the shared supervisor. API keys remain separate from account grants.

Account operations carry this UI's client identity to the Host: build version, active language, and the current UTC offset in seconds sampled as the operation is issued.

Balances use Platform Web currency formatting: two decimal places and digit grouping, positive amounts truncated to cents, positive sub-cent amounts shown as <0.01, and negative amounts rounded with a minimum displayed magnitude of 0.01. Raw Host balance strings remain unchanged.

Usage and top-up open one isolated native Platform view below the existing return bar. The shared `shell.overlay` host and `PlatformPages` request channel preserve single-owner replacement, focus restoration, loading errors and Retry. Closing a top-up page waits for any pending account read and refreshes profile, balance and unnotified bonus; usage return, supersession and disposal read nothing. Renderer projections never receive the token.

The plugin does not contribute to `shell.quota-notice`. Generic Chat failure presentation and backend authentication/quota enforcement remain available; the connection card is the route to usage and top-up.

The injected contactUs action opens the Feishu questionnaire in the system browser. Each invocation samples its current context: the account UID when the profile is ready and carries an id, the build version as harness_version, and device_info. The device_info value includes the physical screen resolution as screen_resolution=widthxheight, after rounding the screen dimensions multiplied by devicePixelRatio; unavailable screen dimensions omit this entry. Each context field also carries hide_*=1, stale prefill values for these fields are dropped from the configured form URL first, including uid, device_info and harness_version regardless of the configured URL. The URL carries no os_version, device_brand, app_locale or separate screen_resolution parameters; configured prefill and hide parameters for these fields are removed. Tokens and masked contact details stay out, and a signed-out, still-loading, or failed profile leaves prefill_uid out. When the Desktop bridge has no deviceInfo reader, the form opens with navigator.userAgent. Desktop exposes the optional dshDesktop.deviceInfo reader, whose field format the [Desktop README](../../../apps/desktop/README.md) owns; its answer replaces the user agent, a failed read still opens the form with any available screen resolution in device_info, and device_info describes the reported environment rather than a hardware model. Configure contactFormUrl on the ui-settings-account plugin to select another HTTPS form; contactSource defaults to empty until the questionnaire supports a Harness source option.

Account profile and balance cards share the [settings card material and radius](../../../docs/web-styling.md#corner-radii-and-settings-cards). Usage and top-up links match standard Button geometry; authorization actions use the shared Button.

The application uses the neutral Settings launcher supplied by the settings shell. The account plugin registers neither `settings.launcher` nor a top-level `settings.section`.

The account card’s More account information link has no underline and opens the root of the Host-provided Platform usage URL in the system browser, following `platformOrigin`.

Disconnect first queries running account-token tasks and opens the existing confirmation dialog. A known or unknown running-task impact warns about interruption. Only confirmation invokes Host sign-out. Cancel, close and Escape retain the grant. The credential provider owns local grant deletion and bounded remote revocation; unrelated credentials, profiles and sessions remain intact.

Server-authored bonus notices appear only while the connected provider card is mounted. Account activation still reads the pending notice; entering Models and returning from top-up refresh it without polling. Ordinary Settings entry does not refresh account details.

An order is acknowledged only after the notice completes a presented frame or the user dismisses it. An unseen notice is not acknowledged. Fetching or opening the application never establishes presentation. Existing capped acknowledgement retries and account-change invalidation remain unchanged.

<a id="desktop-onboarding"></a>
### Desktop onboarding

The desktop introduction overlay is no longer registered. Fresh and saved credit, purpose, process or completed progress remain unchanged, along with transcript, usage and developer-tools preferences. Account connection does not start a product welcome flow.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin owns one sanitized Host snapshot stream. `AccountSection` renders through the Models footer, subscribes while mounted, and uses the existing operations for explicit connect, cancel and disconnect. It maintains no separate credential store.

Legacy introduction components and the `ui-settings-account` schema remain available for upstream compatibility, but this composition constructs no introduction controller. Startup, Settings entry and provider connection therefore write no completion flag or tutorial preferences. The [provider-only UI decision](../../../.agents/notes/implemented/architecture/2026-10-11-provider-only-desktop-ui.md) owns this separation.

<a id="further-exploration"></a>
## Further Exploration

The [credentials subsystem](../../../docs/subsystems/credentials.md) owns storage APIs; the [architecture](../../../docs/architecture.md) explains application composition.

Connect opens a dismissible provider dialog. Waiting offers a copyable themed authorization link; failure and timeout require explicit retry. Clipboard failure is transient and does not interrupt authorization. Cancellation becomes available once the pending authorization attempt is identified; closing a waiting dialog cancels that Host attempt. API-key editors remain separate provider controls in Models.

A terminal account-stream failure appears in the provider card or its sign-in dialog. Plugin unload suppresses late failure reports.

The balance card shows recharge funds and bonus credit in separate rows. While signed in, the bonus row appears during loading, after a failed wallet read, and when a wallet holds positive bonus credit; a successful read without positive bonus credit omits the row. A failed wallet read shows the existing unavailable copy as a link to Platform — the same destination and behavior as the Usage action, so the embedded page opens on Desktop and a new tab elsewhere — while the loading state stays plain text. Currencies retain their own amounts, and a notice date is rendered only inside the server’s own message.


After optional sign-in, [Session default-model initialization](../../api/session-controller/README.md) may select the first available `deepseek-account` model when no provider has a configured API-key reference and no default-model override is saved. Saved choices and concurrent settings changes remain intact, including unavailable provider or model selections and reasoning-only overrides. Session-specific selections remain unchanged.

<a id="model-experience"></a>
## Model Experience

None, as account credentials affect HTTP authentication and never enter model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Profile and wallet queries preserve server-masked contact information and show failures independently, without manufacturing a zero balance. Host-derived Platform links never carry a DSH token.
- Local application access supplies no inference entitlement. Connected account models still require valid authorization and available granted or topped-up credits.

- The notice copy is server-localized for the UI language in effect when the client reads it. Switching language does not itself re-read the unnotified bonus, so a notice already on screen keeps the copy the server sent for the earlier language until the user refreshes or the account lifecycle restarts.

- The Platform view’s dialog marks every other document child inert, including the Desktop-owned caption menu host, so the Application and Edit menu stays visible but cannot be operated until the view closes. Exempting that host needs an inertness contract owned by the Desktop.

<a id="dev-note"></a>
### Dev Note

The [desktop login decision](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.md) records cancellation and storage ownership.

Usage and top-up show a centered 24px loading indicator without visible loading text until the native document loads; the return action remains available. The loading SVG is embedded locally from Figma node 2957:72553.

Default-model initialization runs after publishing and accepting the sign-in frame, without delaying subsequent account frames. Failures are recorded in diagnostics and do not mark the signed-in account as failed.

Read-only settings, failed account reads and transport errors leave the workspace accessible. Closing Models releases the card and its native page request without disconnecting the provider.
