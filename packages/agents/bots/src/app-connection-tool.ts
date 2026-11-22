/** Connection requests from the direct Bot scope. */
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/github-app-auth'
import type { McpActionCatalog } from '@yharness/mcp-client'
import { defineTool, type InferValue, type ToolDefinition } from '@yharness/tools'

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    appId: { type: 'string', required: true, const: 'github' },
    status: { type: 'string', required: true, enum: ['sign-in-required', 'connected', 'unavailable'] },
  },
} as const

function hasGitHubAppConnector(ctx: Context): boolean {
  let configured = false
  ctx.emit('mcp/actions/catalog', (catalog: McpActionCatalog) => {
    if (catalog.authKind === 'github-app') configured = true
  })
  return configured
}

/**
 * Create the read-only request that offers GitHub sign-in to a Bot's owner.
 * @param scope - the direct Bot tool scope.
 * @returns the tool when the Host provides GitHub App authorization.
 */
export function createAppConnectionTool(scope: Context): ToolDefinition | undefined {
  if (scope.get('githubAppAuth') === undefined) return undefined
  return defineTool({
    name: 'request_app_connection',
    description: 'Check GitHub connection status and offer the owner a Connect button if needed. Only the owner can start sign-in.',
    parameters: {
      appId: { type: 'string', required: true, const: 'github' },
    },
    output: {
      schema: resultSchema,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => value.status === 'sign-in-required'
        ? { appId: value.appId, status: value.status }
        : null,
    },
    async execute(): Promise<InferValue<typeof resultSchema>> {
      const auth = scope.get('githubAppAuth')
      if (auth === undefined || !hasGitHubAppConnector(scope)) return { appId: 'github', status: 'unavailable' }
      try {
        const status = await auth.status()
        return { appId: 'github', status: status === 'connected' ? 'connected' : 'sign-in-required' }
      } catch (_error) {
        return { appId: 'github', status: 'unavailable' }
      }
    },
  })
}
