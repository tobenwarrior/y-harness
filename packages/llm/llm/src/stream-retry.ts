/**
 * Bounded transient retry for one-shot model streams (clean-room behavior:
 * ChatGPT desktop retries transient call failures with backoff instead of
 * surfacing the first error).
 *
 * Retries the whole stream open while NO chunk has been yielded yet: once
 * the consumer has seen output, retrying would duplicate it, so failures
 * after the first chunk propagate immediately. Aborts are never retried.
 *
 * Framework-free: the caller supplies the opener, the policy, and the
 * classifier. The runtime wires it around adapter dispatch (see INTEGRATION).
 */
/**
 * Minimal resolved-policy shape (structural mirror of the runtime's
 * ResolvedRetryPolicy, so this module stays dependency-free). Discriminated
 * so normal mode carries its bounds and code list.
 */
export type RetryPolicyLike = {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
} & (
  | {
    readonly mode: 'normal'
    readonly maxRetries: number
    readonly retryableCodes: readonly string[]
  }
  | { readonly mode: 'always' }
)

/** Minimal stream chunk shape the retry loop needs to observe. */
export interface RetryChunk {
  readonly type: string
}

/** Classified failure facts used for the retry decision. */
export interface ClassifiedFailure {
  /** Stable failure code (e.g. SERVER, TIMEOUT, RATE_LIMIT). */
  readonly code: string
  /** Provider-advised wait, in ms; undefined when absent. */
  readonly retryAfterMs?: number | undefined
}

/**
 * Read one own data property without invoking a getter or proxy trap.
 * Mirrors the adapter-failure discipline: a hostile or foreign error object
 * must never be able to run code during classification.
 */
function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Classify a dispatch/iteration throw. Reads only own data properties so a
 * hostile or foreign error object cannot trigger accessors.
 * @param error - thrown dispatch or iteration failure.
 * @returns its failure code and any valid provider retry-after hint.
 */
export function classifyStreamFailure(error: unknown): ClassifiedFailure {
  if (typeof error !== 'object' || error === null) {
    return { code: 'UNKNOWN' }
  }
  const failure = ownDataProperty(error, 'failure')
  const source: object =
    typeof failure === 'object' && failure !== null ? failure : error
  const code = ownDataProperty(source, 'code')
  const retryAfter = ownDataProperty(source, 'providerRetryAfterMs')
  return {
    code: typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN',
    retryAfterMs: typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : undefined,
  }
}

/** Knobs for one retry-guarded stream open. */
export interface TransientRetryOptions {
  /** Resolved per-route policy (normal = bounded codes, always = unbounded). */
  readonly policy: RetryPolicyLike
  /** Abort stops sleeping immediately and propagates. */
  readonly signal?: AbortSignal | undefined
  /** Sleep implementation (injectable for tests). */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
  /** Classifier override (defaults to {@link classifyStreamFailure}). */
  readonly classify?: ((error: unknown) => ClassifiedFailure) | undefined
  /** Telemetry hook: fired before each delayed reopen. */
  readonly onRetry?: ((attempt: number, code: string, delayMs: number) => void) | undefined
}

/**
 * Default sleep honoring abort: rejects immediately when already aborted,
 * clears the timer on abort, and resolves after the delay otherwise.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Compute the pre-attempt delay: exponential from initialDelayMs, capped at
 * maxDelayMs, symmetric jitter, and a provider retry-after hint capped at maxDelayMs.
 * @param policy - delay and jitter settings.
 * @param failedAttempt - one-based failed attempt number.
 * @param random - random source for jitter.
 * @param retryAfterMs - optional provider-advised minimum delay.
 * @returns the delay in milliseconds.
 */
export function retryDelayMs(
  policy: RetryPolicyLike,
  failedAttempt: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const grown = policy.initialDelayMs * 2 ** Math.max(0, failedAttempt - 1)
  const capped = Math.min(policy.maxDelayMs, grown)
  const jittered = capped * (1 + (random() * 2 - 1) * policy.jitterRatio)
  const floored = Math.max(0, jittered)
  return retryAfterMs === undefined ? floored : Math.min(policy.maxDelayMs, Math.max(floored, retryAfterMs))
}

/**
 * Open the stream, transparently reopening it on retryable pre-output
 * failures until the policy is exhausted, the error is terminal, output
 * has started, or the signal aborts.
 * @param openStream - opens a fresh stream for each attempt.
 * @param options - retry policy, cancellation, and optional hooks.
 * @param random - random source for retry jitter.
 * @returns an async generator of stream chunks.
 */
export async function* withTransientRetries<TChunk extends RetryChunk>(
  openStream: () => AsyncIterable<TChunk>,
  options: TransientRetryOptions,
  random: () => number = Math.random,
): AsyncGenerator<TChunk> {
  const { policy, signal } = options
  const sleep = options.sleep ?? defaultSleep
  const classify = options.classify ?? classifyStreamFailure
  let attempt = 0
  for (;;) {
    attempt += 1
    let yielded = false
    try {
      const stream = openStream()
      for await (const chunk of stream) {
        yielded = true
        yield chunk
      }
      return
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (yielded) throw error
      const failure = classify(error)
      if (failure.code === 'ABORTED') throw error
      if (policy.mode === 'normal') {
        if (attempt > policy.maxRetries) throw error
        if (!policy.retryableCodes.includes(failure.code)) throw error
      }
      const delay = retryDelayMs(policy, attempt, random, failure.retryAfterMs)
      try {
        options.onRetry?.(attempt, failure.code, delay)
      } catch {
        // Telemetry must not break the stream.
      }
      await sleep(delay, signal)
    }
  }
}
