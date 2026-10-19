/**
 * presentTurnFailure: retryability comes from the same code list the retry
 * executor uses, in-flight automatic retries read as progress, and a
 * retryable code without an available action degrades instead of offering a
 * dead button.
 */
import { describe, expect, it } from 'vitest'
import {
  isPersistent,
  isRetryableCode,
  presentTurnFailure,
  type TurnFailureInput,
} from '../src/client/turn-failure.ts'

/** The default policy list the retry executor ships with, plus PI_AI_ERROR. */
const CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'] as const

function input(overrides: Partial<TurnFailureInput> = {}): TurnFailureInput {
  return {
    failure: { message: 'The model failed to generate a response', code: 'SERVER' },
    retryableCodes: [...CODES],
    canRetry: true,
    ...overrides,
  }
}

describe('isRetryableCode', () => {
  it('matches the policy list exactly', () => {
    expect(isRetryableCode('SERVER', CODES)).toBe(true)
    expect(isRetryableCode('PI_AI_ERROR', CODES)).toBe(true)
    expect(isRetryableCode('INVALID_REQUEST', CODES)).toBe(false)
    expect(isRetryableCode('AUTH', CODES)).toBe(false)
  })
})

describe('presentTurnFailure', () => {
  it('offers a retry for a retryable code when the action is available', () => {
    const p = presentTurnFailure(input())
    expect(p).toMatchObject({ kind: 'retryable', action: 'retry' })
    expect(p.title).not.toContain('SERVER')
  })

  it('keeps provider internals out of the title but available as diagnostic', () => {
    const p = presentTurnFailure(input({
      failure: { message: 'opencode-go API error (400): bad params', code: 'SERVER' },
    }))
    expect(p.kind).toBe('retryable')
    if (p.kind !== 'retryable') throw new Error('unreachable')
    expect(p.title).toBe('The model didn’t respond')
    expect(p.diagnostic).toContain('opencode-go API error (400)')
  })

  it('reports an in-flight automatic retry as progress, not failure', () => {
    const p = presentTurnFailure(input({
      autoRetry: { used: 1, max: 5, exhausted: false },
    }))
    expect(p).toEqual({
      kind: 'retrying',
      title: 'Reconnecting…',
      detail: 'The model didn’t respond. Retrying automatically.',
      attempt: 2,
      maxAttempts: 5,
    })
  })

  it('surfaces an exhausted automatic retry as a manual offer', () => {
    const p = presentTurnFailure(input({
      autoRetry: { used: 5, max: 5, exhausted: true },
    }))
    expect(p).toMatchObject({ kind: 'retryable', action: 'retry' })
    if (p.kind !== 'retryable') throw new Error('unreachable')
    expect(p.detail).toContain('didn’t get through')
  })

  it('passes a provider wait hint through to the retryable state', () => {
    const p = presentTurnFailure(input({
      failure: { message: 'slow down', code: 'RATE_LIMIT', providerRetryAfterMs: 30_000 },
    }))
    expect(p).toMatchObject({ kind: 'retryable', title: 'Rate limited', waitHintMs: 30_000 })
  })

  it('degrades a retryable code to terminal when no retry is available', () => {
    const p = presentTurnFailure(input({ canRetry: false }))
    expect(p).toMatchObject({ kind: 'terminal', action: 'none' })
    if (p.kind !== 'terminal') throw new Error('unreachable')
    expect(p.detail).toContain('Resend your message')
  })

  it.each([
    ['AUTH', 'Sign in again'],
    ['QUOTA_EXCEEDED', 'billing'],
    ['CONTEXT_WINDOW_EXCEEDED', 'compact'],
  ])('gives %s actionable guidance with no dead retry button', (code, fragment) => {
    const p = presentTurnFailure(input({ failure: { message: 'nope', code } }))
    expect(p).toMatchObject({ kind: 'terminal', action: 'none' })
    if (p.kind !== 'terminal') throw new Error('unreachable')
    expect(p.guidance).toContain(fragment)
  })

  it('says plainly that a rejected request will fail identically', () => {
    const p = presentTurnFailure(input({
      failure: { message: 'The request contains invalid parameters', code: 'INVALID_REQUEST' },
    }))
    expect(p).toMatchObject({ kind: 'terminal' })
    if (p.kind !== 'terminal') throw new Error('unreachable')
    expect(p.guidance).toContain('will fail the same way')
  })

  it('never offers a retry for a code outside the policy', () => {
    for (const code of ['INVALID_REQUEST', 'AUTH', 'QUOTA_EXCEEDED', 'SOMETHING_NEW']) {
      const p = presentTurnFailure(input({ failure: { message: 'x', code } }))
      expect(p.kind).toBe('terminal')
    }
  })

  it('renders a user cancellation as a retained state, not an error', () => {
    const p = presentTurnFailure(input({ failure: { message: 'aborted', code: 'ABORTED' } }))
    expect(p).toEqual({ kind: 'cancelled', title: 'Stopped', detail: 'You stopped this turn.' })
  })

  it('prefers an explicit retryable flag from the producer', () => {
    // Server says recoverable though the client's list lacks the code.
    const recoverable = presentTurnFailure(input({
      failure: { message: 'new wording', code: 'BRAND_NEW_CODE', retryable: true },
    }))
    expect(recoverable).toMatchObject({ kind: 'retryable', action: 'retry' })

    // Server says permanent though the code is on the client's list.
    const permanent = presentTurnFailure(input({
      failure: { message: 'x', code: 'SERVER', retryable: false },
    }))
    expect(permanent).toMatchObject({ kind: 'terminal', action: 'none' })
  })

  it('an unknown code falls back to a generic terminal state', () => {
    const p = presentTurnFailure(input({ failure: { message: 'mystery', code: 'NOT_A_REAL_CODE' } }))
    expect(p).toMatchObject({ kind: 'terminal', title: 'This request failed' })
  })
})

describe('isPersistent', () => {
  it('treats every decided state as persistent', () => {
    const states = [
      presentTurnFailure(input()),
      presentTurnFailure(input({ canRetry: false })),
      presentTurnFailure(input({ autoRetry: { used: 0, exhausted: false } })),
      presentTurnFailure(input({ failure: { message: 'x', code: 'ABORTED' } })),
    ]
    for (const state of states) expect(isPersistent(state)).toBe(true)
  })
})
