---
kind: upgrade-guide
description: "Managed VPS Bots use private Linux computers and receive host service access through explicit grants."
---

# Private computers for VPS Bots

## Change

The VPS installer assigns each Bot its own Linux computer. Previously, Bots used host working directories and could share one optional X11 desktop. A new Bot on a managed VPS receives a private workspace when created. Existing Bot records, chats, model settings and schedules stay in the Web service’s existing data directory.

## Migration

1. Update the installed Y Harness checkout. Rerun the [VPS installer](../../../user/guide/vps.md#install-and-start) and restart the Web service when it is idle.
2. Reconnect to Cloud and open a Bot. Verify that its header shows its VPS computer and that **Computer** shows its desktop.
3. Use `podman ps --filter label=io.yharness.vps.session=BOT_SESSION_ID` to identify the running computer. Copy reviewed working files into the computer with `podman cp ./reviewed-files/. CONTAINER:WORKSPACE/`, using the workspace path reported by the Bot’s shell. Copy any approved imported skills into the host-side `~/.yharness-vps/bots/BOT_SESSION_ID/.agents/skills` directory. Review routine prompts for old paths or direct network access before resuming them.
4. Configure [service grants](../../../user/guide/vps.md#give-a-bot-access-to-service-diagnostics) for Bots that need service diagnostics or owner-approved restarts.
