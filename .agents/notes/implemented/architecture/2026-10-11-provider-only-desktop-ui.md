# Agent Note: Provider-only Desktop account UI

Status: implemented

English | [中文](2026-10-11-provider-only-desktop-ui.zh.md)

## Problem

A provider profile in the sidebar and an Account settings category make a remote inference credential look like an application identity. Saved welcome steps can also bring that identity back after an otherwise account-free launch.

## Decision

The Desktop account plugin contributes optional DeepSeek connection controls only through `settings.models.footer`. The neutral Settings launcher and product sections remain available regardless of provider state. The footer also renders while the Models catalog loads or fails, so connecting the provider does not require authenticated model discovery to succeed first.

Connect, cancellation, confirmed disconnect, profile, usage, balance and bonus notices stay inside the Models provider context. Closing that context never disconnects or acknowledges an unseen notice. Existing Host grant storage, PKCE, callback validation, manual revocation and inference checks retain their owners. API-key routes and other provider connections keep their existing controls.

The composition no longer registers the product account menu, Account section, account choice before the API-key editor, account quota takeover or saved introduction overlay. Legacy components, settings schema, progress and preferences remain unchanged; this is presentation retirement, without credential or profile migration.

This decision partially supersedes presentation and saved-introduction eligibility in [optional Desktop account access](2026-10-11-optional-desktop-account.md) and [account login](2026-09-14-deepseek-account-login.md). Their startup, default-model preservation, protocol and credential rules remain active. Upstream package names, provider labels and license notices remain intact.

## Alternatives considered

**Hide the profile only while signed out.** Existing grants would still become a product identity on later launches.

**Attach Connect only to the authenticated model row.** The disconnected row has no model catalog and is hidden, so it cannot provide a discoverable connection entry.

**Clear grants or complete old welcome progress.** Neither action is implied by moving presentation; both would silently alter user state.

## Consequences

Account-free startup and a provider-independent application identity now apply to fresh and existing profiles. The bundled DeepSeek service still requires a valid grant or API key and applicable credits; the UI supplies no anonymous inference entitlement. Provider errors remain task errors, with billing actions under Models. Targeted component and registration tests cover this separation; native built acceptance remains required for final integration.
