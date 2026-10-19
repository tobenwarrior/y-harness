/**
 * withTransientRetries: pre-output reopen, policy bounds, abort and
 * post-output propagation. Framework-free fakes; no timers (sleep injected).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  classifyStreamFailure,
  retryDelayMs,
  withTransientRetries,
  type RetryPolicyLike,
} from '../src/stream-retry.ts'

type Chunk = { type: string }

const POLICY: RetryPolicyLike = {
  mode: 'normal',
  maxRetries: 2,
  retryableCodes: ['SERVER', 'TIMEOUT'],
  initialDelayMs: 100,
  maxDelayMs: 1000,
  jitterRatio: 0,
}

/** Failure carrying a normalized shape, as the runtime produces. */
function failure(code: string, retryAfterMs?: number): Error {
  const error = new Error(`failed: ${code}`)
  Object.assign(error, { failure: { message: code, code, retryAfterMs } })
  if (retryAfterMs !== undefined) Object.assign(error, { failure: { message: code, code, providerRetryAfterMs: retryAfterMs } })
  return error
}

async function collect(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

/** Openers that fail N times then succeed. */
function opener(failures: readonly Error[], chunks: readonly Chunk[]): {
  open: () => AsyncIterable<Chunk>
  attempts: () => number
} {
  let attempt = 0
  return {
    attempts: () => attempt,
    open: async function* (): AsyncGenerator<Chunk> {
      const index = attempt
      attempt += 1
      const error = failures[index]
      if (error !== undefined) throw error
      for (const chunk of chunks) yield chunk
    },
  }
}

const noSleep = async (): Promise<void> => {}

describe('withTransientRetries', () => {
  it('passes through a healthy stream without retrying', async () => {
    const fake = opener([], [{ type: 'text-delta' }, { type: 'finish' }])
    const out = await collect(withTransientRetries(fake.open, { policy: POLICY, sleep: noSleep }))
    expect(out).toEqual([{ type: 'text-delta' }, { type: 'finish' }])
    expect(fake.attempts()).toBe(1)
  })

  it('reopens on a retryable pre-output failure and yields once', async () => {
    const fake = opener([failure('SERVER')], [{ type: 'text-delta' }])
    const out = await collect(withTransientRetries(fake.open, { policy: POLICY, sleep: noSleep }))
    expect(out).toEqual([{ type: 'text-delta' }])
    expect(fake.attempts()).toBe(2)
  })

  it('stops at maxRetries and propagates the last error', async () => {
    const fake = opener([failure('SERVER'), failure('SERVER'), failure('SERVER'), failure('SERVER')], [])
    await expect(collect(withTransientRetries(fake.open, { policy: POLICY, sleep: noSleep }))).rejects.toThrow('SERVER')
    // initial + 2 retries = 3 attempts, never a 4th
    expect(fake.attempts()).toBe(3)
  })

  it('does not retry a non-retryable code', async () => {
    const fake = opener([failure('INVALID_REQUEST')], [{ type: 'text-delta' }])
    await expect(collect(withTransientRetries(fake.open, { policy: POLICY, sleep: noSleep }))).rejects.toThrow('INVALID_REQUEST')
    expect(fake.attempts()).toBe(1)
  })

  it('never retries after output started (no duplicate chunks)', async () => {
    let attempt = 0
    const open = async function* (): AsyncGenerator<Chunk> {
      attempt += 1
      yield { type: 'text-delta' }
      throw failure('SERVER')
    }
    await expect(collect(withTransientRetries(open, { policy: POLICY, sleep: noSleep }))).rejects.toThrow('SERVER')
    expect(attempt).toBe(1)
  })

  it('never retries an abort, even mid-backoff', async () => {
    const controller = new AbortController()
    const fake = opener([failure('ABORTED')], [{ type: 'text-delta' }])
    await expect(collect(withTransientRetries(fake.open, {
      policy: POLICY,
      sleep: noSleep,
      signal: controller.signal,
    }))).rejects.toThrow('ABORTED')
    expect(fake.attempts()).toBe(1)
  })

  it('always-mode retries non-listed codes until success', async () => {
    const always: RetryPolicyLike = { ...POLICY, mode: 'always' }
    const fake = opener([failure('WEIRD'), failure('WEIRD')], [{ type: 'finish' }])
    const out = await collect(withTransientRetries(fake.open, { policy: always, sleep: noSleep }))
    expect(out).toEqual([{ type: 'finish' }])
    expect(fake.attempts()).toBe(3)
  })

  it('reports each retry with attempt, code and delay', async () => {
    const onRetry = vi.fn()
    const fake = opener([failure('SERVER'), failure('TIMEOUT')], [{ type: 'text-delta' }])
    await collect(withTransientRetries(fake.open, { policy: POLICY, sleep: noSleep, onRetry }))
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry.mock.calls[0]?.[0]).toBe(1)
    expect(onRetry.mock.calls[0]?.[1]).toBe('SERVER')
    expect(onRetry.mock.calls[1]?.[1]).toBe('TIMEOUT')
  })

  it('telemetry throws never break the stream', async () => {
    const fake = opener([failure('SERVER')], [{ type: 'text-delta' }])
    const out = await collect(withTransientRetries(fake.open, {
      policy: POLICY,
      sleep: noSleep,
      onRetry: () => { throw new Error('telemetry down') },
    }))
    expect(out).toEqual([{ type: 'text-delta' }])
  })

  it('abort during backoff stops the loop', async () => {
    const controller = new AbortController()
    const fake = opener([failure('SERVER'), failure('SERVER')], [{ type: 'text-delta' }])
    const sleep = async (): Promise<void> => {
      controller.abort()
      throw new Error('aborted')
    }
    await expect(collect(withTransientRetries(fake.open, {
      policy: POLICY,
      sleep,
      signal: controller.signal,
    }))).rejects.toThrow()
    expect(fake.attempts()).toBe(1)
  })
})

describe('classifyStreamFailure', () => {
  it('reads a nested failure record', () => {
    expect(classifyStreamFailure(failure('SERVER'))).toEqual({ code: 'SERVER', retryAfterMs: undefined })
    expect(classifyStreamFailure(failure('RATE_LIMIT', 2500)).retryAfterMs).toBe(2500)
  })

  it('falls back to the top-level code and never throws on hostile values', () => {
    expect(classifyStreamFailure(Object.assign(new Error('x'), { code: 'SERVER' })).code).toBe('SERVER')
    expect(classifyStreamFailure(null).code).toBe('UNKNOWN')
    expect(classifyStreamFailure('nope').code).toBe('UNKNOWN')
    expect(classifyStreamFailure({ get failure() { throw new Error('trap') } }).code).toBe('UNKNOWN')
  })
})

describe('retryDelayMs', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const half = (): number => 0.5
    expect(retryDelayMs(POLICY, 1, half)).toBe(100)
    expect(retryDelayMs(POLICY, 2, half)).toBe(200)
    expect(retryDelayMs(POLICY, 5, half)).toBe(1000)
  })

  it('applies symmetric jitter within the configured ratio', () => {
    const jittered: RetryPolicyLike = { ...POLICY, jitterRatio: 0.1 }
    expect(retryDelayMs(jittered, 1, () => 1)).toBeCloseTo(110)
    expect(retryDelayMs(jittered, 1, () => 0)).toBeCloseTo(90)
  })

  it('honors a provider retry-after hint within the cap', () => {
    expect(retryDelayMs(POLICY, 1, () => 0.5, 5000)).toBe(1000)
    expect(retryDelayMs(POLICY, 1, () => 0.5, 400)).toBe(400)
  })
})
