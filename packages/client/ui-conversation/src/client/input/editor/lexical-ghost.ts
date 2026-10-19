/**
 * Lexical binding for ghost prediction: keeps one GhostPredictionNode in
 * sync with the controller and accepts on Tab/ArrowRight ahead of menu
 * arbitration.
 *
 * Ordering contract: register this BEFORE registerComposerKeymap on the same
 * editor. Both hook KEY_TAB_COMMAND at CRITICAL priority; Lexical runs same-
 * priority handlers in registration order, so the ghost gets first refusal.
 * Returning false falls through to the existing Tab/menu behavior, preserving
 * native focus traversal when no ghost is live.
 *
 * Accept keys are Tab and ArrowRight with no modifiers. Enter is deliberately
 * excluded: on an empty draft Enter may steer the queue or submit.
 */
import type { LexicalEditor } from 'lexical'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isParagraphNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical'
import { mergeRegister } from '@lexical/utils'
import type { GhostPredictionController } from './ghost-prediction.ts'
import {
  $createGhostPredictionNode,
  $isGhostPredictionNode,
  findGhostNode,
} from './ghost-node.tsx'

/** Live reads the binding needs from the view shell. */
export interface GhostBindingDeps {
  /** True while an IME composition is in flight (keyCode 229 included). */
  isComposing(): boolean
  /** True while a trigger menu or other overlay owns the gesture. */
  hasCompetingUi(): boolean
}

/**
 * Whether a Tab/ArrowRight keydown may accept the ghost: no modifiers,
 * no composition (Safari may deliver the closing keydown after
 * compositionend with keyCode 229 and no isComposing flag).
 * @param event - the keydown payload.
 */
function isCleanAcceptGesture(event: KeyboardEvent | null): boolean {
  if (event === null) return false
  return !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.isComposing
    && event.keyCode !== 229
}

/**
 * Sync the ghost decorator with controller state: insert when the ghost may
 * show and no node exists, refresh text on prediction change, remove when
 * the draft is non-empty or the prediction clears. Runs inside the editor's
 * update listener, so it never fights user edits.
 * @param editor - the shell-owned editor.
 * @param controller - the session ghost controller.
 */
function syncGhostNode(editor: LexicalEditor, controller: GhostPredictionController): void {
  editor.getEditorState().read(() => {
    const root = $getRoot()
    const children = root.getChildren()
    const ghost = findGhostNode(children)
    // Any real content hides the ghost: typing wins over the suggestion and
    // the prediction itself is kept, so clearing back to empty re-shows it.
    const hasRealContent = children.some(
      child => !$isGhostPredictionNode(child) && child.getTextContentSize() > 0,
    )
    if (hasRealContent) {
      if (ghost !== null) {
        editor.update(() => { ghost.remove() }, { discrete: true })
      }
      return
    }
    const prediction = controller.current
    const live = prediction !== null && prediction.text !== ''
    if (!live) {
      if (ghost !== null) {
        editor.update(() => { ghost.remove() }, { discrete: true })
      }
      return
    }
    if (ghost !== null && ghost.getPredictionId() === prediction.id) {
      controller.markShown()
      return
    }
    editor.update(() => {
      const fresh = $getRoot()
      const old = findGhostNode(fresh.getChildren())
      old?.remove()
      // Anchor under an empty single paragraph; if the user typed since the
      // read, the emptiness guard below refuses (no ghost on non-empty).
      const children = fresh.getChildren()
      if (children.length === 1 && $isParagraphNode(children[0]) && children[0].getTextContent() === '') {
        fresh.append($createGhostPredictionNode(prediction.id, prediction.text))
        controller.markShown()
      }
    }, { discrete: true })
  })
}

/**
 * Register ghost prediction on one editor.
 * @param editor - the shell-owned editor.
 * @param controller - the session ghost controller.
 * @param deps - live view reads (composition, competing UI).
 * @returns the unregister disposer.
 */
export function registerGhostPrediction(
  editor: LexicalEditor,
  controller: GhostPredictionController,
  deps: GhostBindingDeps,
): () => void {
  const accept = (event: KeyboardEvent | null): boolean => {
    if (!isCleanAcceptGesture(event)) return false
    if (deps.isComposing()) return false
    if (deps.hasCompetingUi()) return false
    if (!controller.mayShow(false)) return false
    // Re-check inside the update: the decorator sync guarantees emptiness,
    // but a race with typing must not eat a keystroke.
    let accepted: string | null = null
    editor.update(() => {
      const root = $getRoot()
      const ghost = findGhostNode(root.getChildren())
      if (ghost === null) return
      const children = root.getChildren()
      if (children.length !== 2) return
      accepted = controller.accept()
      if (accepted !== null) {
        const lines = accepted.split('\n')
        root.clear()
        for (const line of lines) {
          const paragraph = $createParagraphNode()
          if (line !== '') paragraph.append($createTextNode(line))
          root.append(paragraph)
        }
        root.selectEnd()
      }
    }, { discrete: true })
    if (accepted !== null) {
      event?.preventDefault()
      event?.stopPropagation()
      return true
    }
    return false
  }

  return mergeRegister(
    editor.registerCommand(KEY_TAB_COMMAND, accept, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, accept, COMMAND_PRIORITY_CRITICAL),
    editor.registerUpdateListener(() => {
      syncGhostNode(editor, controller)
    }),
  )
}
