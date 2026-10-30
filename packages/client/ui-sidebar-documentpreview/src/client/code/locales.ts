/** Locale-owned code renderer name and CodeBlock controls. */
import type {} from '@yharness/client-ui-slots'

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Code document implementation name and copy controls. */
    sidebarCodePreview: keyof typeof en
  }
}

/** English dictionary for this namespace. */

/** English dictionary with the same keys. */
export const en = {
  title: 'Code',
  copy: 'Copy',
  copied: 'Copied',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
