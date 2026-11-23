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

### Run Cloud under a dedicated Linux account

Use the dedicated-account installer to start a new Cloud instance without giving the Web process access to your administrator home. On Ubuntu 24.04, prepare the system's Bubblewrap and Podman packages first. Use a built Y Harness release and a compatible Node installation in administrator-owned directories that the service can read.

```sh
sudo /usr/bin/python3 -I /opt/yharness/release/scripts/setup-vps-account.py install \
  --release /opt/yharness/release --node /opt/node/bin/node --owner "$USER" \
  --chromium /opt/chromium/chrome
```

Use `--owner` from the regular SSH account that will open Cloud. Port 3080 is required for the Mac workspace. Setup installs the sign-in helper in that account and makes the private link available to that account over a local socket. Then [open Cloud with your usual SSH destination](#open-y-harness). If that account already has a different `~/.local/bin/yharness-vps`, setup keeps it and reports the conflict.

Set `--chromium` to the absolute path of an administrator-installed Chromium executable. On a fresh installation, this prepares an isolated Browser for each owner Bot and opens an empty Cloud Vault for the SSH owner. Add website accounts in **Workspace → Vault** and grant shared access or automatic sign-in there when needed. Omit `--chromium` for a desktop-only VPS. On repeat runs, setup keeps the existing Browser and Vault policies. Manage a custom installation through the [isolated Browser settings](#enable-an-isolated-browser-for-selected-bots) and [Vault settings](#manage-service-secrets-from-the-mac-app).

For a Web-only connection, omit `--owner` and `--chromium` and choose an available `--port`. Run `sudo /usr/bin/python3 -I /opt/yharness/release/scripts/setup-vps-account.py url --port PORT` to get the private sign-in link. Use the selected port for both sides of the [SSH forward](#open-y-harness).

Setup prepares the Bot image inside Cloud's service environment so it can use the same container storage at startup. The `yharness-cloud.service` user service starts at boot under the locked Cloud account and stores its data under `/var/lib/yharness-cloud/.yharness-vps`. It starts with its own Bot workspaces and provider settings. Keep an existing Cloud installation running until its chats, files, providers, and desktop volumes have been moved and verified.

### Preserve the existing workspace path

On Ubuntu 24.04 with OverlayFS and an ID-mapped filesystem such as ext4, prepare the workspace mapping before starting the dedicated account's service manager. The script creates the locked account if needed. Replace `SSH_OWNER` with the regular account whose `~/.yharness-vps/workspace` Cloud uses.

```sh
sudo /usr/bin/python3 -I /opt/yharness/release/scripts/setup-vps-workspace.py --owner SSH_OWNER
```

The dedicated account sees the original workspace path with the new account's file ownership. Existing files form a read-only layer. Cloud stores changes in `/var/lib/yharness-cloud-layers/changes`. Keep enough free space there for new files and any original files you edit. After switching, edit the workspace through Cloud and keep the original files in place for the read-only layer. The service manager exposes only the prepared directory at `/var/lib/yharness-cloud-data` under the old home path. Keep a backup of the workspace and verify the service configuration, state, provider paths, and desktop volumes before changing which Cloud service runs.

## Open Y Harness

On macOS, choose **Workspace → Open Cloud Workspace** in Y Harness and enter the SSH host name or alias you use in Terminal. The app needs a verified host key and an SSH key or agent that can sign in without prompting. It remembers your selection and connects automatically. Cloud opens the bots, chats, and providers stored on the server. Use that Cloud workspace on each device to continue the same chats while the VPS runs your jobs and schedules. Choose **Workspace → Open Mac Workspace** to return to your local workspace.

To use a browser, keep local port 3080 free. On your computer, replace `your-vps` with the SSH destination you normally use and run:

```sh
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:3080:127.0.0.1:3080 your-vps \
  'python3 ~/.local/bin/yharness-vps url && exec sleep infinity'
```

Open the printed sign-in link in your browser and keep it private. Leave the command running while you use Y Harness. You can close the tunnel and reconnect later while the service continues on the VPS. [Set up your models and workspace](./index.md) in the VPS Web interface.

## Copy model catalogs from Mac

Open Cloud, then choose **Workspace → Copy Model Catalogs to Cloud**. Review how many provider catalogs can be added and confirm the copy. The action adds model definitions for missing routes. Cloud keeps the routes it already has, including provider defaults inherited from its settings.

### Copy saved provider keys

After copying the catalogs, choose **Workspace → Copy Saved Provider Keys to Cloud**. The app lists the eligible providers and the Cloud connection that will receive them. Confirm to save a separate copy of each listed key. Y Harness matches the provider's HTTPS endpoints and checks that the Cloud credential is still empty. This keeps any key you already saved in Cloud.

Use **Settings → Models** in Cloud to replace or remove a copied key. Account sign-ins and keys supplied by a launch environment or a .env file are set up separately in that workspace. The key copy requires an up-to-date Mac app and Cloud server.

## Watch and control the Computer

Open a Bot in Cloud. Its header identifies the VPS computer it uses and the scope of its permissions. Choose **Computer** to see that Bot’s desktop. Choose an image-capable model so the Bot can read the screen.

Each owner Bot has its own Linux workspace and desktop. The Bot’s shell and file tools operate inside that computer. Private desktops start offline. Provider connections run through Y Harness. Mac sharing and macOS permissions are managed in the **Mac** workspace.

Choose **Take control** to use your mouse and keyboard in the panel. Bot input through the Computer tool pauses while you hold control. Choose **Hand back** to let the Bot use it again. Closing the panel releases control, and a lost connection releases it after a short timeout. The Bot computer stays on the VPS when you disconnect.

### Restart an unresponsive Bot computer

Open **Computer** in the affected Bot's chat and choose **Restart computer**. If the Bot has both views, choose **Desktop** first. Finish any Bot or terminal work, close open desktop apps, and return control before confirming. Y Harness reconnects to the same private files, shared project, and saved network setting. To reopen an isolated browser using its saved profile, choose **Browser → Restart browser**. Both actions leave Cloud running.

### Open a Bot terminal

Choose **Terminal** beside **Computer** in the chat of a Bot with a private VPS computer. The shell starts in that computer’s workspace. Switch back to **Computer** to watch or take control while the terminal stays open. Close the terminal tab to end its shell.

### Move files to and from Cloud

Choose **Files** in a private VPS Bot chat to browse the same workspace that opens in **Terminal**. Choose **Upload** to copy files from your device to the workspace root, or use the upload icon on a folder to save them there. Cloud keeps the existing file when a name is already in use. Open a file to preview it, or use **Download file** to save a copy on your device. Use **Reload** after work in Terminal or the Bot changes a folder.

Ask the Bot to deliver the file in chat and use the download icon on the result card. Save the result inside the Bot's workspace before delivering it so Cloud can serve it to your device.

Use **Copy to bot** in a private file preview to put a copy in another Bot’s VPS workspace root. Choose the receiving Bot and confirm the copy. A Bot can also copy a file when you ask it to hand work off, subject to the Bot’s approval settings.

### Move existing Bots in stages

To select which existing Bots receive a private computer, set `botComputers.bots` to their Bot roster IDs in the private Web profile patch at `~/.yharness-vps/state/profiles/web/cordis.patch.yml`. The patch replaces the `web-runtime` configuration as a whole. Keep your existing settings when adding to a patch entry. The example starts from the installer’s defaults.

```yaml
- id: web-runtime
  config:
    openBrowser: !!js ctx.webStartup.openBrowser
    printUrl: true
    publicUrl: !!js ctx.webStartup.publicUrl
    surfaceContext: true
    trustedHosts: !!js ctx.webStartup.trustedHosts
    botComputers:
      root: /home/vps-user/.yharness-vps/bots
      image: localhost/yharness-vps-bot:24.04
      bots: [bot-worker]
    computer: !!js >-
      process.env.YH_VPS_DISPLAY === undefined && process.env.YH_VPS_XAUTHORITY === undefined
        ? undefined
        : { display: process.env.YH_VPS_DISPLAY, authorityPath: process.env.YH_VPS_XAUTHORITY }
```

Bots outside the list continue using their existing working directories and shared desktop settings. Follow the [workspace migration steps](../../upgrade-guide/v0.2.1-rc.2/vps-bot-computers/guide.md#migration) to copy working files and review existing routines.

For a selected Bot that still needs its host working directory or existing routine tools, add its roster ID to `botComputers.desktopOnlyBots`. Its **Computer** panel and `vps_computer` tool use the private desktop, including with an image-capable native Codex model. Its shell and file tools keep their existing permissions and working directory.

Set `botComputers.desktopForUnlistedBots: true` to give every remaining Bot a private **Computer**, **Terminal**, and **Files** panel in the same chat. These Bots keep their existing working directories and routine permissions. Their private computers start when used.

When the Cloud user service starts a private desktop, that desktop and its network processes run independently. The desktop can stay connected through a Cloud restart.

### Share project files between Bots

Open a Bot’s **Computer** panel and turn on **Shared workspace**. Use **Files → Shared workspace** to upload or open files, then switch to another Bot with access to work on those same files. In the VPS Terminal the folder is at `/workspace`. You can ask a Bot to save its work there by name, such as `/workspace/research/notes.md`.

Turn the switch off to remove that Bot’s access. Finish running Bot and terminal work, close desktop apps, and hand back control before changing access. The change replaces the idle Computer on its next use and keeps its private files, browser profile, and shared project files. Each participant can read and write the shared files. Keep material for one Bot or service in its private workspace or the Vault.

In the private Web profile, use `sharedWorkspace: { bots: [bot-first, bot-second] }` to set the defaults by roster ID. `sharedWorkspace: {}` defaults on for the Bots selected by `botComputers.bots`. An omitted setting defaults off, and `sharedWorkspace: null` disables shared workspace access and its switch. Each saved owner choice overrides the defaults when sharing is enabled.

### Give a Bot's VPS terminal internet access

In a Cloud Bot's chat, open **Computer** and use **Internet for Terminal & apps**. Close any programs running on that desktop, finish any terminal work, and hand back control before applying the change. The Computer reconnects with the same workspace and Firefox profile. Your choice persists across Cloud restarts.

The setting applies to that Bot's private desktop and **Terminal**. Bash in a fully managed Bot uses the same desktop. A desktop-only Bot's ordinary Bash keeps its existing workspace policy. The [isolated browser](#enable-an-isolated-browser-for-selected-bots) follows its own network policy. Rootless networking blocks the VPS host's loopback address. Review other services reachable from the VPS before granting access.

If the setting is missing, run `python3 scripts/setup-vps.py network` from the VPS release checkout to prepare rootless networking. To configure the initial defaults on a new deployment, set this list under `botComputers` in the private Web profile with the roster IDs of the Bots you want to connect.

```yaml
network:
  bots: [bot-worker]
```

Saved choices from the Computer panel take precedence over this list. When the list is omitted, Firefox desktops default to outbound access and other private desktops default to offline. Set `bots: []` for an offline default on every private desktop. For an existing container affected by a manual profile change, follow the replacement procedure in [Enable Firefox for selected Bots](#enable-firefox-for-selected-bots) and keep its named volumes.

### Enable Firefox for selected Bots

Run the browser setup from the Y Harness checkout that supplies the Web release. It builds Firefox and prepares outbound networking for the selected desktops.

```sh
python3 scripts/setup-vps.py browser
```

Add this block under the existing `botComputers` configuration. Replace the example account path and Bot ID with the VPS installation path and the Bot you want to grant access.

```yaml
browser:
  bots: [bot-worker]
  image: localhost/yharness-vps-bot-browser:24.04-v1
  seccompProfile: /home/vps-user/.yharness-vps/browser-seccomp.json
```

If the Bot already has a private desktop, wait until the Bot and Computer panel are idle. On the VPS, find that Bot's container with `podman ps -a --filter label=io.yharness.vps.session=BOT_SESSION_ID`. Stop the identified container and remove it with `podman rm`. Keep the named volumes. Restart Cloud with the updated profile when its tasks are idle. Opening **Computer** starts Firefox and reconnects the existing workspace and browser profile. Right-click the desktop and choose **Open Firefox** to reopen it.

Firefox can make outbound connections when [network access](#give-a-bots-vps-terminal-internet-access) is enabled. Choose **Take control** to review Firefox's welcome screen the first time and sign in to websites. Browser sign-ins live in the selected Bot's profile volume and survive replacing its container.

For a Firefox-enabled Bot also listed in `botComputers.desktopOnlyBots`, the Bot can pause a direct owner chat to request website sign-in. Choose **Take over**, check the website address, then complete the sign-in or verification in the Computer panel. Once the signed-in page loads, choose **I’m done** to resume the waiting Bot. If you cancel after taking control, clear the sign-in form first. If you close the panel, reopen it and choose **Take over** again to finish. The private Computer remains reserved until you return it, even if the Bot's ten-minute wait ends. Sign-in handoffs end when Cloud restarts.

### Enable an isolated browser for selected Bots

The isolated browser gives each selected Bot a persistent Chromium profile under a separate Linux account. The Bot also has its Linux desktop and existing shell and file workspace. Use a supported, up-to-date Chromium build with working renderer sandboxing and an administrator-owned executable path. On Ubuntu 24.04, Google Chrome at `/opt/google/chrome/chrome` uses Ubuntu's built-in AppArmor profile. Ubuntu's Chromium Snap launcher requires privileges the isolated worker does not have.

From the VPS administrator checkout, install the worker with trusted Node and Chromium binaries. Use `--owner-roster` to follow Cloud’s active owner Bots automatically.

```sh
sudo python3 scripts/setup-vps-browser.py install \
  --node /usr/bin/node --chromium /opt/google/chrome/chrome \
  --cloud-user yharness-cloud --owner-roster
sudo python3 scripts/setup-vps-browser.py activate
```

Add `isolatedBrowser` under `botComputers` in the private Web profile patch.

```yaml
isolatedBrowser:
  socketPath: /run/yharness-browser/control.sock
  bots: []
  ownerRosterPath: /var/lib/yharness-browser-roster/cloud/active.json
```

Every active owner Bot with a private desktop can open its own Browser, including newly created Bots. The automatic roster supports up to 64 Bots and excludes the Firefox selection. Enable shared browsing or automatic Vault sign-in separately for each eligible Bot. The installer keeps profiles assigned through an earlier static list.

To configure only selected Bots, repeat `--grant` for each Bot roster ID and its existing Session ID.

```sh
sudo python3 scripts/setup-vps-browser.py install \
  --node /usr/bin/node --chromium /opt/google/chrome/chrome \
  --cloud-user yharness-cloud \
  --grant bot-worker=bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
sudo python3 scripts/setup-vps-browser.py activate
```

Add `isolatedBrowser` under `botComputers` in the private Web profile patch. Use the same selected Bot roster IDs in the installer and the patch. Remove those IDs from `browser.bots` if they previously used Firefox. Keep their Bot and Session data and existing container volumes.

```yaml
isolatedBrowser:
  socketPath: /run/yharness-browser/control.sock
  bots: [bot-worker]
```

Reload Cloud when its tasks are idle. In the Bot’s **Computer** panel, choose **Browser** to use websites or **Desktop** to use Linux apps. Choose **Take control** to interact with the selected view and **Hand back** before switching. You can also ask the Bot to use either view. Website sign-in requests open the Browser.

For a sign-in or verification step that needs your input, ask the Bot to hand you the Computer from its direct chat. Choose **Take over** and verify the website before entering anything. The Bot and other viewers stop receiving browser frames during the handoff. Choose **I’m done** once the signed-in page loads. If you cancel after taking control, clear the form first.

To update the worker, stop its service and both sockets when idle, then run the install and activate commands from the new release. Use `--owner-roster` for automatic assignments or supply the complete static grant list. Include `--saved-logins` if you use Vault website sign-in. The worker reuses existing Bot browser profiles.

### Approve a saved website login

Use the Mac app's **Workspace → Vault → Websites** to save a login. Enable `--saved-logins` when installing the isolated browser worker and set `botComputers.isolatedBrowser.savedLogins` to `true` in the private Web profile. Both options default to off. The Mac app, Web release, and installed VPS Vault script all need to support saved login approvals.

In a direct Bot chat, ask the Bot to sign in. Open **Approve sign-in** and check the website and destination. Choose a saved login or enter one in the secure form. The request expires after five minutes. Declining or stopping the turn releases the browser.

Select **Save this login to Vault** and add a label to keep an entered login after the form is submitted. Leave the option unchecked for a single submission. The Bot receives the outcome and can check the website. Secure entry requires an updated Mac app and VPS Vault command.

Saved login approval supports a single HTTPS sign-in form that submits to the same website. Sites using single sign-on, passkeys, or unsupported verification forms may require manual sign-in. Removing or replacing a Vault entry prevents use of the old value. Sign out at the website to end an existing browser session.

### Create a website account with Vault

In a direct Cloud Bot chat, ask the Bot to open the website's signup form and request secure signup. Choose **Review signup**, verify the website and destination, and enter the account name and a label for Vault. Vault generates a password, saves it for that Bot, and submits the form. The Bot receives the result.

This works with a same-site HTTPS signup form containing an account field and one or two new-password fields. Check the website after submission. Use the [secure code form](#enter-a-one-time-website-code) when it is available. If the site needs more fields or special verification, take control. The assigned login can be replaced or removed from **Vault → Websites**. Update Desktop, Cloud, the browser worker, and the Vault command together.

### Enter a one-time website code

When a website shows a verification step in a direct Cloud Bot chat, ask the Bot to request secure verification. Choose **Enter code**, confirm the website and destination, and submit your code in the Mac form. The VPS browser sends it once, and the Bot receives the outcome. Vault keeps no copy of the code.

The secure form supports one visible one-time-code field in a same-site HTTPS POST form. Use **Take control** in the Computer panel for passkeys, codes split across several fields, or other verification forms. Update Desktop, Cloud, the browser worker, and the Vault command together.

### Import saved website logins

In the Mac app, open **Workspace → Vault → Websites** and choose **Import CSV…**. Select a password export under 5 MB from 1Password, Chrome, Edge, Safari, Apple Passwords, Firefox, Bitwarden, or LastPass. Review the website and account details and choose **Import** to save the listed personal logins.

The Mac reads the CSV locally. After you confirm, it sends each eligible login over the private Cloud connection and the VPS Vault encrypts it. The review skips duplicate websites and usernames, invalid or unsupported rows, and accounts that exceed the 64 personal login limit. If an import is interrupted, review the file again to retry. Vault checks for duplicates again before each write.

### Let a private routine sign in automatically

In **Workspace → Vault → Websites**, save the website login for the Bot that should use it and turn on **Use automatically** for that account. This requires the standard Cloud Vault broker and updated versions of the Mac app, Cloud, and isolated browser worker. The Bot can use the account on the saved HTTPS website in its direct owner chat and time-based routines, including while the Mac is off.

After setting up Desktop Vault and the isolated browser, run `sudo /usr/local/sbin/yharness-vault enable-login-automation` on the VPS to start the standard broker. Website sign-in setup preserves the existing service key grants.

Vault accepts one automatic account per Bot and website. It sends credentials directly to the private browser. Routines without access report that the owner is needed. Shared chats use the existing owner approval flow.

Turn off automatic sign-in or remove the account to withdraw access. Replacing the account requires turning automatic sign-in on again. Sign out at the website to end a session the browser already opened.

### Let a shared Bot use its browser

Open **Workspace → Vault → Bot access** in Y Harness. Under **Shared browsers**, enable the Bots whose collaborators should be able to browse. The list shows Bots with an isolated browser configured on this VPS. The setting takes effect in existing chats and persists when Cloud restarts. Each private shared chat and each Bot in a shared group has its own browser profile.

Turn off a Bot’s shared browser access to end its current shared browsing and pending sign-ins. Turning access back on starts a fresh browser for each of its shared chats. The Bot’s main chat keeps its own browser.

For a manually managed deployment, pass `--shared-bot BOT_ID` when installing the isolated browser worker and add the same ID to `botComputers.isolatedBrowser.sharedBots` in the private Web profile. A choice saved in **Shared browsers** controls that Bot when the deployment uses the installed Vault and browser worker.

To let a shared Bot sign in, enable saved logins and select the Bot under **Saved for** when you save its website account. When a collaborator asks the Bot to sign in, open the Bot’s main chat in Y Harness and review **Approve shared website sign-in**. Select an account assigned to that Bot for the displayed website. The collaborator sees the outcome in their chat. End any existing sign-in at the website if you revoke the account’s access.

For verification that needs you at the keyboard, open the Bot’s main chat and choose **Take over** on **Sign in to the shared browser**. Check **Current website**, complete the step, and choose **I’m done** once the signed-in page is ready. The Bot resumes in the same browser. Update both Cloud and the isolated browser worker to use this flow.

If you close the panel, return to the card to pick up the same page. Cancelling or timing out closes the browser page and keeps the shared chat’s browser profile.

## Give a Bot access to service diagnostics

Ask the VPS owner to add `vpsServices` inside the same `web-runtime` configuration. The grant names an exact systemd service and the Bot roster IDs that may inspect it. This example grants read access to a service managed by the same Linux user as Y Harness.

```yaml
vpsServices:
  - unit: example-worker.service
    scope: user
    bots: [bot-worker]
```

Restart the Web service when its tasks are idle. The Bot can call `vps_service_status` to read the unit’s state, restart count and last exit details. A `system` grant targets the system manager. The status tool returns selected systemd fields.

To enable a restart request for an exact service, add `restart: true` to its grant. Select **Ask for approval** in that **Cloud** Bot conversation. The owner must accept each restart request, and the Web service account must have Linux permission to restart the unit. Use the VPS administrator’s own login for code changes and other protected maintenance.

## Save credentials for a dedicated service

The VPS Vault stores encrypted API keys for trusted systemd system services. Set up the service with its own explicit `User=` account, separate from the Linux account that runs Cloud. An explicit `User=` also works with `DynamicUser=yes`. The service receives its keys in systemd's private credential directory. A Bot can use its approved service controls while the service handles its own credentials.

Use a trusted administrator login on the VPS. Keep the Linux account that runs Cloud and any accounts used by Bot shells unprivileged. Install the command from your trusted administrator checkout. Replace `CLOUD_USER` with the Cloud account and `example-worker.service` with the exact system service name.

```sh
sudo install -o root -g root -m 0755 scripts/vps-vault.py /usr/local/sbin/yharness-vault
sudo /usr/local/sbin/yharness-vault --cloud-user CLOUD_USER enable example-worker.service
sudo /usr/local/sbin/yharness-vault --cloud-user CLOUD_USER set example-worker.service EXAMPLE_API_KEY
```

Enter the value at the masked terminal prompt. In the service, read `yharness_EXAMPLE_API_KEY` from the directory named by `CREDENTIALS_DIRECTORY`. The Vault lists saved names with `list example-worker.service`. Run `set` again to rotate a key, or `revoke example-worker.service EXAMPLE_API_KEY` to remove it. Save, rotation, and revocation apply the next time you start the target service. If it already used the old key, revoke that key with its issuer to invalidate it there too.

The values are encrypted with the VPS's systemd host key. A replacement VPS needs its own keys entered for the service. [systemd credential documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#Credentials)

### Manage service secrets from the Mac app

Run Cloud under its [dedicated Linux account](#run-cloud-under-a-dedicated-linux-account). As the VPS administrator, allow the SSH account you use to connect from Y Harness to manage the exact services you enabled above. Replace `SSH_OWNER` with that account name.

```sh
sudo /usr/local/sbin/yharness-vault --cloud-user yharness-cloud allow-desktop \
  --owner SSH_OWNER example-worker.service
```

Leave the service names out to open an empty Vault. After enabling a service, rerun `allow-desktop` with the complete list of services that Desktop may manage.

Open **Cloud** and select the lock icon in its title bar. In **API keys**, choose a service, then **Add secret**, **Replace**, or **Revoke**. Enter values in the masked field. The window sends values directly to the VPS Vault over SSH and shows saved names after submission. Values stay outside Cloud chat, Bot tools, and model requests. The selected service loads its current values on its next start.

Run `sudo /usr/local/sbin/yharness-vault deny-desktop` to remove Desktop management access and stop its listener. Stored credentials are available to their services until you revoke them. To grant management to a different SSH account, run `deny-desktop` first, then run `allow-desktop` with the new account.

### Save website logins from the Mac app

Install the current VPS Vault command and update the Mac app. In **Workspace → Vault → Websites**, choose **Add login**. Enter the HTTPS website, a label you can recognize, and the account details. Vault binds each login to that exact HTTPS host and port. The list shows the website and label. To update a login, choose **Replace** and enter the current account details again. Choose **Remove** to delete it from Vault.

Website logins are encrypted on the VPS. You can [approve a saved login](#approve-a-saved-website-login) from a direct Bot chat with the isolated browser enabled.

To assign an account to a particular Bot, select it under **Saved for** when adding the login. Update the isolated browser worker to use these accounts. When the assigned Bot asks for sign-in on that website in your private chat, Vault shows its matching accounts. **Replace** and **Remove** take effect for future sign-in requests. Sign out of the website to clear an existing signed-in session.

### Let a Bot request a key in chat

Update the Mac app and Cloud. Once the service is available in Desktop Vault, open **Workspace → Vault → Bot access**. Choose **Grant access**, then select the bot and service and enter the key name. Grant changes take effect while Cloud is running.

Open that bot’s Cloud chat and ask it to request the key. Choose **Enter key securely** on the card and enter the value in the Mac Vault window. The bot receives the result of the request. The service loads the key on its next start. Use **API keys** in Vault to replace or revoke a saved key.

Choose **Remove access** in **Bot access** to withdraw the bot’s grant and cancel its outstanding requests for that key. To remove the saved key from the service, revoke it from **API keys**.

Administrators can also set grants by SSH. Pass the complete list of grants each time you run `enable-requests`.

```sh
sudo /usr/local/sbin/yharness-vault enable-requests bot-worker/example-worker.service=EXAMPLE_API_KEY
```

Run `sudo /usr/local/sbin/yharness-vault disable-requests` to withdraw all request grants and stop the request listener.

Desktop Vault checks how the running Cloud workspace manages requests before enabling grant controls. Profiles with explicit `web-runtime.vpsVaultRequests.grants` use their configured Bot grants and the matching `UNIT.service=KEY_NAME` Vault entries. Deployments with a custom broker manage access through that broker. To use Desktop Vault grant controls, configure the standard local broker with Vault-managed grants, then restart Cloud when it is idle.

### Let a shared Bot request a key

Open **Workspace → Vault → Bot access**. When granting an exact service and key, choose **Owner and shared chats** under **Available in**. To share an existing grant, choose that setting on its row.

A collaborator can ask the Bot to request the key. Open the Bot’s main chat as the owner and choose **Enter key securely**. Vault verifies the collaborator still has access before saving the key. The configured service loads it on its next start. A collaborator receives the outcome in their own chat. Any connected app used by the Bot still follows its app permissions.

Choose **Owner only** on a grant to stop shared requests and cancel any pending shared approval. To remove the saved key from the service, revoke it under **API keys**.

Administrators can use `share-request-grant` or `unshare-request-grant` on the VPS with the exact `BOT/UNIT.service=KEY_NAME` grant.

### Read a filtered journal feed

If you operate a host-side journal feed, add `vpsJournal` to the same private `web-runtime` configuration. Give the Web service account permission to connect to the socket and list only the managed owner Bots allowed to read its output.

```yaml
vpsJournal:
  socketPath: /run/example-journal.sock
  bots: [bot-worker]
```

The selected Bot can call `vps_service_journal` with no arguments, including with native Codex. The host connects to the socket and reads one bounded JSON response containing `version`, `generatedAt`, `recovery` and `primaryAudit`. The feed operator controls which entries the two arrays contain. The socket stays on the host, and the tool only reads from it.

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

Open **Cloud** and select the lock icon in its title bar. In **API keys**, choose a service, then **Add secret**, **Replace**, or **Revoke**. Enter values in the masked field. The window sends values directly to the VPS Vault over SSH and shows saved names after submission. Values stay outside Cloud chat, Bot tools, and model requests. The selected service loads its current values on its next start.

Run `sudo /usr/local/sbin/yharness-vault deny-desktop` to remove Desktop management access and stop its listener. Stored credentials are available to their services until you revoke them. To grant management to a different SSH account, run `deny-desktop` first, then run `allow-desktop` with the new account.

### Save website logins from the Mac app

Install the current VPS Vault command and update the Mac app. In **Workspace → Vault → Websites**, choose **Add login**. Enter the HTTPS website, a label you can recognize, and the account details. Vault binds each login to that exact HTTPS host and port. The list shows the website and label. To update a login, choose **Replace** and enter the current account details again. Choose **Remove** to delete it from Vault.

Website logins are encrypted on the VPS and available for owner management. Use [Computer panel](#watch-and-control-the-computer) to sign in on a Bot's desktop. Removing a saved login leaves existing website sessions active until you sign out or revoke them with the website.

## Import a Grok Bot export

Create the destination bot in **Cloud → Bots**. Put its version-one Grok Bot export JSON in a private directory on the VPS. From your SSH session, preview the import with the tool included in the Y Harness checkout:

```sh
python3 ~/.yharness-vps/source/scripts/import-grok-bot.py ./grok-bot-export.json --bot "Research Bot"
```

For a file with several bots, add `--source-name` to choose one. Repeat the command with `--apply` to import into the destination bot's existing chat and folder. The tool adds memories and user facts to the bot's memory, installs exported skill definitions in the destination Bot's execution workspace, and creates scheduled routines paused. Managed VPS Bots publish those skill files in their private Computer volume; desktop-only and ordinary Bots retain their existing Host workspace. Open the bot's routine manager to review the timing and resume each routine when ready. The preview lists any routine skill references that lack a definition in the export. App connections, chat transcripts, and event-triggered routines require separate setup.

If a routine references Grok's `box-desktop` skill, copy the [VPS Computer compatibility skill](../../../apps/cli/config/examples/skills/box-desktop/SKILL.md) into `.agents/skills/box-desktop/SKILL.md` in the Bot's execution workspace. For a managed VPS Bot, use its Computer workspace or `podman cp` after identifying the container; for a desktop-only or ordinary Bot, use the Host directory at `~/.yharness-vps/bots/<bot-session-id>`. Select an image-capable model in that Bot’s chat. Test a desktop observation and review any routine that needs network access before resuming it.

## Check the service

On the VPS, run `python3 ~/.local/bin/yharness-vps status`. Setup keeps the source checkout, the working directory, and Y Harness state in separate locations under `~/.yharness-vps`. Provider settings and logs stay in that private directory. Keep the host log private because it contains the sign-in link.

The service restarts after a process failure and loads saved state when it starts. An interrupted task may need your attention. Rerunning setup reuses the installed build and checks its sandbox without interrupting a running service. If setup repairs an existing runner, restart the service when your tasks are idle so it can use the new runner. The service checks the sandbox on every start, including after a new checkout replaces the old one. On Ubuntu 24.04 it requires working Bubblewrap. If the check fails, run setup again to repair it.
