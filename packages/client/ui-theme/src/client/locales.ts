/** `settings.theme` namespace dictionaries for the Appearance section. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'section.title': '外观',
  'style.title': '风格',
  'style.default': '默认',
  'style.terminal': '终端',
  'style.description': '终端风格使用紧凑控件与等宽标签，会话文本保持原有字体',
  'style.preview.workspace': '工作区',
  'style.preview.conversation': '会话',
  'style.preview.ready': '就绪',
  'style.preview.composer': '描述任务',
  'appearance.title': '颜色模式',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
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
} satisfies Record<ThemeKey, string>
