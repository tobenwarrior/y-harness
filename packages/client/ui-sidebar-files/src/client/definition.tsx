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

/** The tab kind for a shared Bot Computer workspace. */
export const COMPUTER_SHARED_FILES_KIND = 'computer-shared-files'

/** Computer workspace variants accepted by the files definition. */
export type ComputerFilesMode = 'private' | 'shared'

/**
 * The files type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @param computer - register a private or shared Computer file tree.
 * @returns the definition to register.
 */
export function filesDefinition(
  t: TranslateNS<'sidebarFiles'>,
  computer: boolean | ComputerFilesMode = false,
): SidebarRightTabDefinition {
  const shared = computer === 'shared'
  const isComputer = computer === true || computer === 'private' || shared
  const kind = shared ? COMPUTER_SHARED_FILES_KIND : isComputer ? COMPUTER_FILES_KIND : FILES_KIND
  const id = shared ? `${FILES_ID}/${COMPUTER_SHARED_FILES_KIND}` : computer === true || computer === 'private' ? `${FILES_ID}/computer` : FILES_ID
  return {
    id,
    kind,
    priority: 'builtin',
    title: () => t(shared ? 'sharedType.label' : 'type.label'),
    guide: isComputer ? [] : [{
      id: 'workspace',
      commandId: 'workspace.files' as ShortcutCommandId,
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkFiles,
    }],
  }
}
