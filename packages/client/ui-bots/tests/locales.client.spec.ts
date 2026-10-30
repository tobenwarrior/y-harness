import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('Bot locale compatibility', () => {
  it('keeps the retired zh dictionary as the English fallback', () => {
    expect(zh).toBe(en)
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })
})
