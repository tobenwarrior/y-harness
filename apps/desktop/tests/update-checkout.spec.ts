/**
 * detectCheckoutUpdate: a moved HEAD is an available update, and anything
 * unknown stays unknown rather than reporting an update that cannot apply.
 */
import { describe, expect, it } from 'vitest'
import {
  detectCheckoutUpdate,
  isCheckoutUpdateActionable,
  type CheckoutUpdateProbe,
  type GitProbeResult,
} from '../src/update-checkout.ts'

const HEAD = 'fa6b86e8ad1d4f0d9f2a0c1b2c3d4e5f60718293'

function probe(overrides: Partial<CheckoutUpdateProbe> = {}): CheckoutUpdateProbe {
  return {
    readStampCommit: async () => HEAD,
    readHeadCommit: async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
    ...overrides,
  }
}

describe('detectCheckoutUpdate', () => {
  it('reports up to date when HEAD matches the stamp', async () => {
    const state = await detectCheckoutUpdate(probe())
    expect(state).toEqual({
      builtCommit: HEAD,
      headCommit: HEAD,
      available: false,
      shortHead: HEAD.slice(0, 12),
    })
  })

  it('reports an available update when the checkout moved', async () => {
    const moved = 'a5d34b9a65ff6e5d4c3b2a190817263544332211'
    const state = await detectCheckoutUpdate(probe({
      readHeadCommit: async () => ({ exitCode: 0, stdout: moved }),
    }))
    expect(state).toMatchObject({ available: true, shortHead: moved.slice(0, 12) })
    expect(isCheckoutUpdateActionable(state)).toBe(true)
  })

  it('tolerates surrounding whitespace and mixed case', async () => {
    const state = await detectCheckoutUpdate(probe({
      readStampCommit: async () => `  ${HEAD.toUpperCase()}  `,
      readHeadCommit: async () => ({ exitCode: 0, stdout: `${HEAD}\n` }),
    }))
    expect(state?.available).toBe(false)
  })

  const unknownCases: readonly { readonly label: string; readonly overrides: Partial<CheckoutUpdateProbe> }[] = [
    { label: 'no stamp', overrides: { readStampCommit: async (): Promise<string | null> => null } },
    { label: 'unreadable stamp', overrides: { readStampCommit: async (): Promise<string | null> => { throw new Error('ENOENT') } } },
    { label: 'git failed', overrides: { readHeadCommit: async (): Promise<GitProbeResult> => ({ exitCode: 128, stdout: '' }) } },
    { label: 'git missing', overrides: { readHeadCommit: async (): Promise<GitProbeResult> => { throw new Error('ENOENT') } } },
    { label: 'non-commit stamp', overrides: { readStampCommit: async (): Promise<string | null> => 'not-a-commit' } },
    { label: 'empty head', overrides: { readHeadCommit: async (): Promise<GitProbeResult> => ({ exitCode: 0, stdout: '  ' }) } },
  ]

  it.each(unknownCases)('stays unknown with $label', async ({ overrides }) => {
    const state = await detectCheckoutUpdate(probe(overrides))
    expect(state).toBeNull()
    // Unknown must never read as actionable: the button would apply nothing.
    expect(isCheckoutUpdateActionable(state)).toBe(false)
  })

  it('never claims an update is actionable when only the stamp is known', async () => {
    const state = await detectCheckoutUpdate(probe({
      readHeadCommit: async () => ({ exitCode: 1, stdout: '' }),
    }))
    expect(isCheckoutUpdateActionable(state)).toBe(false)
  })
})
