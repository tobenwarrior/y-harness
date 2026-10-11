import { describe, expect, it } from 'vitest'
import { markdownWithinLimit, measureMarkdown } from '../src/markdown-size.ts'

describe('vault Markdown measurement', () => {
  it.each([199, 200, 201])('counts the %i-line complete document', (lines) => {
    const text = 'x\n'.repeat(lines)
    expect(measureMarkdown(text)).toEqual({ physicalLines: lines, screenLines: lines, bytes: lines * 2 })
    expect(markdownWithinLimit(text)).toBe(lines <= 200)
  })
  it('counts blank lines and removes only the final newline sentinel', () => {
    expect(measureMarkdown('')).toEqual({ physicalLines: 0, screenLines: 0, bytes: 0 })
    expect(measureMarkdown('\n\n')).toEqual({ physicalLines: 2, screenLines: 2, bytes: 2 })
    expect(measureMarkdown('one')).toEqual({ physicalLines: 1, screenLines: 1, bytes: 3 })
  })
  it('uses word wrapping rather than character division', () => {
    expect(measureMarkdown(Array(3).fill('a'.repeat(50)).join(' ')).screenLines).toBe(3)
    expect(measureMarkdown('a'.repeat(181)).screenLines).toBe(3)
    expect(measureMarkdown('a'.repeat(90)).screenLines).toBe(1)
    expect(measureMarkdown('a'.repeat(89) + ' ' + 'b'.repeat(91)).screenLines).toBe(3)
  })
  it('matches code-point, tab and hyphen handling', () => {
    expect(measureMarkdown('😀'.repeat(91)).screenLines).toBe(2)
    expect(measureMarkdown('x\t'.repeat(46)).screenLines).toBe(5)
    expect(measureMarkdown('x\t'.repeat(44)).screenLines).toBe(1)
    expect(measureMarkdown('a'.repeat(50) + '-' + 'b'.repeat(50)).screenLines).toBe(2)
    expect(measureMarkdown('a'.repeat(91) + '\r' + '\t'.repeat(4) + 'z').screenLines).toBe(2)
    expect(measureMarkdown('a'.repeat(91) + '\r\t' + 'z'.repeat(100)).screenLines).toBe(3)
  })
  it('enforces bytes independently, including multibyte frontmatter and wrappers', () => {
    const text = Array(200).fill('😀'.repeat(90)).join('\n') + '\n'
    expect(measureMarkdown(text).screenLines).toBe(200)
    expect(markdownWithinLimit(text)).toBe(false)
  })
})
