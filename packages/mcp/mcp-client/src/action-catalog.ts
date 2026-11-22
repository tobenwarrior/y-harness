/**
 * Host discovery projection for configured MCP actions.
 *
 * The projection is deliberately separate from model-facing public tool names:
 * settings consumers need the exact raw names returned by the remote server,
 * including names that are disabled or cannot be normalized into a model name.
 *
 * @module @yharness/mcp-client
 */

import type { Context } from '@yharness/cordis'
import { scopeOf } from '@yharness/scope'

declare module '@yharness/cordis' {
  interface Events {
    /**
     * Synchronously read action catalogs from eligible loader-owned MCP plugins.
     * @param accept - callback receiving one server's current action catalog.
     * @mode emit
     */
    'mcp/actions/catalog'(accept: (catalog: McpActionCatalog) => void): void
  }
}

/** A bounded description size for the host discovery surface. */
const MAX_ACTION_DESCRIPTION_LENGTH = 4_096

/** Last discovered MCP actions and their current connection state. */
export interface McpActionCatalog {
  /** Configured server namespace. */
  readonly serverName: string
  /** Full loader entry identity owning this configured plugin. */
  readonly entryId: string
  /** Whether the last discovered generation is currently connected. */
  readonly connected: boolean
  /** Exact raw MCP action names and their local enabled state. */
  readonly actions: readonly {
    /** Exact name returned by the remote MCP server. */
    readonly name: string
    /** Bounded remote description, when one was advertised. */
    readonly description?: string
    /** Whether this action is currently allowed by local configuration. */
    readonly enabled: boolean
  }[]
}

/** One discovered action before it is retained by the catalog state. */
export type McpActionCatalogAction = McpActionCatalog['actions'][number]

/** Mutable connection-owned catalog state kept private to the MCP supervisor. */
export interface McpActionCatalogState {
  /** Replace the last successful raw discovery. */
  discovered(actions: readonly McpActionCatalogAction[]): void
  /** Mark the retained discovery as connected or stale. */
  setConnected(connected: boolean): void
  /** Return an isolated snapshot for a reader. */
  snapshot(): McpActionCatalog
}

/** Create one connection-owned action catalog state.
 * @param serverName - Configured MCP server namespace.
 * @param entryId - Full loader entry identity owning the connector.
 * @returns Mutable state for the connection supervisor's Host projection.
 */
export function createMcpActionCatalog(serverName: string, entryId: string): McpActionCatalogState {
  let connected = false
  let actions: readonly McpActionCatalogAction[] = []
  return {
    discovered(next) {
      actions = next.map((action) => {
        const description = boundedDescription(action.description)
        return description === undefined
          ? { name: action.name, enabled: action.enabled }
          : { name: action.name, description, enabled: action.enabled }
      })
    },
    setConnected(next) {
      connected = next
    },
    snapshot() {
      return {
        serverName,
        entryId,
        connected,
        actions: actions.map(action => ({ ...action })),
      }
    },
  }
}

/**
 * Return the full loader entry id for an unscoped plugin context.
 *
 * The loader is optional for this package, so this structural read avoids a
 * runtime dependency on the loader package while still excluding manually
 * mounted and scoped MCP instances from the Host catalog.
 * @param ctx - Context whose fiber may be owned by the loader.
 * @returns The full loader entry id, or `undefined` for an ineligible context.
 */
export function loaderEntryId(ctx: Context): string | undefined {
  if (scopeOf(ctx) !== undefined) return undefined
  const fiber = ctx.fiber as { readonly entry?: { readonly id?: unknown } }
  const entry = fiber.entry
  if (entry === undefined) return undefined
  const id = entry.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Register a synchronous catalog reader owned by one eligible MCP plugin.
 * @param ctx - Context that owns the event listener.
 * @param read - Callback returning the connection's current catalog.
 * @returns Nothing. The listener is disposed with the owning context.
 */
export function registerMcpActionCatalogReader(
  ctx: Context,
  read: () => McpActionCatalog | undefined,
): void {
  ctx.on('mcp/actions/catalog', (accept: (catalog: McpActionCatalog) => void) => {
    const catalog = read()
    if (catalog !== undefined) accept(catalog)
  })
}

/** Bound description text without changing exact raw action names. */
function boundedDescription(description: string | undefined): string | undefined {
  if (description === undefined || description.length === 0) return undefined
  return description.length <= MAX_ACTION_DESCRIPTION_LENGTH
    ? description
    : description.slice(0, MAX_ACTION_DESCRIPTION_LENGTH)
}
