/** Render-snapshot callbacks for deliberate skill confirmation and selection. */
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryFace } from './controller.ts'

/**
 * Bind the displayed confirmation without issuing an action when it is absent.
 * @param action - operation shown in the current confirmation dialog.
 * @param item - source metadata displayed by the current detail pane.
 * @param act - hash-bound source operation owned by the controller.
 * @param close - close the confirmation after the operation is requested.
 * @returns the confirmation callback for this render snapshot.
 */
export function createSkillConfirmationHandler(action: 'adopt' | 'archive' | null, item: SkillLibraryItem,
  act: SkillLibraryFace['act'], close: () => void): () => void {
  return () => {
    if (action !== null) { act(action, item); close() }
  }
}

/**
 * Bind graph selection to the inventory displayed by the current panel.
 * @param inventory - current source metadata, or null before its first read.
 * @param select - open a source whose identity resolves in the displayed inventory.
 * @returns a selection callback that ignores absent identities.
 */
export function createSkillSelectionHandler(inventory: SkillLibraryList | null,
  select: (item: SkillLibraryItem) => void): (id: SkillLibraryId) => void {
  return (id) => {
    const item = inventory?.items.find(candidate => candidate.id === id)
    if (item !== undefined) select(item)
  }
}
