/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@yharness/settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @yharness/api-settings-controller/types
 */

declare module '@yharness/typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /** A connector action change could not be applied. */
    'settings/mcp-action-rejected': Record<string, never>
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Workspace connector actions, including actions currently disabled. */
export interface McpActionServerView {
  /** The configured, user-visible connector name. */
  readonly serverName: string
  /** Whether the connector currently has a live connection. */
  readonly connected: boolean
  /** Whether this profile can change action access. */
  readonly editable: boolean
  /** Last discovered raw action names, with their configured access. */
  readonly actions: readonly {
    readonly name: string
    readonly description?: string
    readonly enabled: boolean
  }[]
}
