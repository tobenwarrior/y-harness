# Connect a GitHub account

1. Register a GitHub App, enable **Device Flow**, and install the app on the repositories you want to use. Choose the repository permissions the Bots need. [GitHub App setup](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
2. Set `YH_GITHUB_APP_CLIENT_ID` in the Y Harness Host environment to the app's public **Client ID**. On a VPS, use the environment of the persistent Y Harness service.
3. Add [`github-account.cordis.yml`](github-account.cordis.yml) to the Host profile's `cordis.patch.yml`. If the profile uses the GitHub token overlay, replace that overlay with this one to keep the same `github` app ID and Bot permissions.
4. Open **App access** on a Bot, choose **Connect GitHub**, and enter the displayed code on GitHub. Review the app's permissions on GitHub before authorizing it.
5. Return to Y Harness and grant GitHub access to the Bots that should use the account. Choose **Disconnect** to remove the Host's saved login.

To try the overlay on a development checkout, run `pnpm dsh web --patch apps/cli/config/examples/mcp-connectors/github-account.cordis.yml` with `YH_GITHUB_APP_CLIENT_ID` set. The example keeps repository, issue, and pull request tools read-only. To enable other GitHub tools, edit `X-MCP-Toolsets` and `X-MCP-Readonly` in the overlay and give the registered GitHub App the corresponding repository permissions. [Device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token) · [GitHub MCP configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
