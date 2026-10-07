import { afterEach, describe, expect, it, vi } from 'vitest'
import { withProductDisplayName } from '../src/product-copy.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('selected product copy', () => {
  it('preserves the dictionary value when the display name is unset', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', undefined)
    expect(withProductDisplayName('DeepSeek Harness 与 Y Harness')).toBe('DeepSeek Harness 与 Y Harness')
  })

  it('replaces every exact product mention with the configured name', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    expect(withProductDisplayName('DeepSeek Harness and Y Harness')).toBe('Atlas and Atlas')
  })

  it('keeps Unicode and replacement-string syntax literal', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', '星图 $& $` $\'')
    expect(withProductDisplayName('Y Harness')).toBe('星图 $& $` $\'')
  })

  it('leaves provider names and protocol identifiers unchanged', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const copy = 'DeepSeek provider, DeepSeek Account, MIT license, hermes-cli'
    expect(withProductDisplayName(copy)).toBe(copy)
  })
})
