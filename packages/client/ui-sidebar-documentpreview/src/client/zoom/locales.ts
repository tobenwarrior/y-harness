/** Shared zoom copy embedded into renderer-owned dictionaries. */

/** Shared English zoom copy. */
export const zoomEn = {
  zoomControls: 'Zoom controls',
  zoomMenu: 'Choose zoom',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  zoomFitWidth: 'Fit width',
  zoomValue: '{percent}%',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zoomZh = zoomEn

/** Shared zoom dictionary keys. */
export type ZoomLocaleKey = keyof typeof zoomEn
