/** `settings.theme` namespace dictionaries for the Appearance section. */

/** English dictionary for this namespace. */

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  'section.title': 'Appearance',
  'style.title': 'Style',
  'style.default': 'Default',
  'style.terminal': 'Terminal',
  'style.description': 'Terminal uses compact controls and monospace labels. Conversation text keeps its current font.',
  'style.preview.workspace': 'Workspace',
  'style.preview.conversation': 'Conversation',
  'style.preview.ready': 'Ready',
  'style.preview.composer': 'Describe a task',
  'appearance.title': 'Color mode',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
