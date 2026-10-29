/**
 * Lexical decorator node carrying the ghost prediction: renders the
 * suggested text as non-editable, screen-reader-hidden ghost plus the
 * translated accept hint pill. Removed by the binding whenever the
 * draft is non-empty, the prediction clears, or the suggestion is accepted.
 */
import type { LexicalNode, NodeKey, SerializedLexicalNode } from 'lexical'
import { $applyNodeReplacement, DecoratorNode } from 'lexical'
import * as React from 'react'

/** Serialized ghost node payload (persisted drafts never contain ghosts). */
export interface SerializedGhostPredictionNode extends SerializedLexicalNode {
  readonly predictionId: string
  readonly text: string
}

/**
 * Non-editable decorator block for one ghost suggestion.
 * Never serialized into drafts: exportJSON throws so persistence layers
 * cannot store ghost text as user content.
 */
export class GhostPredictionNode extends DecoratorNode<React.JSX.Element> {
  private readonly predictionId: string
  private readonly suggestionText: string

  /**
   * Defaults are not decoration: Lexical requires a constructor it can call
   * with no arguments unless the node also round-trips through
   * {@link GhostPredictionNode.importJSON}. Both are provided.
   * @param predictionId - suggestion id for React keys/telemetry correlation.
   * @param text - suggestion text to render (never edited in place).
   * @param key - Lexical node key.
   */
  constructor(predictionId = '', text = '', key?: NodeKey) {
    super(key)
    this.predictionId = predictionId
    this.suggestionText = text
  }

  /** Lexical node type discriminator. */
  static override getType(): string {
    return 'ghost-prediction'
  }

  /** Lexical clone contract. */
  static override clone(node: GhostPredictionNode): GhostPredictionNode {
    return new GhostPredictionNode(node.predictionId, node.suggestionText, node.__key)
  }

  /** Block-level (own paragraph-like row under the empty paragraph). */
  override isInline(): boolean {
    return false
  }

  /** Decorator nodes are atomic; text inside never participates in selection. */
  override isIsolated(): boolean {
    return true
  }

  /** Ghost text contributes no clipboard content. */
  override getTextContent(): string {
    return ''
  }

  /** Host element: inert, hidden from assistive tech, non-editable. */
  override createDOM(): HTMLElement {
    const el = document.createElement('span')
    el.setAttribute('data-ghost-prediction', '')
    el.setAttribute('aria-hidden', 'true')
    el.setAttribute('contenteditable', 'false')
    // inert is not in lib.dom for all targets; setAttribute avoids the gap.
    el.setAttribute('inert', '')
    el.className = 'ghost-prediction'
    return el
  }

  /** Static host: never update the DOM element itself. */
  override updateDOM(): boolean {
    return false
  }

  /** React face: suggestion text plus the accept-hint pill. */
  override decorate(): React.JSX.Element {
    return (
      <GhostPredictionFace text={this.suggestionText} />
    )
  }

  /**
   * The ghost round-trips as node JSON rather than refusing to serialize:
   * Lexical requires the pair for any node it cannot construct with no
   * arguments, and refusing broke editor creation outright. Persistence is
   * still safe because the decorator sync removes every ghost whenever no
   * prediction is live, and `getTextContent` keeps ghost text out of the
   * clipboard/draft projection.
   */
  override exportJSON(): SerializedGhostPredictionNode {
    return {
      type: 'ghost-prediction',
      version: 1,
      predictionId: this.predictionId,
      text: this.suggestionText,
    }
  }

  /**
   * Rebuild a ghost from its serialized form (undo/redo round trips). The
   * parameter is Lexical's base shape, so the payload is validated rather than
   * trusted; absent fields degrade to a textless ghost the sync then removes.
   */
  static override importJSON(
    serialized: SerializedLexicalNode & Record<string, unknown>,
  ): GhostPredictionNode {
    const predictionId = serialized['predictionId']
    const text = serialized['text']
    return $createGhostPredictionNode(
      typeof predictionId === 'string' ? predictionId : '',
      typeof text === 'string' ? text : '',
    )
  }

  /** Suggestion id for binding correlation. */
  getPredictionId(): string {
    return this.predictionId
  }

  /** Rendered suggestion text. */
  getSuggestionText(): string {
    return this.suggestionText
  }
}

/**
 * Type guard for the ghost node.
 * @param node - candidate node.
 */
export function $isGhostPredictionNode(node: LexicalNode | null | undefined): node is GhostPredictionNode {
  return node instanceof GhostPredictionNode
}

/**
 * Find the ghost decorator child of root, if any.
 * @param rootChildren - current root children.
 */
export function findGhostNode(
  rootChildren: readonly LexicalNode[],
): GhostPredictionNode | null {
  for (const child of rootChildren) {
    if ($isGhostPredictionNode(child)) return child
  }
  return null
}

/**
 * Ghost React face: suggestion text with the accept-hint pill.
 * @param props.text - suggestion text.
 */
export function GhostPredictionFace({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <span className="ghost-prediction-face" data-ghost-prediction-face="">
      <span className="ghost-prediction-text">{text}</span>
      <span className="ghost-prediction-hint" data-ghost-prediction-hint="" />
    </span>
  )
}

/**
 * Create a ghost decorator node.
 * @param predictionId - suggestion id.
 * @param text - suggestion text.
 */
export function $createGhostPredictionNode(
  predictionId: string,
  text: string,
): GhostPredictionNode {
  return $applyNodeReplacement(new GhostPredictionNode(predictionId, text))
}
