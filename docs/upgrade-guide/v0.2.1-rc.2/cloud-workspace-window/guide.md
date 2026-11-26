---
kind: upgrade-guide
description: "The macOS app opens its saved server automatically and moves Vault and server setup into the Workspace menu."
---

# Cloud workspace window on macOS

## Change

Y Harness opens the configured server when the app launches, including when the previous version last showed local chats. The in-window Mac and Cloud switch has been removed. The app reconnects automatically and keeps an open Cloud chat in the window while the connection recovers. Local and server chat histories remain in their respective stores.

## Migration

1. Open the updated app. It reuses the saved server and opens its chats automatically.
2. Use **Workspace → Server Settings…** in the macOS menu bar to change the server. Use **Workspace → Vault** to manage saved keys and logins.
3. If no server is configured, the app opens the local workspace. See [connect a server](../../../user/guide/vps.md#open-y-harness) to set one up.
