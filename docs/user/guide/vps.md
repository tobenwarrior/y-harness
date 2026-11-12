# Run Y Harness on your VPS

Run the Y Harness Web profile on a Linux VPS you control. Its user service starts at boot and keeps running when you close your browser or SSH connection. The Web listener stays on the VPS's loopback address. You reach it through your existing SSH login.

## Prepare the VPS

Use a regular SSH account on a Linux server with systemd user services, Git, Python 3, curl, npm, a C compiler, and a compatible Node.js installation with development headers. Ubuntu 24.04 with Node.js 24 LTS is the initial setup target. On Ubuntu, `build-essential` provides the compiler. Keep port 3080 available on the VPS.

## Install and start

Connect to the VPS over SSH and paste this command. The first setup builds Y Harness and its Bot desktop image. Setup can ask for sudo to install system packages. Y Harness itself runs under your regular SSH account.

```sh
mkdir -p ~/.local/bin &&
  curl -fsSL https://raw.githubusercontent.com/tobenwarrior/y-harness/master/scripts/setup-vps.py -o ~/.local/bin/yharness-vps &&
  python3 ~/.local/bin/yharness-vps
```

On Ubuntu 24.04, setup reuses a working Bubblewrap installation or uses sudo to install Ubuntu’s Bubblewrap package and load Ubuntu’s packaged AppArmor profile when needed. The profile and package live in the system, outside the Y Harness checkout. Setup keeps the system-wide AppArmor namespace restriction in force. See the private `~/.yharness-vps/bubblewrap.log` for installation errors. An existing conflicting profile needs administrator review.

On other Linux hosts, setup uses an available Bubblewrap or Landlock runner, or builds the bundled Landlock runner with the server’s C compiler. See the private `~/.yharness-vps/sandbox.log` for Landlock build or kernel errors.

If setup reports that your user cannot enable lingering, ask the VPS administrator to run `sudo loginctl enable-linger YOUR_USER`, then retry setup. This lets systemd keep the user service running without an active login.

## Open Y Harness

On macOS, choose **Workspace → Open Cloud Workspace** in Y Harness and enter the SSH host name or alias you use in Terminal. The app needs a verified host key and an SSH key or agent that can sign in without prompting. It remembers your selection and connects automatically. Cloud opens the bots, chats, and providers stored on the server. Use that Cloud workspace on each device to continue the same chats while the VPS runs your jobs and schedules. The **Mac** switch opens your separate local workspace.

To use a browser, keep local port 3080 free. On your computer, replace `your-vps` with the SSH destination you normally use and run:

```sh
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:3080:127.0.0.1:3080 your-vps \
  'python3 ~/.local/bin/yharness-vps url && exec sleep infinity'
```

Open the printed sign-in link in your browser and keep it private. Leave the command running while you use Y Harness. You can close the tunnel and reconnect later while the service continues on the VPS. [Set up your models and workspace](./index.md) in the VPS Web interface.

## Watch and control the Computer

Open a Bot in Cloud. Its header identifies the VPS computer it uses and the scope of its permissions. Choose **Computer** to see that Bot’s desktop. Choose an image-capable model so the Bot can read the screen.

Each owner Bot has its own Linux workspace and desktop. The Bot’s shell and file tools operate inside that computer. The Bot computer has no direct network connection or host service access. Provider connections run through Y Harness. Mac sharing and macOS permissions are managed in the **Mac** workspace.

Choose **Take control** to use your mouse and keyboard in the panel. Bot input through the Computer tool pauses while you hold control. Choose **Hand back** to let the Bot use it again. Closing the panel releases control, and a lost connection releases it after a short timeout. The Bot computer stays on the VPS when you disconnect.

## Give a Bot access to service diagnostics

Ask the VPS owner to add a service grant in the Web profile patch at `~/.yharness-vps/state/profiles/web/cordis.patch.yml`. The grant names an exact systemd service and the Bot roster IDs that may inspect it. This example grants read access to a service managed by the same Linux user as Y Harness.

```yaml
- id: web-runtime
  config:
    vpsServices:
      - unit: example-worker.service
        scope: user
        bots: [bot-worker]
```

Restart the Web service when its tasks are idle. The Bot can call `vps_service_status` to read the unit’s state, restart count and last exit details. A `system` grant targets the system manager. The tool returns selected systemd fields and keeps raw journals and service configuration on the host.

To enable a restart request for an exact service, add `restart: true` to its grant. Select **Ask for approval** in that **Cloud** Bot conversation. The owner must accept each restart request, and the Web service account must have Linux permission to restart the unit. Use the VPS administrator’s own login for code changes and other protected maintenance.

## Import a Grok Bot export

Create the destination bot in **Cloud → Bots**. Put its version-one Grok Bot export JSON in a private directory on the VPS. From your SSH session, preview the import with the tool included in the Y Harness checkout:

```sh
python3 ~/.yharness-vps/source/scripts/import-grok-bot.py ./grok-bot-export.json --bot "Research Bot"
```

For a file with several bots, add `--source-name` to choose one. Repeat the command with `--apply` to import into the destination bot's existing chat and folder. The tool adds memories and user facts to the bot's memory, installs exported skill definitions in its working directory, and creates scheduled routines paused. Open the bot's routine manager to review the timing and resume each routine when ready. The preview lists any routine skill references that lack a definition in the export. App connections, chat transcripts, and event-triggered routines require separate setup.

If a routine references Grok's `box-desktop` skill, copy the [VPS Computer compatibility skill](../../../apps/cli/config/examples/skills/box-desktop/SKILL.md) into `.agents/skills/box-desktop/SKILL.md` in the Bot’s host-side skill directory at `~/.yharness-vps/bots/<bot-session-id>`. Select an image-capable model in that Bot’s chat. Test a desktop observation and review any routine that needs network access before resuming it.

## Check the service

On the VPS, run `python3 ~/.local/bin/yharness-vps status`. Setup keeps the source checkout, the working directory, and Y Harness state in separate locations under `~/.yharness-vps`. Provider settings and logs stay in that private directory. Keep the host log private because it contains the sign-in link.

The service restarts after a process failure and loads saved state when it starts. An interrupted task may need your attention. Rerunning setup reuses the installed build and checks its sandbox without interrupting a running service. If setup repairs an existing runner, restart the service when your tasks are idle so it can use the new runner. The service checks the sandbox on every start, including after a new checkout replaces the old one. On Ubuntu 24.04 it requires working Bubblewrap. If the check fails, run setup again to repair it.
