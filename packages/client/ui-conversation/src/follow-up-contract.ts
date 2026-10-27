/**
 * Follow-up prediction contract: the types, prompt, and length bound shared by
 * the client-side ghost controller and the host-side provider that answers it.
 *
 * This module lives at the package root on purpose. The client half is gated by
 * client-bundle purity (no cross-plugin VALUE imports), while the host half is
 * free to call `@deepseek-ai/dsh-llm`. Both halves import THIS file, so it must
 * stay pure — no imports of any kind beyond types it declares itself.
 */

/** One follow-up suggestion produced for the composer. */
export interface FollowUpPrediction {
  /** Stable id used for shown/accepted dedupe (e.g. a turn or request id). */
  readonly id: string
  /** Suggested draft text; empty means abstain (nothing renders). */
  readonly text: string
}

/** Context supplied to a provider fetch. */
export interface PredictionRequest {
  /** Owning conversation id. */
  readonly conversationId: string
  /** Latest completed assistant turn id. */
  readonly turnId: string
  /** Plain text of the completed assistant message (may be truncated). */
  readonly assistantText: string
  /** Abort when a newer turn completes or the session goes away. */
  readonly signal: AbortSignal
}

/**
 * Prediction source. Implementations must resolve null on abstain, error, or
 * abort — the controller never surfaces provider failures.
 */
export interface FollowUpPredictionProvider {
  fetchPrediction(request: PredictionRequest): Promise<FollowUpPrediction | null>
}

/**
 * Follow-up prompt builder for model-backed providers. Keeps the request small
 * and single-purpose: one likely next user message, plain text.
 * @param assistantText - latest completed assistant message (pre-truncated).
 * @returns the system instruction and assistant text as the user prompt.
 */
export function buildFollowUpPrompt(assistantText: string): { system: string; user: string } {
  return {
    system: 'Suggest one likely next user message for the chat below. '
      + 'Reply with only the suggested message text, no quotes or explanation. '
      + 'Reply with an empty string when no follow-up is likely.',
    user: assistantText,
  }
}

/** Max suggestion length accepted from a provider (longer text is cut). */
export const MAX_PREDICTION_CHARS = 500
