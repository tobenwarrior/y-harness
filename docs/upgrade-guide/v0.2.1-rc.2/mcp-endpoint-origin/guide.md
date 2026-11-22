---
kind: upgrade-guide
description: Streamable HTTP MCP servers that redirect to a different origin need the final endpoint URL in their configuration.
---

# Configure the final MCP endpoint URL

## Change

Streamable HTTP MCP configurations could previously follow a redirect to a different origin. The updated transport keeps requests on the configured origin. This affects configurations whose MCP endpoint redirects to another host, port, or scheme.

## Migration

1. Get the final endpoint URL from the MCP service operator.
2. Set `config.url` on the `@yharness/mcp-client` entry in your profile's `cordis.patch.yml` to that URL.
3. Reload the profile and confirm the connector's tools appear. Run a read-only tool to verify the connection.
