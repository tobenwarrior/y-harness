/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** English dictionary for this namespace. */

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
  'mode.label': 'Workspace mode',
  'mode.code': 'Code',
  'mode.bots': 'Bots',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
