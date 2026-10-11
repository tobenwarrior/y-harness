/** Markdown budgets use the vault's 90-column screen-line convention. */

/** Full-document measurement, including frontmatter, blanks and wrappers. */
export interface MarkdownSize {
  readonly physicalLines: number
  readonly screenLines: number
  readonly bytes: number
}

/** Vault limits are content invariants, not a model's output budget. */
export const MARKDOWN_SCREEN_CAP = 200
/** Complete Markdown files may contain at most 25 KiB of UTF-8 source. */
export const MARKDOWN_BYTE_CAP = 25 * 1024
const SCREEN_WIDTH = 90

function expandTabs(line: string): string {
  let column = 0
  let result = ''
  for (const character of line) {
    if (character === '\t') {
      const spaces = 8 - column % 8
      result += ' '.repeat(spaces)
      column += spaces
    } else {
      result += character
      column = character === '\r' ? 0 : column + 1
    }
  }
  return result
}

function wrappedLines(line: string): number {
  // Python textwrap leaves short lines untouched in the vault tool.
  if (Array.from(line).length <= SCREEN_WIDTH) return 1
  const chunks = expandTabs(line).split(/([\t\n\v\f\r ]+)/).filter(Boolean).map(chunk => Array.from(chunk))
  let index = 0
  let count = 0
  while (index < chunks.length) {
    let occupied = 0
    for (let chunk = chunks[index]; chunk !== undefined; chunk = chunks[index]) {
      if (occupied + chunk.length > SCREEN_WIDTH) break
      occupied += chunk.length
      index++
    }
    const next = chunks[index]
    if (next !== undefined && next.length > SCREEN_WIDTH) {
      const available = SCREEN_WIDTH - occupied
      chunks[index] = next.slice(available)
      occupied += available
    }
    count++
  }
  return count
}

/**
 * Match vault_tidy.py's textwrap measurement without changing source text.
 * @param text - complete Markdown, including any terminal newline.
 * @returns screen lines, source lines and UTF-8 bytes; one trailing newline is a sentinel.
 */
export function measureMarkdown(text: string): MarkdownSize {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return {
    physicalLines: lines.length,
    screenLines: lines.reduce((total, line) => total + wrappedLines(line), 0),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

/**
 * Admit the entire emitted file under both vault limits.
 * @param text - complete proposed file.
 * @returns whether neither the 200-screen-line nor 25-KB limit is exceeded.
 */
export function markdownWithinLimit(text: string): boolean {
  const size = measureMarkdown(text)
  return size.screenLines <= MARKDOWN_SCREEN_CAP && size.bytes <= MARKDOWN_BYTE_CAP
}
