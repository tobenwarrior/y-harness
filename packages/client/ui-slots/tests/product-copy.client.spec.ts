import { afterEach, describe, expect, it, vi } from 'vitest'
import { withProductDisplayName } from '../src/product-copy.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('selected product copy', () => {
  it('uses Y Harness when the display name is unset', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', undefined)
    expect(withProductDisplayName('DeepSeek Harness \u{4E0E} Y Harness')).toBe('Y Harness \u{4E0E} Y Harness')
  })

  it('replaces every exact product mention with the configured name', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    expect(withProductDisplayName('DeepSeek Harness and Y Harness')).toBe('Atlas and Atlas')
  })

  it('keeps Unicode and replacement-string syntax literal', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', '\u{661F}\u{56FE} $& $` $\'')
    expect(withProductDisplayName('Y Harness')).toBe('\u{661F}\u{56FE} $& $` $\'')
  })

  it('leaves provider names and protocol identifiers unchanged', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const copy = 'DeepSeek provider, DeepSeek Account, MIT license, hermes-cli'
    expect(withProductDisplayName(copy)).toBe(copy)
  })
})
