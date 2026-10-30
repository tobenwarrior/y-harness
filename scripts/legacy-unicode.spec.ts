import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeUnicodeEscapes } from './legacy-unicode.ts'

const root = resolve(import.meta.dirname, '..')
const HAN = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}]/u

describe('legacy Unicode asset escapes', () => {
  it('decodes scalar code-point escapes', () => {
    const encoded = String.raw`prefix \u{4E2D}\u{6587} suffix`
    expect(decodeUnicodeEscapes(encoded)).toBe(`prefix ${String.fromCodePoint(0x4e2d, 0x6587)} suffix`)
  })

  it('keeps malformed and invalid scalar escapes unchanged', () => {
    const encoded = String.raw`\u{110000} \u{D800} \u{not-a-code-point}`
    expect(decodeUnicodeEscapes(encoded)).toBe(encoded)
  })

  it('keeps the three compatibility assets ASCII-source while restoring Han at read time', () => {
    for (const file of ['style-samples.md', 'terminology.md', 'translation-prompt.md']) {
      const encoded = readFileSync(join(root, 'docs/i18n', file), 'utf8')
      expect(encoded).not.toMatch(HAN)
      expect(decodeUnicodeEscapes(encoded)).toMatch(HAN)
    }
  })
})
