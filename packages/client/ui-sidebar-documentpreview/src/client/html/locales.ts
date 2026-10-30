/** Locale-owned HTML implementation name and iframe status text. */

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  title: 'HTML',
  frame: 'HTML document preview',
  loading: 'Rendering document...',
  failed: 'This HTML document could not be previewed.',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview selection and status text. */
    documentHtml: HtmlPreviewKey
  }
}
