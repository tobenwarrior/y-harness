/** Plans bounded topic files from exact source ranges; unsupported Markdown is left for manual maintenance. */
import { createHash } from 'node:crypto'
import { markdownWithinLimit } from './markdown-size.ts'

/** A generated path relative to its generation directory and its complete text contents. */
export interface MarkdownTopicFile {
  path: string
  content: string
}

/** A split includes bounded readable topics, exact source fragments, and an exact root receipt. */
export type MarkdownSplitPlan =
  | { kind: 'unchanged' }
  | { kind: 'exception'; reason: string }
  | { kind: 'split'; after: string; generation: string; files: readonly MarkdownTopicFile[] }

interface Line {
  text: string
  start: number
  end: number
}
interface Heading {
  title: string
  anchor: string
  raw: string
}
interface Block {
  start: number
  end: number
  firstLine: number
  lastLine: number
  kind: 'heading' | 'fence' | 'text' | 'container' | 'table'
  heading: Heading | undefined
}
interface Section {
  heading: Heading | undefined
  blocks: [Block, ...Block[]]
  files: MarkdownTopicFile[]
}
interface Parsed {
  blocks: Block[]
  anchors: Map<string, string>
}

class SplitFailure extends Error {}

const headingPattern = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*$/
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/
const listPattern = /^ {0,3}(?:[-+*][\t ]+|\d{1,9}[.)][\t ]+)/
const quotePattern = /^ {0,3}>/
const rulePattern = /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/
const tableRulePattern = /^ {0,3}\|?[\t ]*:?-+:?[\t ]*(?:\|[\t ]*:?-+:?[\t ]*)*\|?[\t ]*$/

function linesOf(raw: string): [Line, ...Line[]] {
  const firstNewline = raw.indexOf('\n')
  const firstEnd = firstNewline < 0 ? raw.length : firstNewline + 1
  const lines: [Line, ...Line[]] = [{ text: raw.slice(0, firstNewline < 0 ? firstEnd : firstNewline), start: 0, end: firstEnd }]
  let start = firstEnd
  while (start < raw.length) {
    const newline = raw.indexOf('\n', start)
    const end = newline < 0 ? raw.length : newline + 1
    lines.push({ text: raw.slice(start, newline < 0 ? end : newline), start, end })
    start = end
  }
  return lines
}

function blank(line: Line): boolean {
  return /^[\t ]*$/.test(line.text)
}

function parseHeading(line: Line, anchors: Map<string, string>, raw: string): Heading | undefined {
  const match = headingPattern.exec(line.text)
  if (!match) return undefined
  const title = match[0].replace(/^ {0,3}#{1,6}[\t ]+/, '').replace(/[\t ]+#+[\t ]*$/, '').trim()
  if (!/^[\p{L}\p{N} -]+$/u.test(title) || !/^[\p{L}\p{N} -]+$/u.test(title.toLowerCase())) {
    throw new SplitFailure('Heading markup or explicit IDs require a manual split.')
  }
  const anchor = title.toLowerCase().replace(/[\t ]/g, '-')
  if (anchors.has(anchor)) throw new SplitFailure('Repeated heading anchors require a manual split.')
  anchors.set(anchor, title)
  return { title, anchor, raw: raw.slice(line.start, line.end) }
}

function stripContainers(text: string): string {
  let rest = text
  while (true) {
    const marker = /^ {0,3}(?:>[\t ]?|(?:[-+*]|\d{1,9}[.)])[\t ]+)/.exec(rest)
    if (!marker) return rest
    rest = rest.slice(marker[0].length)
  }
}

function nestedSyntax(text: string): void {
  for (const line of text.split('\n')) {
    const unwrapped = stripContainers(line)
    if (/^(?: {4}|\t)/.test(unwrapped)) {
      throw new SplitFailure('Indented content inside lists or callouts requires a manual split.')
    }
    const content = unwrapped.trimStart()
    if (/^(?:#{1,6}(?:[\t ]|$)|`{3,}|~{3,}|(?:=+|-+)[\t ]*$)/.test(content)) {
      throw new SplitFailure('Nested headings or fenced code require a manual split.')
    }
  }
}

function parseMarkdown(raw: string): Parsed {
  const lines = linesOf(raw)
  const blocks: Block[] = []
  const anchors = new Map<string, string>()
  let at = 0
  if (lines[0].text === '---') {
    const closing = lines.slice(1).find(line => line.text === '---')
    if (closing === undefined) throw new SplitFailure('Unclosed frontmatter requires a manual split.')
    if (/^split-exempt:\s*true\s*$/m.test(raw.slice(lines[0].end, closing.start))) {
      throw new SplitFailure('This entry is split-exempt. Review it manually before removing split-exempt: true to allow splitting.')
    }
    at = lines.indexOf(closing) + 1
  }
  for (let line = lines[at]; line !== undefined; line = lines[at]) {
    if (blank(line)) { at++; continue }
    const first = at
    let kind: Block['kind'] = 'text'
    let heading: Heading | undefined
    const fence = fencePattern.exec(line.text)
    const following = lines[at + 1]
    if (fence) {
      kind = 'fence'
      const fenceText = fence[0].trimStart()
      const marker = fenceText.replace(fenceText.startsWith('`') ? /[^`].*$/ : /[^~].*$/, '')
      if (marker[0] === '`' && fenceText.slice(marker.length).includes('`')) {
        throw new SplitFailure('Ambiguous fenced code requires a manual split.')
      }
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[\\t ]*$`)
      at++
      let closing = lines[at]
      while (closing !== undefined && !close.test(closing.text)) {
        at++
        closing = lines[at]
      }
      if (closing === undefined) throw new SplitFailure('Unclosed fenced code requires a manual split.')
      at++
    } else if ((heading = parseHeading(line, anchors, raw))) {
      kind = 'heading'
      at++
    } else if (rulePattern.test(line.text)) {
      at++
    } else if (listPattern.test(line.text) || quotePattern.test(line.text)) {
      kind = 'container'
      const quote = quotePattern.test(line.text)
      at++
      for (let next = lines[at]; next !== undefined; next = lines[at]) {
        if (blank(next)) {
          let nextIndex = at
          let followingLine = lines[nextIndex]
          while (followingLine !== undefined && blank(followingLine)) {
            nextIndex++
            followingLine = lines[nextIndex]
          }
          if (followingLine !== undefined && (quote ? quotePattern.test(followingLine.text)
            : listPattern.test(followingLine.text) || /^(?: {2,}|\t)/.test(followingLine.text))) {
            at = nextIndex
            continue
          }
          break
        }
        if (headingPattern.test(next.text) || fencePattern.test(next.text)) {
          if (!quote && /^ +/.test(next.text)) {
            throw new SplitFailure('Nested headings or fenced code require a manual split.')
          }
          break
        }
        at++
      }
      nestedSyntax(raw.slice(line.start, lines[at]?.start ?? raw.length))
    } else if (line.text.includes('|') && following !== undefined && following.text.includes('|')
      && tableRulePattern.test(following.text)) {
      kind = 'table'
      at += 2
      for (let next = lines[at]; next !== undefined && !blank(next); next = lines[at]) {
        if (/^(?: {4}|\t)/.test(next.text)) throw new SplitFailure('Indented table rows require a manual split.')
        if (headingPattern.test(next.text) || fencePattern.test(next.text) || listPattern.test(next.text)
          || quotePattern.test(next.text) || rulePattern.test(next.text)) break
        at++
      }
    } else {
      if (/^ {0,3}#{1,6}(?:[\t ]|$)/.test(line.text)) {
        throw new SplitFailure('Empty or unsupported headings require a manual split.')
      }
      if (/^(?: {4}|\t)/.test(line.text)) throw new SplitFailure('Indented code requires a manual split.')
      at++
      for (let next = lines[at]; next !== undefined && !blank(next); next = lines[at]) {
        if (/^ {0,3}(?:=+|-+)[\t ]*$/.test(next.text)) {
          throw new SplitFailure('Setext headings require a manual split.')
        }
        if (headingPattern.test(next.text) || fencePattern.test(next.text) || listPattern.test(next.text)
          || quotePattern.test(next.text) || rulePattern.test(next.text)) break
        at++
      }
    }
    for (let next = lines[at]; next !== undefined && blank(next); next = lines[at]) at++
    blocks.push({ start: line.start, end: lines[at]?.start ?? raw.length, firstLine: first + 1,
      lastLine: at, kind, heading })
  }
  return { blocks, anchors }
}

function escaped(text: string, at: number): boolean {
  let count = 0
  while (at > 0 && text[--at] === '\\') count++
  return count % 2 === 1
}

function skipCode(text: string, at: number): number {
  let end = at
  while (text[end] === '`') end++
  const marker = text.slice(at, end)
  let close = end
  while ((close = text.indexOf(marker, close)) >= 0) {
    if (text[close - 1] !== '`' && text[close + marker.length] !== '`') return close + marker.length
    close += marker.length
  }
  throw new SplitFailure('Unclosed inline code requires a manual split.')
}

function knownFragment(fragment: string, anchors: Map<string, string>, wiki: boolean): void {
  let decoded: string
  try { decoded = decodeURIComponent(fragment) } catch {
    throw new SplitFailure('Invalid fragment encoding requires a manual split.')
  }
  if (!decoded) return
  if (anchors.has(decoded) || (wiki && [...anchors.values()].some(title => title.toLowerCase() === decoded.toLowerCase()))) return
  throw new SplitFailure('A self link targets an anchor that the root cannot preserve.')
}

function rebaseDestination(destination: string, entryName: string, anchors: Map<string, string>, moved: boolean): string {
  if (destination.trim() !== destination || /[\\\x00-\x1f\x7f`{}<>]/.test(destination)
    || /&(?:#\w+|[a-z]+);/i.test(destination)) {
    throw new SplitFailure('Escaped or ambiguous link destinations require a manual split.')
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(destination)
  if (scheme) {
    if (!/^(?:https?|mailto|tel|ftp)$/i.test(scheme[0].slice(0, -1))) {
      throw new SplitFailure('Unsupported URL schemes require a manual split.')
    }
    return destination
  }
  if (destination.startsWith('/')) return destination
  const hash = destination.indexOf('#')
  const path = destination.slice(0, hash < 0 ? destination.length : hash).replace(/\?.*$/, '')
  const self = !path || path === entryName || path === `./${entryName}`
  if (self && hash >= 0) knownFragment(destination.slice(hash + 1), anchors, false)
  if (!moved) return destination
  return `../../../${!path ? entryName : ''}${destination}`
}

function inlineDestination(text: string, opening: number): { start: number; end: number; close: number } {
  let at = opening + 1
  while (at < text.length && /[\t ]/.test(text.charAt(at))) at++
  let start = at
  let end: number
  if (text[at] === '<') {
    start = ++at
    while (at < text.length && text[at] !== '>') at++
    if (at === text.length) throw new SplitFailure('Unclosed link destination requires a manual split.')
    end = at++
  } else {
    let depth = 0
    while (at < text.length) {
      const char = text.charAt(at)
      if (/\s/.test(char) || (char === ')' && depth === 0)) break
      if (char === '(') depth++
      if (char === ')') depth--
      at++
    }
    if (depth !== 0) throw new SplitFailure('Unbalanced link destination requires a manual split.')
    end = at
  }
  if (text[at] === ')') return { start, end, close: at + 1 }
  const suffix = /^[\t ]+(?:(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^)\\\n]|\\.)*\))[\t ]*)?\)/.exec(text.slice(at))
  if (!suffix) throw new SplitFailure('Multiline or ambiguous links require a manual split.')
  return { start, end, close: at + suffix[0].length }
}

function rewriteLinks(text: string, entryName: string, anchors: Map<string, string>, moved: boolean,
  insideLabel = false, singleContext = false): string {
  const changes: { start: number; end: number; value: string }[] = []
  for (let at = 0; at < text.length; at++) {
    if (escaped(text, at)) continue
    if (text[at] === '`') { at = skipCode(text, at) - 1; continue }
    if (text.startsWith('{%', at)) throw new SplitFailure('Markdown extensions require a manual split.')
    if (text[at] === '^' && /^[a-z0-9-]+[\t ]*(?:\n|$)/i.test(text.slice(at + 1))) {
      throw new SplitFailure('Markdown block IDs require a manual split.')
    }
    if ((at === 0 || text[at - 1] === '\n') && /^[\t >]*(?:::|\$\$|\{%)/.test(text.slice(at))) {
      throw new SplitFailure('Markdown extensions require a manual split.')
    }
    if (text[at] === '<') {
      const close = text.indexOf('>', at + 1)
      const value = close < 0 ? '' : text.slice(at + 1, close)
      if (!/^(?:https?:\/\/[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(value)) {
        throw new SplitFailure('Raw HTML or nonstandard autolinks require a manual split.')
      }
      if (insideLabel) throw new SplitFailure('Autolinks inside Markdown labels require a manual split.')
      at = close
      continue
    }
    if (text[at] !== '[') continue
    if (text[at + 1] === '^') throw new SplitFailure('Footnotes require a manual split.')
    if (text[at + 1] === '[') {
      if (insideLabel) throw new SplitFailure('Wiki links inside Markdown labels require a manual split.')
      const close = text.indexOf(']]', at + 2)
      if (close < 0 || text[at - 1] === '!') throw new SplitFailure('Embedded or unclosed wiki links require a manual split.')
      const inner = text.slice(at + 2, close)
      const parts = inner.split('|')
      const target = inner.slice(0, inner.indexOf('|') < 0 ? inner.length : inner.indexOf('|'))
      const hash = target.indexOf('#')
      const name = target.slice(0, hash)
      if (parts.length > 2 || /[\n\r\[\]\\]/.test(inner) || hash < 0
        || (name !== '' && name !== entryName && name !== entryName.slice(0, -3))) {
        throw new SplitFailure('Wiki links without an explicit self heading require a manual split.')
      }
      knownFragment(target.slice(hash + 1), anchors, true)
      if (moved) changes.push({ start: at + 2, end: at + 2 + target.length,
        value: `../../../${entryName}${target.slice(hash)}` })
      at = close + 1
      continue
    }
    let close = at + 1
    let depth = 1
    while (close < text.length && depth) {
      if (escaped(text, close)) { close++; continue }
      if (text[close] === '`') { close = skipCode(text, close); continue }
      if (text[close] === '[' && ++depth > 16) {
        throw new SplitFailure('Deeply nested Markdown labels require a manual split.')
      }
      if (text[close] === ']') depth--
      close++
    }
    if (depth) {
      if (singleContext) throw new SplitFailure('Cross-line or cross-cell Markdown labels require a manual split.')
      continue
    }
    if (text[close] === ':' && stripContainers(text.slice(text.lastIndexOf('\n', at - 1) + 1, at)).trim() === '') {
      throw new SplitFailure('Reference definitions require a manual split.')
    }
    if (text[close] === '[') throw new SplitFailure('Reference links require a manual split.')
    if (text[close] !== '(') continue
    if (insideLabel && (text[at - 1] !== '!' || escaped(text, at - 1))) {
      throw new SplitFailure('Nested Markdown links require a manual split.')
    }
    const label = text.slice(at + 1, close - 1)
    const changedLabel = rewriteLinks(label, entryName, anchors, moved, true, singleContext)
    if (label !== changedLabel) changes.push({ start: at + 1, end: close - 1, value: changedLabel })
    const destination = inlineDestination(text, close)
    const value = text.slice(destination.start, destination.end)
    const rebased = rebaseDestination(value, entryName, anchors, moved)
    if (rebased !== value) changes.push({ start: destination.start, end: destination.end, value: rebased })
    at = destination.close - 1
  }
  let result = text
  for (const change of changes.toReversed()) {
    result = result.slice(0, change.start) + change.value + result.slice(change.end)
  }
  return result
}

function rewriteBlock(raw: string, block: Block, entryName: string, anchors: Map<string, string>, moved: boolean): string {
  const original = raw.slice(block.start, block.end)
  if (block.kind === 'fence') return original
  if (block.kind !== 'container' && block.kind !== 'table') return rewriteLinks(original, entryName, anchors, moved)
  return original.split('\n').map((line) => {
    if (block.kind === 'container') return rewriteLinks(line, entryName, anchors, moved, false, true)
    let result = ''
    let start = 0
    for (let at = 0; at < line.length; at++) {
      if (line[at] !== '|' || escaped(line, at)) continue
      result += rewriteLinks(line.slice(start, at), entryName, anchors, moved, false, true) + '|'
      start = at + 1
    }
    return result + rewriteLinks(line.slice(start), entryName, anchors, moved, false, true)
  }).join('\n')
}

function separator(text: string): string {
  return text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
}

function topicContent(first: Block, last: Block, contents: readonly string[], entryName: string,
  generation: string, heading: Heading | undefined): string {
  const target = `../../../${entryName}${heading ? `#${heading.anchor}` : ''}`
  return `---\nsource_file: ${JSON.stringify(entryName)}\nsource_sha256: ${generation}\nsource_lines: "${first.firstLine}-${last.lastLine}"\n---\n\n[Back to ${entryName}](${target})\n\n${contents.join('')}`
}

function prefixCount(blocks: readonly Block[]): number {
  const firstHeading = blocks[0]?.heading
  const title = firstHeading !== undefined && /^ {0,3}#[\t ]/.test(firstHeading.raw)
  const nextHeading = blocks.findIndex((block, at) => block.heading !== undefined && (!title || at > 0))
  if (nextHeading >= 0) return nextHeading
  return Math.min(title ? 2 : 1, blocks.length)
}

function buildPlan(raw: string, entryName: string): MarkdownSplitPlan {
  if (raw.includes('\r')) throw new SplitFailure('CRLF or carriage returns require a manual split.')
  const parsed = parseMarkdown(raw)
  const kept = prefixCount(parsed.blocks)
  const remaining = parsed.blocks.slice(kept)
  const prefixEnd = remaining[0]?.start ?? raw.length
  const prefix = raw.slice(0, prefixEnd)
  if (!markdownWithinLimit(prefix)) throw new SplitFailure('The preserved title and introduction exceed the Markdown limits.')
  for (const block of parsed.blocks.slice(0, kept)) {
    rewriteBlock(raw, block, entryName, parsed.anchors, false)
  }
  const generation = createHash('sha256').update(raw).digest('hex')
  const sections: Section[] = []
  let currentSection: Section | undefined
  for (const block of remaining) {
    if (block.heading || currentSection === undefined) {
      currentSection = { heading: block.heading, blocks: [block], files: [] }
      sections.push(currentSection)
    } else currentSection.blocks.push(block)
  }
  const files: MarkdownTopicFile[] = []
  const sourceFiles: MarkdownTopicFile[] = [{ path: 'source/0000.txt', content: prefix }]
  for (const section of sections) {
    const slug = section.heading?.anchor.replace(/[^a-z0-9_-]/g, '').slice(0, 48) || 'source'
    let blocks: Block[] = []
    let firstBlock = section.blocks[0]
    let lastBlock = firstBlock
    let contents: string[] = []
    const publish = () => {
      if (2 * (files.length + 1) + 2 > 64) throw new SplitFailure('The split needs more than 64 topic and receipt files.')
      const file = { path: `topics/${String(files.length + 1).padStart(3, '0')}-${slug}.md`,
        content: topicContent(firstBlock, lastBlock, contents, entryName, generation, section.heading) }
      const source = raw.slice(firstBlock.start, lastBlock.end)
      if (!markdownWithinLimit(source)) throw new SplitFailure('An exact source fragment exceeds the Markdown limits.')
      files.push(file)
      section.files.push(file)
      sourceFiles.push({ path: `source/${String(sourceFiles.length).padStart(4, '0')}.txt`, content: source })
      blocks = []
      contents = []
    }
    for (const block of section.blocks) {
      const content = rewriteBlock(raw, block, entryName, parsed.anchors, true)
      const candidate = topicContent(firstBlock, block, [...contents, content], entryName, generation, section.heading)
      if (!markdownWithinLimit(candidate)) {
        if (!blocks.length || (blocks.length === 1 && firstBlock.kind === 'heading')) {
          throw new SplitFailure('An indivisible Markdown block exceeds the complete topic limits.')
        }
        publish()
        firstBlock = block
        if (!markdownWithinLimit(topicContent(block, block, [content], entryName, generation, section.heading))) {
          throw new SplitFailure('An indivisible Markdown block exceeds the complete topic limits.')
        }
      }
      blocks.push(block)
      lastBlock = block
      contents.push(content)
    }
    publish()
  }
  let after = prefix + separator(prefix)
  for (const section of sections) {
    if (section.heading) after += section.heading.raw + separator(section.heading.raw)
    after += section.files.map((file, part) => {
      const fragment = section.heading && part === 0 ? `#${section.heading.anchor}` : ''
      const label = section.heading ? `Read section${section.files.length > 1 ? ` ${part + 1}` : ''}` : `Source section ${files.indexOf(file) + 1}`
      return `[${label}](.y-topics/${generation}/${file.path}${fragment})`
    }).join('\n') + '\n\n'
  }
  if (!markdownWithinLimit(after)) throw new SplitFailure('The preserved headings and topic index exceed the Markdown limits.')
  return { kind: 'split', after, generation, files: [...files, ...sourceFiles, { path: 'entry.txt', content: after }] }
}

/**
 * Keeps bounded input unchanged or plans at most 64 topic and receipt files without writing files.
 * Source frontmatter, the initial title and introduction, and root heading anchors are preserved.
 * Ordered source/NNNN.txt fragments reconstruct the original; entry.txt preserves the planned root.
 * Oversized entries with split-exempt: true in frontmatter require manual maintenance.
 * Ambiguous Markdown, links, and indivisible oversized blocks return an exception with no partial plan.
 * @param raw Original Markdown; splitting accepts LF line endings.
 * @param entryName Simple Markdown filename used by metadata and links, defaulting to SKILL.md.
 * @returns Unchanged input, a complete bounded split, or an explicit manual-maintenance reason.
 */
export function planMarkdownSplit(raw: string, entryName = 'SKILL.md'): MarkdownSplitPlan {
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(entryName) || entryName.includes('..')) {
    return { kind: 'exception', reason: 'The entry name must be a simple Markdown filename.' }
  }
  if (markdownWithinLimit(raw)) return { kind: 'unchanged' }
  try { return buildPlan(raw, entryName) } catch (error) {
    if (error instanceof SplitFailure) return { kind: 'exception', reason: error.message }
    throw error
  }
}
