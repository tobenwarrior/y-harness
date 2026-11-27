/**
 * Pure types of the permission domain: the ONE home of the `permissions`
 * projection-key declaration plus its payload types, free of this package's
 * host-side value imports (cordis, schemastery). Two namespace projections
 * serve it — the package root re-export for host consumers, `./client` (the
 * browser half-entry's re-export) for client aggregates — with zero content
 * duplication.
 *
 * @module @yharness/permission-presets/types
 */

/** Presentation for an available preset or the derived `custom` current value. */
export interface PresetOption {
  /** Stable option value: a configured preset key, live `auto`, or derived `custom`. */
  value: string
  /** The display label. */
  name: string
  /** One user-facing sentence on what the value means; omitted when not configured. */
  description?: string
  /** A configured preset that grants unrestricted access. */
  unrestricted?: true
}

/**
 * Process-level permission catalog. It changes with live contributions and is
 * deliberately separate from Session history.
 */
export interface PermissionCatalog {
  /** Every currently selectable preset, in contribution order. */
  options: PresetOption[]
  /** Configured presets eligible as defaults for future sessions. */
  defaultOptions: PresetOption[]
  /** Effective default when the Config field is omitted. */
  defaultPreset: string
  /** Explicit shared preset for private chats, or null until the owner selects one. */
  sharedPreset?: string | null
}

/**
 * Identify an ordinary chat created or forked by the interactive Session controller.
 * @param id - Session identity.
 * @returns whether the id belongs to the interactive chat namespace.
 */
export function isInteractivePermissionChat(id: string): boolean {
  return id.startsWith('session-')
}

/** Whole `permissions` Session projection: current durable selection only. */
export interface PermissionSelection {
  /** The effective current value: a configured preset key, `auto`, or `custom`. */
  currentValue: string
}

declare module '@yharness/cordis' {
  interface Events {
    /**
     * The selectable process catalog changed. Payload-free by design:
     * consumers subscribe first, then re-read the complete catalog.
     * @mode emit
     */
    'permission-presets/catalog-changed'(): void
  }
}

declare module '@yharness/session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current permission, folded from the three whole-value
     * knob events (`permission/preset`, `sandbox/mode`, `approval/policy`)
     * over the composition defaults. Selectable options come from the
     * process-level catalog Remote. Key absence means no permission service
     * is composed — clients hide the control.
     */
    permissions: PermissionSelection
  }
}
