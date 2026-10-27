/**
 * What the conversation shows when a turn fails (clean-room behavior spec:
 * ChatGPT desktop's in-conversation failure state).
 *
 * The reference resolves every server-driven surface through one envelope —
 * pending / resolved / failed — where a failed resolution carries a typed code
 * AND a `retryable` boolean, renders a fallback rather than nothing, and only
 * offers actions the client can actually perform. The harness equivalent:
 * a failed turn currently surfaces as a transient toast carrying raw
 * `message (code)` text, so the user loses it on the next render and is never
 * told whether retrying could help.
 *
 * This module derives a persistent presentation from the same facts the retry
 * executor already uses, so "Try again" appears exactly when a retry can
 * succeed. It is framework-free and takes structural inputs.
 */

/** The failure facts a turn produced (structural mirror of LlmFailure). */
export interface TurnFailureFacts {
  readonly message: string
  readonly code: string
  readonly status?: number | undefined
  /** Provider-requested wait, when valid; a retry hint for rate limits. */
  readonly providerRetryAfterMs?: number | undefined
  /**
   * Whether the producing side judged this failure recoverable. Preferred over
   * code-list derivation when present: the retry executor resolved the route's
   * policy and knows; a client holding only a default list may not.
   */
  readonly retryable?: boolean | undefined
}

/** Automatic-retry progress already spent on this turn. */
export interface AutoRetryState {
  /** Retries already performed. */
  readonly used: number
  /** Policy budget; absent for unbounded policies. */
  readonly max?: number | undefined
  /** True once the executor gave up (or would not retry this code). */
  readonly exhausted: boolean
}

/** Everything the presentation decision needs. */
export interface TurnFailureInput {
  readonly failure: TurnFailureFacts
  /**
   * The route's retryable codes — the SAME list the retry executor consults,
   * so the affordance and the automatic behavior can never disagree.
   */
  readonly retryableCodes: readonly string[]
  /** Retry progress so far; omitted when the turn never auto-retried. */
  readonly autoRetry?: AutoRetryState | undefined
  /**
   * Whether a manual retry is actually available right now (session still
   * open, nothing running, cancellation came from the user).
   */
  readonly canRetry: boolean
}

/** Codes whose recovery is a user action, not another request. */
const USER_ACTION_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  AUTH: 'Sign in again, then resend.',
  QUOTA_EXCEEDED: 'Check your plan or billing, then resend.',
  CONTEXT_WINDOW_EXCEEDED: 'Start a new chat or compact this one, then resend.',
  INVALID_REQUEST: 'The provider rejected this request; resending it unchanged will fail the same way.',
  IMAGE_OFFLOAD_REQUIRED: 'Offload some images, then resend.',
  ABORTED: 'Cancelled.',
})

/** Short user-facing titles; provider internals never lead. */
function titleFor(code: string, retryable: boolean): string {
  if (code === 'ABORTED') return 'Stopped'
  if (code === 'RATE_LIMIT') return 'Rate limited'
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return 'Conversation too long'
  if (code === 'AUTH') return 'Not signed in'
  if (code === 'QUOTA_EXCEEDED') return 'Out of quota'
  if (code === 'EMPTY_RESPONSE') return 'The model returned nothing'
  if (retryable) return 'The model didn’t respond'
  return 'This request failed'
}

/**
 * Whether a route's policy lists this code as retryable. Used when the
 * producing side did not stamp an explicit `retryable` on the failure.
 * @param code - the failure's code.
 * @param retryableCodes - the route's policy list.
 * @returns whether the policy list contains the code.
 */
export function isRetryableCode(code: string, retryableCodes: readonly string[]): boolean {
  return retryableCodes.includes(code)
}

/** A failure the conversation renders as a persistent state. */
export type TurnFailurePresentation =
  /** Automatic retry is in flight: show progress, not silence or an error. */
  | {
    readonly kind: 'retrying'
    readonly title: string
    readonly detail: string
    /** Which automatic attempt is running (1-based). */
    readonly attempt: number
    readonly maxAttempts?: number | undefined
    /** Delay before this attempt, when the provider asked for one. */
    readonly waitMs?: number | undefined
  }
  /** Recovery is possible: offer exactly one retry action. */
  | {
    readonly kind: 'retryable'
    readonly title: string
    readonly detail: string
    /** Raw provider diagnostic, shown as secondary detail. */
    readonly diagnostic: string
    readonly action: 'retry'
    /** Suggested wait before the user retries, when the provider asked. */
    readonly waitHintMs?: number | undefined
  }
  /** No retry can help: explain what to do instead. */
  | {
    readonly kind: 'terminal'
    readonly title: string
    readonly detail: string
    readonly diagnostic: string
    readonly action: 'none'
    readonly guidance: string
  }
  /** The user cancelled; retained so history can render the intent. */
  | {
    readonly kind: 'cancelled'
    readonly title: string
    readonly detail: string
  }

/**
 * Decide what the conversation shows for a failed turn.
 *
 * Order matters: an in-flight automatic retry is reported before any terminal
 * judgement, and a retryable code with no available action degrades to a
 * terminal state carrying guidance rather than a dead "Try again" button.
 *
 * @param input - failure facts, the route's retryable codes, retry progress, and availability.
 * @returns the presentation the conversation renders.
 */
export function presentTurnFailure(input: TurnFailureInput): TurnFailurePresentation {
  const { failure, retryableCodes, autoRetry, canRetry } = input
  const code = failure.code
  const diagnostic = `${failure.message} (${code})`

  if (code === 'ABORTED') {
    return { kind: 'cancelled', title: titleFor(code, false), detail: 'You stopped this turn.' }
  }

  // An automatic retry that has not exhausted its budget is progress, not
  // failure: showing an error here would contradict the work already underway.
  if (autoRetry !== undefined && !autoRetry.exhausted) {
    const attempt = autoRetry.used + 1
    return {
      kind: 'retrying',
      title: 'Reconnecting…',
      detail: 'The model didn’t respond. Retrying automatically.',
      attempt,
      ...autoRetry.max === undefined ? {} : { maxAttempts: autoRetry.max },
      ...failure.providerRetryAfterMs === undefined ? {} : { waitMs: failure.providerRetryAfterMs },
    }
  }

  // Prefer the producer's own judgement (the reference's envelope carries
  // `retryable`); fall back to the policy list when it is absent.
  const retryable = failure.retryable ?? isRetryableCode(code, retryableCodes)
  const guidance = USER_ACTION_GUIDANCE[code]

  // Retryable, and the retry is actually available: offer it.
  if (retryable && canRetry && guidance === undefined) {
    return {
      kind: 'retryable',
      title: titleFor(code, true),
      detail: autoRetry?.exhausted === true
        ? 'Automatic retries didn’t get through. You can try once more.'
        : 'This looks temporary. You can try again.',
      diagnostic,
      action: 'retry',
      ...failure.providerRetryAfterMs === undefined ? {} : { waitHintMs: failure.providerRetryAfterMs },
    }
  }

  // Everything else is terminal: name the cause and what to do about it.
  return {
    kind: 'terminal',
    title: titleFor(code, retryable),
    detail: guidance ?? (retryable
      // Retryable by policy, but no action is available (cancelled, disposed,
      // or a turn already running) — say so instead of offering a dead button.
      ? 'This looks temporary. Resend your message to try again.'
      : 'Retrying the same request won’t change the outcome.'),
    diagnostic,
    action: 'none',
    guidance: guidance ?? '',
  }
}

/**
 * Whether a presentation should be rendered inline in the conversation
 * (persistent) rather than as a transient toast. Every state here is
 * persistent: the reference never drops a pending or failed resolution.
 * @param presentation - the decided presentation.
 * @returns whether the presentation is persistent rather than transient.
 */
export function isPersistent(presentation: TurnFailurePresentation): boolean {
  return presentation.kind !== 'retrying' || presentation.attempt > 0
}
