/**
 * Stage one of this package's registration: what the `files` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page offers
 * it as an entry box, and the tree opens files through `tabActions.openResource`
 * for the `dsh-resource://file` viewers to claim.
 */
import type { ShortcutCommandId } from '@yharness/client-shortcuts/client'
import type { SidebarRightTabDefinition } from '@yharness/client-ui-sidebar-right/client'
import type { TranslateNS } from '@yharness/client-locale/client'
import type {} from './locales.ts'
import { GuideArtworkFiles } from '@yharness/client-ui-primitives'

/** The tab kind this package owns. */
export const FILES_KIND = 'files'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const FILES_ID = '@yharness/client-ui-sidebar-files'

/** The tab kind for a private Bot Computer workspace. */
export const COMPUTER_FILES_KIND = 'computer-files'

/**
 * The files type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @param computer - register the private Computer file tree.
 * @returns the definition to register.
 */
export function filesDefinition(t: TranslateNS<'sidebarFiles'>, computer = false): SidebarRightTabDefinition {
  return {
    id: computer ? `${FILES_ID}/computer` : FILES_ID,
    kind: computer ? COMPUTER_FILES_KIND : FILES_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: computer ? [] : [{
      id: 'workspace',
      commandId: 'workspace.files' as ShortcutCommandId,
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkFiles,
    }],
  }
}
