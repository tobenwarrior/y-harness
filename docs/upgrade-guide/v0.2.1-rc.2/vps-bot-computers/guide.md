---
kind: upgrade-guide
description: "Managed VPS Bots use private Linux computers and receive host service access through explicit grants."
---

# Private computers for VPS Bots

## Change

The VPS installer assigns each Bot on a fresh installation its own Linux computer. Existing VPS installations select Bots in the Web profile patch. A Bot configured for a fully managed computer uses its private workspace for shell and file tools. Existing Bot records, chats, model settings and schedules stay in the Web service’s existing data directory.

## Migration

These steps apply to the stock `yharness-vps.service` from the [VPS guide](../../../user/guide/vps.md#install-and-start). They keep `~/.yharness-vps/state`, `workspace`, `bots`, and the original source checkout in place.

1. While the service is running, build a separate checkout. Use your normal Git credential helper or SSH configuration; never put a password or access token in the clone URL or shell history.

   ```sh
   set -eu
   root="$HOME/.yharness-vps"
   release="$root/release-source-v0.2.1-rc.2"
   original="$root/source-original-v0.2.1-rc.2"
   test ! -e "$release"
   test ! -e "$original"
   git clone --depth=1 --branch master https://github.com/tobenwarrior/y-harness.git "$release"
   cd "$release"
   pnpm_package="$(node -p "require('./package.json').packageManager")"
   test "$pnpm_package" = "pnpm@11.25.0"
   npm exec --yes --package "$pnpm_package" -- pnpm install --frozen-lockfile
   npm exec --yes --package "$pnpm_package" -- pnpm run build
   test -f apps/cli/lib/bin.js
   ```

2. When Cloud tasks are idle, stop the service and select the built checkout. Run setup from that checkout to prepare the Bot image, verify the sandbox, and start the service.

   ```sh
   set -eu
   root="$HOME/.yharness-vps"
   systemctl --user stop yharness-vps.service
   mv -T "$root/source" "$root/source-original-v0.2.1-rc.2"
   mv -T "$root/release-source-v0.2.1-rc.2" "$root/source"
   python3 "$root/source/scripts/setup-vps.py"
   systemctl --user is-active --quiet yharness-vps.service
   ```

3. Save a copy of the existing Web profile patch if present. Follow the [VPS guide’s Bot selection steps](../../../user/guide/vps.md#move-existing-bots-in-stages), then restart when Cloud tasks are idle. Reconnect and verify that the selected Bot’s header and **Computer** panel show its dedicated desktop.
4. For a Bot moving its shell and files, use `podman ps --filter label=io.yharness.vps.session=BOT_SESSION_ID` to identify the running computer. Copy reviewed working files with `podman cp ./reviewed-files/. CONTAINER:WORKSPACE/`, using the workspace path reported by the Bot’s shell. Copy approved imported skills into `~/.yharness-vps/bots/BOT_SESSION_ID/.agents/skills` and review routine prompts for old paths or direct network access before resuming them.
5. To roll back, restore the saved Web profile patch or move the newly created patch out of the profile directory. Run the following as the VPS service user when Cloud tasks are idle.

   ```sh
   set -eu
   root="$HOME/.yharness-vps"
   systemctl --user stop yharness-vps.service
   mv -T "$root/source" "$root/release-source-v0.2.1-rc.2"
   mv -T "$root/source-original-v0.2.1-rc.2" "$root/source"
   python3 "$root/source/scripts/setup-vps.py"
   ```

6. Configure [service grants](../../../user/guide/vps.md#give-a-bot-access-to-service-diagnostics) for Bots that need service diagnostics or owner-approved restarts.
