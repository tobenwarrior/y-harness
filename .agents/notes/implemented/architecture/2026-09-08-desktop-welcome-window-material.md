# Agent Note: Desktop welcome window material

Status: implemented

English | [中文](2026-09-08-desktop-welcome-window-material.zh.md)

## Problem

The desktop welcome design blurs the desktop behind its entire window. Chromium backdrop filters only sample content inside the renderer. Credential setup also needs an explicit startup owner so a native skip is not followed by a second Web dialog.

## Decision

The retained [Electron welcome window](../../../../apps/desktop/src/welcome-window.ts) owns native material and window controls. Its independently bundled React renderer supplies entry, account sign-in states and API-key form fixtures. It shares the `StateDot` loading component with the Web UI without booting the Web plugin graph. The Desktop build emits local JavaScript and CSS under `lib/welcome`, included in packaged applications; the document keeps its network-denying content security policy. A narrow preload supplies typed shell copy, a write-only key operation, and a skip operation; IPC rejects other windows and subframes. Each sandboxed preload is bundled independently because Electron’s restricted require cannot load sibling chunks. The welcome backend resolves the official provider reference through existing settings and credential RPC methods for explicit operations. The [thin Web wrapper](2026-09-10-desktop-web-wrapper.md) owns the HTTP server; onboarding adds no Host endpoint or child IPC operation. Responses contain metadata or a safe outcome, never a key or private provider diagnostics.

[Optional Desktop account access](2026-10-11-optional-desktop-account.md) now owns startup and partially supersedes the credential-first entry policy. Main-process startup opens the workspace without the native welcome window or a credential check. The Desktop preload marker still suppresses automatic Web credential setup; Settings and explicit API-key editing remain available. The [Desktop onboarding reference](../../../../packages/client/ui-settings-account/README.md) owns saved device-local introduction progress. Other native shells can disable only the credential step through the Models Host plugin’s `credentialOnboarding` page-injection value. The module graph carries package identities rather than arbitrary Host config, so a Host row alone does not configure its Client half. The [account provider](2026-09-14-deepseek-account-login.md) supplies optional login and sign-out while preserving independently stored API keys.

The generated project follows declared workspace dependencies because pnpm’s hoist index alone can omit configured plugins.

Desktop reads the shared `locale.preference` before opening the workspace. The Client awaits an isolated preload read of that preference and the same OS language order before mounting, then reports resolved locale changes to the shell. Only an explicit Settings selection writes the preference; automatic detection stays provisional. The shell ships English and Simplified Chinese dictionaries, so a Client-only language pack falls back to a supported OS language in native windows.

The retained welcome backend shares the Desktop backend controller with startup recovery. The main recovery document loads offscreen while the Host starts; a failure reveals it, and successful startup opens the workspace after reading locale. Recovery actions retain the controller’s serialized retries and awaited child shutdown. The application preload exposes recovery controls only to shell documents and the locale bridge only to application documents.

## Alternatives considered

**A CSS-only backdrop filter.** It cannot blur other application windows or the desktop, so it cannot provide the required native effect.

**Persisting a credential-entry completion flag.** The original credential-first policy treated native skip as process-local so the next startup could ask for missing credentials again. The [account-free startup decision](2026-10-11-optional-desktop-account.md) supersedes that policy: workspace entry no longer depends on credentials or a completion flag.

**Keeping both native and Web credential dialogs.** Their separate completion state would ask for a key twice after a native skip. The composition assigns credential onboarding to one owner.

**Drawing replacement traffic lights.** Native controls preserve platform window behavior and accessibility. Their dimensions and outer window corners follow the OS rather than reproducing Figma geometry exactly.

**Separate preview callbacks.** A visual-only skip cannot demonstrate entry into the workspace and can hide broken startup dependencies. The preview uses the same callbacks and Host as the product.

## Consequences

Native blur strength and font fallback vary by system. The main window uses the shared sidebar vibrancy; full-window onboarding retains a transparent renderer without an additional tint. Windows compositing needs platform QA. Owner-local text expectations cover both pages and locales, and built-Host acceptance covers credential persistence across restarts. Account sign-out preserves independent API keys. Onboarding presentation produces no Session events.
