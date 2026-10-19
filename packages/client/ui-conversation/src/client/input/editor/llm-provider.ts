/**
 * Model-backed follow-up provider over the harness LLM service. Streams one
 * short completion and takes its first paragraph as the suggestion; empty
 * output, errors, and aborts all resolve to null (abstain) so the composer
 * never breaks.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  FollowUpPrediction,
  FollowUpPredictionProvider,
  PredictionRequest,
} from './ghost-prediction.ts'
import { MAX_PREDICTION_CHARS, buildFollowUpPrompt } from './ghost-prediction.ts'

/** Route for the prediction call (small fast model preferred). */
export interface FollowUpRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve the prediction route per call; return undefined to abstain
 * (e.g. no model selected). Lets the suggestion follow the user's model.
 */
export type FollowUpRouteResolver = () => FollowUpRoute | undefined

/**
 * Provider that asks the harness LLM for one likely next user message.
 * Construct per session with the session's cordis context and route.
 */
export class LlmFollowUpProvider implements FollowUpPredictionProvider {
  /**
   * @param actx - session cordis context exposing `llm.stream`.
   * @param route - fixed route or per-call resolver (undefined = abstain).
   * @param maxChars - suggestion cap (defaults to MAX_PREDICTION_CHARS).
   */
  constructor(
    private readonly actx: Context,
    private readonly route: FollowUpRoute | FollowUpRouteResolver,
    private readonly maxChars = MAX_PREDICTION_CHARS,
  ) {}

  /** @inheritdoc */
  async fetchPrediction(request: PredictionRequest): Promise<FollowUpPrediction | null> {
    if (request.assistantText.trim() === '') return null
    const resolved = typeof this.route === 'function' ? this.route() : this.route
    if (resolved === undefined) return null
    const { system, user } = buildFollowUpPrompt(request.assistantText)
    let text = ''
    try {
      const stream = this.actx.llm.stream({
        provider: resolved.provider,
        model: resolved.model,
        system,
        messages: [
          createUserMessage({
            content: [{ type: 'text', text: user }],
            source: { kind: 'user' },
          }),
        ],
        maxTokens: 128,
        temperature: 0.3,
        signal: request.signal,
      })
      for await (const chunk of stream) {
        if (request.signal.aborted) return null
        if (chunk.type === 'text-delta') text += chunk.text
        if (text.length >= this.maxChars) break
      }
    } catch {
      return null
    }
    const first = text.split('\n', 1)[0]?.trim() ?? ''
    if (first === '') return null
    return {
      id: `${request.conversationId}:${request.turnId}`,
      text: first.slice(0, this.maxChars),
    }
  }
}
