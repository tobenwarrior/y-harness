/** Markdown implementation labels and primitive chrome. */

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof en

/** English labels. */
export const en = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown document renderer and its code/footnote controls. */
    documentMarkdown: MarkdownPreviewKey
  }
}
