/** Localized labels for the NodeJS Inspector bottom panel and command. */
export const zh = {
  title: 'NodeJS Inspector',
  toggle: 'Toggle NodeJS Inspector',
  close: 'Collapse',
  resize: 'Resize NodeJS Inspector panel',
  frameTitle: 'NodeJS Inspector',
}

/** English labels checked against the bottom-panel dictionary. */
export const en: Record<keyof typeof zh, string> = {
  title: 'NodeJS Inspector',
  toggle: 'Toggle NodeJS Inspector',
  close: 'Collapse',
  resize: 'Resize NodeJS Inspector panel',
  frameTitle: 'NodeJS Inspector',
}

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared Inspector frontend copy. */
    inspectorPanel: keyof typeof zh
  }
}
