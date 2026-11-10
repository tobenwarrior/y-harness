# Use the Web UI

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Let a bot use your Mac

In the Mac workspace, choose **Bots**, open a bot, and select **Computer**. Open the two permission pages from the panel. Enable Y Harness under **Screen & System Audio Recording** for screenshots and **Device Control and Data Access** for mouse and keyboard input. Earlier macOS versions call the second permission **Accessibility**. Reopen Y Harness if macOS asks, then choose **Share this Mac** and confirm.

Type **@Computer** in the bot composer and select **Computer** to open the panel and include it in your request. Use a model that accepts images. While sharing, the bot can observe and control your primary display. The panel shows its activity. Choose **Take control** to pause the bot and use your Mac directly, or **Hand back** to resume bot input. **Stop sharing**, closing the panel, switching to Cloud, or locking the Mac ends access. Screenshots requested by the bot are sent to its model and saved with the chat.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Run Y Harness on your VPS](./vps.md)
- [Publish the Web UI behind a reverse proxy](./public-deployments.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)
