/**
 * Lexical decorator node carrying the ghost prediction: renders the
 * suggested text as non-editable, screen-reader-hidden ghost plus the
 * "Press Tab to accept" hint pill. Removed by the binding whenever the
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
   * @param predictionId - suggestion id for React keys/telemetry correlation.
   * @param text - suggestion text to render (never edited in place).
   * @param key - Lexical node key.
   */
  constructor(predictionId: string, text: string, key?: NodeKey) {
    super(key)
    this.predictionId = predictionId
    this.suggestionText = text
  }

  /** Lexical node type discriminator. */
  static getType(): string {
    return 'ghost-prediction'
  }

  /** Lexical clone contract. */
  static clone(node: GhostPredictionNode): GhostPredictionNode {
    return new GhostPredictionNode(node.predictionId, node.suggestionText, node.__key)
  }

  /** Block-level (own paragraph-like row under the empty paragraph). */
  isInline(): boolean {
    return false
  }

  /** Decorator nodes are atomic; text inside never participates in selection. */
  isIsolated(): boolean {
    return true
  }

  /** Ghost text contributes no clipboard content. */
  getTextContent(): string {
    return ''
  }

  /** Host element: inert, hidden from assistive tech, non-editable. */
  createDOM(): HTMLElement {
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
  updateDOM(): boolean {
    return false
  }

  /** React face: suggestion text plus the accept-hint pill. */
  decorate(): React.JSX.Element {
    return (
      <GhostPredictionFace text={this.suggestionText} />
    )
  }

  /** Ghosts must not persist: refuse serialization loudly. */
  exportJSON(): SerializedGhostPredictionNode {
    throw new Error('GhostPredictionNode must not be serialized')
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
      <span className="ghost-prediction-hint">Press Tab to accept</span>
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
