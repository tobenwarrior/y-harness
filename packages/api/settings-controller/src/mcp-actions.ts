/** Owner configuration operations for discovered connector actions. */
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/config-editor'
import type { McpActionCatalog } from '@yharness/mcp-client'
import { RemoteError } from '@yharness/typert-protocol'
import { z } from 'zod'
import type { McpActionServerView } from './types.ts'

const actionChange = z.object({
  serverName: z.string().min(1),
  actionName: z.string().min(1),
  enabled: z.boolean(),
})

function configuredCatalog(ctx: Context): Map<string, McpActionCatalog> {
  const catalogs = new Map<string, McpActionCatalog>()
  ctx.emit('mcp/actions/catalog', (catalog) => { catalogs.set(catalog.serverName, catalog) })
  return catalogs
}

function configurableDisabledNames(value: unknown): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(name => typeof name === 'string' && name.length > 0))
}

function configurableEntry(ctx: Context, catalog: McpActionCatalog) {
  return ctx.get('configEditor')?.entries().find(({ id, options, fiber }) => {
    if (id !== catalog.entryId || fiber === undefined) return false
    if (typeof options.config !== 'object' || options.config === null) return false
    return Reflect.get(options.config, 'serverName') === catalog.serverName
      && configurableDisabledNames(Reflect.get(options.config, 'disabledTools'))
  })
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'The connector change was cancelled.', {})
}

function unavailable(): RemoteError<'settings/mcp-action-rejected'> {
  return new RemoteError('settings/mcp-action-rejected', 'This connector action cannot be changed here.', {})
}

/** List the redacted action catalog for the workspace owner's connector settings.
 * @param ctx - Host context containing the active connector entries.
 * @returns Connector names, discovery state, and their visible actions.
 */
export function listMcpActions(ctx: Context): McpActionServerView[] {
  return [...configuredCatalog(ctx).values()].sort((a, b) => a.serverName.localeCompare(b.serverName)).map(catalog => ({
    serverName: catalog.serverName,
    connected: catalog.connected,
    editable: catalog.connected && configurableEntry(ctx, catalog) !== undefined,
    actions: catalog.actions.map(({ name, description, enabled }) => ({
      name, ...(description === undefined ? {} : { description }), enabled,
    })),
  }))
}

/** Write one action's configuration through the profile editor.
 * @param ctx - Host context containing the active connector and profile editor.
 * @param serverName - Configured connector name from the owner catalog.
 * @param actionName - Exact discovered name advertised by that connector.
 * @param enabled - Whether the action should be available.
 * @param signal - Caller cancellation for the profile edit.
 * @returns Fresh connector action views after reconciliation.
 */
export async function setMcpActionEnabled(
  ctx: Context,
  serverName: string,
  actionName: string,
  enabled: boolean,
  signal: AbortSignal,
): Promise<McpActionServerView[]> {
  const change = actionChange.safeParse({ serverName, actionName, enabled })
  if (!change.success) throw new RemoteError('gateway/bad-request', 'The connector action change is invalid.', {})
  cancelled(signal)
  const catalog = configuredCatalog(ctx).get(change.data.serverName)
  const editor = ctx.get('configEditor')
  if (catalog?.connected !== true || editor === undefined) throw unavailable()
  const entry = configurableEntry(ctx, catalog)
  const action = catalog.actions.find(candidate => candidate.name === change.data.actionName)
  if (entry === undefined || action === undefined) throw unavailable()
  try {
    await editor.edit(entry, (current, inherited) => {
      const disabledNames = current.disabledTools
      if (current.serverName !== change.data.serverName || !configurableDisabledNames(disabledNames)) throw unavailable()
      const latest = configuredCatalog(ctx).get(change.data.serverName)
      if (latest?.connected !== true || latest.entryId !== catalog.entryId
        || !latest.actions.some(candidate => candidate.name === change.data.actionName)) throw unavailable()
      const names = new Set(disabledNames)
      if (change.data.enabled) names.delete(change.data.actionName)
      else names.add(change.data.actionName)
      if (names.size === 0 && inherited.disabledTools === undefined) {
        const next = { ...current }
        delete next.disabledTools
        return next
      }
      return { ...current, disabledTools: [...names] }
    }, signal)
  } catch (error: unknown) {
    cancelled(signal)
    throw new RemoteError('settings/mcp-action-rejected', 'Could not save the connector action change.', {}, { cause: error })
  }
  return listMcpActions(ctx)
}
