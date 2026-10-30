/** Locale dictionary for the Compound code-map panel. */

export const en = {
  panel: 'Code map',
  title: 'Compound code map',
  frameTitle: 'Compound code map for this workspace',
  reload: 'Reload the map',
  hint: 'The map is served by this Y Harness build; the graph and the source previews stay on this machine.',
  unavailable: 'The code map could not be loaded. A deployment needs Python 3.11+ so the vendored service can start.',
} as const

/** Compatibility export for the retired locale name. */
export const zh = en

/** Keys owned by the code-map dictionary. */
export type CompoundMapKey = keyof typeof en

/** English dictionary for this namespace. */
