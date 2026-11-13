# Run Y Harness on your VPS

Run the Y Harness Web profile on a Linux VPS you control. Its user service starts at boot and keeps running when you close your browser or SSH connection. The Web listener stays on the VPS's loopback address. You reach it through your existing SSH login.

## Prepare the VPS

Use a regular SSH account on a Linux server with systemd user services, Git, Python 3, curl, npm, a C compiler, and a compatible Node.js installation with development headers. Ubuntu 24.04 with Node.js 24 LTS is the initial setup target. On Ubuntu, `build-essential` provides the compiler. Keep port 3080 available on the VPS.

## Install and start

Connect to the VPS over SSH and paste this command. The first setup builds the public source and can take several minutes.

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

On Ubuntu, you can give your bots a private desktop on the same VPS. Run these commands from your SSH session after installing the Web service. Setup installs the desktop packages through sudo. Activate when your current tasks are idle, since activation restarts the Web service.

```sh
mkdir -p ~/.local/bin &&
  curl -fsSL https://raw.githubusercontent.com/tobenwarrior/y-harness/master/scripts/setup-vps-display.py -o ~/.local/bin/yharness-vps-display &&
  curl -fsSL https://raw.githubusercontent.com/tobenwarrior/y-harness/master/scripts/vps-display-supervisor.py -o ~/.local/bin/vps-display-supervisor.py &&
  python3 ~/.local/bin/yharness-vps-display &&
  python3 ~/.local/bin/yharness-vps-display activate
```

Reconnect using a fresh sign-in link. Open a bot and choose **Computer** to watch the same desktop it uses. Ask the bot to use the Computer to see it work. Choose a model that accepts images so it can read the screen.

Choose **Take control** to use your mouse and keyboard in the panel. Bot input through the Computer tool pauses while you hold control. Choose **Hand back** to let the bot use it again. Closing the panel releases control, and a lost connection releases it automatically after a short timeout. The private desktop stays running when you disconnect.

## Save credentials for a dedicated service

The VPS Vault stores encrypted API keys for trusted systemd system services. Set up the service with its own explicit `User=` account, separate from the Linux account that runs Cloud. An explicit `User=` also works with `DynamicUser=yes`. The service receives its keys in systemd's private credential directory.

Use a trusted administrator login on the VPS. Keep the Linux account that runs Cloud and any accounts used by Bot shells unprivileged. Install the command from your trusted administrator checkout. Replace `CLOUD_USER` with the Cloud account and `example-worker.service` with the exact system service name.

```sh
sudo install -o root -g root -m 0755 scripts/vps-vault.py /usr/local/sbin/yharness-vault
sudo /usr/local/sbin/yharness-vault --cloud-user CLOUD_USER enable example-worker.service
sudo /usr/local/sbin/yharness-vault --cloud-user CLOUD_USER set example-worker.service EXAMPLE_API_KEY
```

Enter the value at the masked terminal prompt. In the service, read `yharness_EXAMPLE_API_KEY` from the directory named by `CREDENTIALS_DIRECTORY`. The Vault lists saved names with `list example-worker.service`. Run `set` again to rotate a key, or `revoke example-worker.service EXAMPLE_API_KEY` to remove it. Save, rotation, and revocation apply the next time you start the target service. If it already used the old key, revoke that key with its issuer to invalidate it there too.

The values are encrypted with the VPS's systemd host key. A replacement VPS needs its own keys entered for the service. [systemd credential documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials)

### Manage service secrets from the Mac app

Run Cloud under a dedicated, unprivileged Linux account. From the VPS administrator login, allow the SSH account that Y Harness Desktop uses to manage the exact services you enabled above. Replace `CLOUD_USER` with the Cloud account and `SSH_OWNER` with the separate SSH account.

```sh
sudo /usr/local/sbin/yharness-vault --cloud-user CLOUD_USER allow-desktop \
  --owner SSH_OWNER example-worker.service
```

Leave the service names out to open an empty Vault. After enabling a service, rerun `allow-desktop` with the complete list of services that Desktop may manage.

Open **Cloud** and select the lock icon in its title bar. Choose a service, then **Add secret**, **Replace**, or **Revoke**. Enter values in the masked field. The window sends values directly to the VPS Vault over SSH and shows saved names after submission. Values stay outside Cloud chat, Bot tools, and model requests. The selected service loads its current values on its next start.

Run `sudo /usr/local/sbin/yharness-vault deny-desktop` to remove Desktop management access and stop its listener. Stored credentials are available to their services until you revoke them. To grant management to a different SSH account, run `deny-desktop` first, then run `allow-desktop` with the new account.

## Import a Grok Bot export

Create the destination bot in **Cloud → Bots**. Put its version-one Grok Bot export JSON in a private directory on the VPS. From your SSH session, preview the import with the tool included in the Y Harness checkout:

```sh
python3 ~/.yharness-vps/source/scripts/import-grok-bot.py ./grok-bot-export.json --bot "Research Bot"
```

For a file with several bots, add `--source-name` to choose one. Repeat the command with `--apply` to import into the destination bot's existing chat and folder. The tool adds memories and user facts to the bot's memory, installs exported skill definitions in its working directory, and creates scheduled routines paused. Open the bot's routine manager to review the timing and resume each routine when ready. The preview lists any routine skill references that lack a definition in the export. App connections, chat transcripts, and event-triggered routines require separate setup.

To attach an already normalized and reviewed Grok history archive to the destination bot, use the dedicated history mode with `--apply`:

```sh
python3 ~/.yharness-vps/source/scripts/import-grok-bot.py ./grok-history.json --bot "Research Bot" --history --apply
```

Y Harness validates the archive before saving it and preserves recovered records on repeat imports. Open **Imported Grok chat** in the destination bot's conversation header to check the result. The history mode requires `--apply`.

If a routine references Grok's `box-desktop` skill, copy the [VPS Computer compatibility skill](../../../apps/cli/config/examples/skills/box-desktop/SKILL.md) into `.agents/skills/box-desktop/SKILL.md` in the destination bot's working directory. Make a browser available on the VPS desktop and select an image-capable model in that bot's chat. Test a manual desktop observation before resuming the routine.

## Check the service

On the VPS, run `python3 ~/.local/bin/yharness-vps status`. Setup keeps the source checkout, the working directory, and Y Harness state in separate locations under `~/.yharness-vps`. Provider settings and logs stay in that private directory. Keep the host log private because it contains the sign-in link.

The service restarts after a process failure and loads saved state when it starts. An interrupted task may need your attention. Rerunning setup reuses the installed build and checks its sandbox without interrupting a running service. If setup repairs an existing runner, restart the service when your tasks are idle so it can use the new runner. The service checks the sandbox on every start, including after a new checkout replaces the old one. On Ubuntu 24.04 it requires working Bubblewrap. If the check fails, run setup again to repair it.
