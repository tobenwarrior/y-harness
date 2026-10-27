/**
 * Ghost follow-up prediction for the composer (clean-room behavior spec:
 * Codex "cumberbatch"). Framework-free state machine; the Lexical binding
 * lives in lexical-ghost.ts and the node face in ghost-node.tsx.
 *
 * Behavior contract (mirrors the observed reference):
 * - A prediction is fetched after an assistant turn completes. A null-text
 *   result records an abstain; a non-empty result records a suggestion.
 * - The ghost renders only while the draft is empty, the editor is not
 *   composing, and no competing UI claims the gesture.
 * - Tab or ArrowRight (no modifiers) accepts: the draft is replaced with the
 *   suggestion as editable text (never sent), the caret lands at the end.
 *   Enter is deliberately NOT an accept key here (it submits).
 * - Typing hides the ghost without discarding the prediction; clearing back
 *   to empty re-shows it without refetching. A new turn clears the state.
 * - Telemetry reports shown/accepted once per prediction id; never throws.
 */

// The controller consumes only the contract's types; the host half owns the
// provider implementation, so no value import is needed here.
import type {
  FollowUpPrediction, FollowUpPredictionProvider,
} from '../../../follow-up-contract.ts'

// Re-exported so existing consumers and tests keep one import site.
export {
  buildFollowUpPrompt, MAX_PREDICTION_CHARS,
  type FollowUpPrediction, type FollowUpPredictionProvider, type PredictionRequest,
} from '../../../follow-up-contract.ts'

/** Telemetry sink; the default logs at debug and never throws. */
export interface GhostPredictionTelemetry {
  shown(prediction: FollowUpPrediction): void
  accepted(prediction: FollowUpPrediction, acceptedText: string): void
}

/** Draft-face reads the controller needs from the shell. */
export interface GhostDraftFace {
  /** True while the draft is a single empty paragraph with no chips. */
  isEmpty(): boolean
  /** Replace the whole draft with text and park the caret at the end. */
  replaceWith(text: string): void
}

/** Reasons a fetch is skipped (recorded for debugging, never user-facing). */
export type PredictionSkipReason =
  | 'disabled'
  | 'no-conversation'

/**
 * Provider used when no host source is wired: the composer simply never
 * suggests. Model access belongs to the host half, which injects a real
 * provider through `SessionInputDeps`.
 */
export const NO_FOLLOW_UP_PREDICTION: FollowUpPredictionProvider = {
  fetchPrediction: () => Promise.resolve(null),
}

/**
 * Owns ghost-prediction state for one composer session: fetch generation
 * guard, per-id shown/accepted dedupe, and the visibility predicate.
 * All editor access flows through GhostDraftFace so this unit stays
 * UI-framework-free and vitest-friendly.
 */
export class GhostPredictionController {
  private enabled = true
  private generation = 0
  private prediction: FollowUpPrediction | null = null
  private readonly shownIds = new Set<string>()
  private readonly acceptedIds = new Set<string>()
  private currentAbort: AbortController | null = null

  /**
   * @param provider - prediction source.
   * @param draft - shell draft-face reads/writes.
   * @param telemetry - shown/accepted sink (defaults to console.debug).
   */
  constructor(
    private readonly provider: FollowUpPredictionProvider,
    private readonly draft: GhostDraftFace,
    private readonly telemetry: GhostPredictionTelemetry = {
      shown: (p) => { console.debug('[ghost-prediction] shown', p.id) },
      accepted: (p, text) => { console.debug('[ghost-prediction] accepted', p.id, text.length) },
    },
  ) {}

  /** Live prediction (null when none or abstained). */
  get current(): FollowUpPrediction | null {
    return this.prediction
  }

  /**
   * Enable or disable fetching (settings gate); disabling clears state.
   * @param enabled - whether prediction fetching is enabled.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.clear()
  }

  /**
   * Whether the ghost may render right now: prediction present, non-empty,
   * draft empty, editor not composing. Callers combine this with their own
   * competing-UI checks.
   * @param composing - live IME composition state.
   * @returns whether the prediction can render before competing-UI checks.
   */
  mayShow(composing: boolean): boolean {
    return this.prediction !== null
      && this.prediction.text !== ''
      && !composing
      && this.draft.isEmpty()
  }

  /**
   * Fetch a suggestion after an assistant turn completes. Concurrent calls
   * supersede each other by generation; stale results are dropped.
   * @param conversationId - conversation owning the completed turn.
   * @param turnId - completed assistant turn identifier.
   * @param assistantText - completed assistant message text.
   * @returns the skip reason, or null when a fetch ran.
   */
  async fetchAfterTurn(
    conversationId: string,
    turnId: string,
    assistantText: string,
  ): Promise<PredictionSkipReason | null> {
    if (!this.enabled) return 'disabled'
    if (conversationId === '') return 'no-conversation'
    const generation = this.generation + 1
    this.generation = generation
    this.currentAbort?.abort()
    const abort = new AbortController()
    this.currentAbort = abort
    try {
      const result = await this.provider.fetchPrediction({
        conversationId, turnId, assistantText, signal: abort.signal,
      })
      if (this.generation !== generation || abort.signal.aborted) return null
      // Null result = abstain: clear any older suggestion (it belongs to an
      // older turn) but record nothing.
      this.prediction = result !== null && result.text !== '' ? result : null
      return null
    } catch {
      // Never break the composer: failures and aborts keep prior state.
      return null
    } finally {
    }
  }

  /**
   * A new turn (or session teardown) invalidates the suggestion and aborts
   * any in-flight fetch.
   */
  clear(): void {
    this.generation += 1
    this.currentAbort?.abort()
    this.currentAbort = null
    this.prediction = null
  }

  /**
   * Record a render of the ghost for the live prediction (dedupe per id).
   * Call from the decorator sync when the ghost becomes visible.
   */
  markShown(): void {
    const prediction = this.prediction
    if (prediction === null || this.shownIds.has(prediction.id)) return
    this.shownIds.add(prediction.id)
    try {
      this.telemetry.shown(prediction)
    } catch {
      // Telemetry must not break the composer.
    }
  }

  /**
   * Accept the live prediction: replace the draft, park the caret, record
   * accepted once per id, then clear so the ghost does not linger.
   * @returns the accepted text, or null when nothing was live.
   */
  accept(): string | null {
    const prediction = this.prediction
    if (prediction === null || prediction.text === '') return null
    this.draft.replaceWith(prediction.text)
    if (!this.acceptedIds.has(prediction.id)) {
      this.acceptedIds.add(prediction.id)
      try {
        this.telemetry.accepted(prediction, prediction.text)
      } catch {
        // Telemetry must not break the composer.
      }
    }
    this.prediction = null
    return prediction.text
  }
}
