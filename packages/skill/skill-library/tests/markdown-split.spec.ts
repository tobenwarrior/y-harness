/** Exact source ranges, complete Markdown blocks, and all emitted wrappers determine split admission. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { planMarkdownSplit } from '../src/markdown-split.ts'
import type { MarkdownSplitPlan } from '../src/markdown-split.ts'
import { markdownWithinLimit, measureMarkdown } from '../src/markdown-size.ts'
import * as markdownSize from '../src/markdown-size.ts'

type Split = Extract<MarkdownSplitPlan, { kind: 'split' }>
const introduction = '# Skill\n\nA short introduction.\n\n'
const padding = 'A bounded paragraph.\n\n'.repeat(120)

function split(raw: string, entryName?: string): Split {
  const plan = planMarkdownSplit(raw, entryName)
  expect(plan.kind).toBe('split')
  if (plan.kind !== 'split') throw new Error(JSON.stringify(plan))
  return plan
}

function bodies(plan: Split): string[] {
  return plan.files.filter(file => file.path.startsWith('topics/'))
    .map(file => file.content.replace(/^---\n[\s\S]*?\n---\n\n\[Back to [^\n]+\n\n/, ''))
}

function exception(raw: string): string {
  const plan = planMarkdownSplit(raw)
  expect(plan.kind).toBe('exception')
  if (plan.kind !== 'exception') throw new Error(JSON.stringify(plan))
  expect(plan).not.toHaveProperty('files')
  expect(plan).not.toHaveProperty('after')
  return plan.reason
}

describe('Markdown topic planning', () => {
  it.each(['split-exempt: true', 'split-exempt:  true  ', 'split-exempt:\ntrue'])('refuses an oversized exempt header %s', (flag) => {
    const raw = `---\nname: example\n${flag}\n---\n\n` + introduction + '## Topic\n\n' + padding
    expect(exception(raw)).toMatch(/split-exempt.*manually/)
    expect(planMarkdownSplit(`---\n${flag}\n---\nshort`)).toEqual({ kind: 'unchanged' })
  })

  it.each(['split-exempt: false', 'split-exempt: "true"', 'split-exempt: True', ' split-exempt: true'])('splits a header without the exact exemption %s', (flag) => {
    const raw = `---\n${flag}\n---\n\n` + introduction + '## Topic\n\n' + padding
    expect(split(raw).files.find(file => file.path === 'entry.txt')?.content).toContain(flag)
  })

  it('ignores exemption text in the body or fenced code under a false header', () => {
    const raw = '---\nsplit-exempt: false\n---\n\n' + introduction + '## Topic\n\nsplit-exempt: true\n\n'
      + '```yaml\n---\nsplit-exempt: true\n---\n```\n\n' + padding
    expect(split(raw).files.filter(file => file.path.startsWith('source/')).map(file => file.content).join('')).toBe(raw)
  })

  it('keeps an oversized entry eligible when exemption text appears only in the body without frontmatter', () => {
    const raw = introduction + '## Topic\n\nsplit-exempt: true\n\n' + padding
    expect(split(raw).files.filter(file => file.path.startsWith('source/')).map(file => file.content).join('')).toBe(raw)
  })

  it.each([199, 200])('leaves a %i-screen-line document byte-for-byte unchanged', (count) => {
    const raw = 'x\n'.repeat(count)
    expect(measureMarkdown(raw).screenLines).toBe(count)
    expect(planMarkdownSplit(raw)).toEqual({ kind: 'unchanged' })
  })

  it('splits a 201-screen-line document at complete paragraphs', () => {
    const raw = introduction + 'Paragraph.\n\n'.repeat(98) + 'Last paragraph.'
    expect(measureMarkdown(raw).screenLines).toBe(201)
    const plan = split(raw)
    expect(plan.after.startsWith(introduction)).toBe(true)
    expect(bodies(plan).join('')).toBe(raw.slice(introduction.length))
    expect(markdownWithinLimit(plan.after)).toBe(true)
    expect(plan.files.every(file => markdownWithinLimit(file.content))).toBe(true)
  })

  it('preserves frontmatter, the title, introduction, and root heading hierarchy', () => {
    const prefix = '---\nname: exact\ndescription: "Keep  spacing"\n---\n\n# Skill  \n\nFirst paragraph.\n\nSecond introduction.\n\n'
    const body = '## Deployment\n\n' + padding + '### Verification ###  \n\n' + padding + '## Recovery\n\n' + padding
    const plan = split(prefix + body)
    expect(plan.after.startsWith(prefix)).toBe(true)
    expect(plan.after.match(/^#{2,6} .+$/gm)).toEqual(['## Deployment', '### Verification ###  ', '## Recovery'])
    expect(plan.after).toContain('#deployment)')
    expect(plan.after).toContain('#verification)')
    expect(bodies(plan).join('')).toBe(body)
    expect(plan.after).not.toContain('A bounded paragraph.')
  })

  it('keeps a heading with its first content block and uses whole paragraphs for continuation files', () => {
    const first = 'First '.repeat(200) + '\n\n'
    const body = '## Deployment\n\n' + first + padding
    const plan = split(introduction + body)
    expect(bodies(plan)[0]).toContain('## Deployment\n\n' + first)
    expect(bodies(plan).join('')).toBe(body)
    expect(bodies(plan)).toHaveLength(2)
    expect(plan.after).toContain('[Read section 2]')
  })

  it('does not infer headings for a document containing only paragraphs', () => {
    const prefix = 'The original introduction.\n\n'
    const plan = split(prefix + padding)
    expect(plan.after.startsWith(prefix)).toBe(true)
    expect(plan.after).not.toMatch(/^#/m)
    expect(plan.after).toContain('[Source section 1]')
    expect(bodies(plan).join('')).toBe(padding)
  })

  it('preserves full backtick and tilde fences, tables, lists, and callouts in individual children', () => {
    const fence = '```md\n# Not a heading\n[x](relative.md)\n[[#Unknown]]\n```\n\n'
    const tilde = '~~~~python\nprint("literal")\n~~~\n~~~~\n\n'
    const table = '| Name | Value |\n| --- | --- |\n| one | two |\n| three | four |\n\n'
    const list = '- first\n  continuation\n\n- second\n  continuation\n\n'
    const callout = '> [!NOTE]\n> A complete callout.\n> Its second line.\n\n'
    const body = '## Examples\n\n' + padding + fence + padding + tilde + padding + table + padding + list + padding + callout
    const plan = split(introduction + body)
    for (const block of [fence, tilde, table, list, callout]) {
      expect(bodies(plan).filter(content => content.includes(block))).toHaveLength(1)
    }
    expect(bodies(plan).join('')).toBe(body)
  })

  it('rebases relative Markdown links and images while preserving titles and external destinations', () => {
    const links = '[guide](fixture-guides/guide.md "A title") ![plot](../plots/chart.png) [angle](<fixture-guides/space name.md>) '
      + '[balanced](fixture-guides/a(b).md) [root](/absolute/path.md) [external](https://example.test/a?b=c#d) '
      + '[mail](mailto:reader@example.test) [query](?view=1) [empty]()\n\n'
    const plan = split(introduction + '## Deployment\n\n' + links + padding)
    const body = bodies(plan).join('')
    expect(body).toContain('[guide](../../../fixture-guides/guide.md "A title")')
    expect(body).toContain('![plot](../../../../plots/chart.png)')
    expect(body).toContain('[angle](<../../../fixture-guides/space name.md>)')
    expect(body).toContain('[balanced](../../../fixture-guides/a(b).md)')
    expect(body).toContain('[root](/absolute/path.md)')
    expect(body).toContain('[external](https://example.test/a?b=c#d)')
    expect(body).toContain('[mail](mailto:reader@example.test)')
    expect(body).toContain('[query](../../../SKILL.md?view=1)')
    expect(body).toContain('[empty](../../../SKILL.md)')
  })

  it('points self anchors to preserved root headings and keeps other-document fragments', () => {
    const links = '[self](#verification) [entry](SKILL.md#deployment) [other](../guide.md#topic) '
      + '[[#Deployment]] [[SKILL#Verification|verify]] [[SKILL.md#Deployment]]\n\n'
    const plan = split(introduction + '## Deployment\n\n' + links + padding + '### Verification\n\n' + padding)
    const body = bodies(plan).join('')
    expect(body).toContain('[self](../../../SKILL.md#verification)')
    expect(body).toContain('[entry](../../../SKILL.md#deployment)')
    expect(body).toContain('[other](../../../../guide.md#topic)')
    expect(body).toContain('[[../../../SKILL.md#Deployment]]')
    expect(body).toContain('[[../../../SKILL.md#Verification|verify]]')
    expect(plan.after).toContain('### Verification\n')
  })

  it('preserves Markdown-looking inline code, escaped labels, and fenced code', () => {
    const literal = '`[inline](fixture-guides/literal.md)` ``[[#Unknown]] `<tag>` `` \\[escaped](literal.md)\n\n'
    const code = '```\n[code](fixture-guides/literal.md)\n[id]: unresolved.md\n```\n\n'
    const plan = split(introduction + '## Literal\n\n' + literal + code + padding)
    expect(bodies(plan).join('')).toContain(literal + code)
  })

  it('rebases an image nested inside a Markdown link label', () => {
    const plan = split(introduction + '## Images\n\n[![image](images/a.png)](fixture-guides/b.md)\n\n' + padding)
    expect(bodies(plan).join('')).toContain('[![image](../../../images/a.png)](../../../fixture-guides/b.md)')
  })

  it('keeps complete inline code within list lines, quote lines, and table cells untouched', () => {
    const body = '## Examples\n\n- `[code](literal.md)` [guide](fixture-guides/list.md)\n\n'
      + '> `[code](literal.md)` [guide](fixture-guides/quote.md)\n\n'
      + '| Name | Detail |\n| --- | --- |\n| `a\\|b [code](literal.md)` | [guide](fixture-guides/table.md) |\n\n' + padding
    const plan = split(introduction + body)
    const moved = bodies(plan).join('')
    expect(moved).toContain('`[code](literal.md)` [guide](../../../fixture-guides/list.md)')
    expect(moved).toContain('`[code](literal.md)` [guide](../../../fixture-guides/quote.md)')
    expect(moved).toContain('`a\\|b [code](literal.md)` | [guide](../../../fixture-guides/table.md)')
  })

  it('preserves thematic breaks, paragraph interruptions, and top-level headings after containers', () => {
    const body = '## Topic\n\n***\n\nParagraph without a trailing blank\n- first\n\n'
      + '> quoted\n## After quote\n\n- item\n## After list\n\n'
      + '> one\n\n> two\n\n' + padding + '## Last'
    const plan = split(introduction + body)
    expect(bodies(plan).join('')).toBe(body)
    expect(plan.after).toContain('## After quote\n')
    expect(plan.after).toContain('## After list\n')
    expect(plan.after).toContain('## Last\n\n')
  })

  it('keeps fences as complete blocks when they interrupt a paragraph, list, or table', () => {
    const body = '## Topic\n\nParagraph\n```\ncode\n```\n\n'
      + '- item\n```\nmore code\n```\n\n'
      + '| a | b |\n| - | - |\n```\ntable successor\n```\n\n' + padding
    expect(bodies(split(introduction + body)).join('')).toBe(body)
  })

  it('keeps top-level autolinks, root-only fragments, and literal unmatched brackets', () => {
    const body = '## Topic\n\n<https://example.test> <reader@example.test> [root](#) [[#]]\n\n'
      + '[literal unclosed label\n\n' + padding
    const moved = bodies(split(introduction + body)).join('')
    expect(moved).toContain('<https://example.test> <reader@example.test>')
    expect(moved).toContain('[root](../../../SKILL.md#) [[../../../SKILL.md#]]')
    expect(moved).toContain('[literal unclosed label\n\n')
  })

  it('keeps escaped delimiters and exact backtick runs inside link labels and inline code', () => {
    const body = '## Topic\n\n[a \\[literal\\] `code`]( \tfixture-guides/guide.md) `a `` b`\n\n' + padding
    const moved = bodies(split(introduction + body)).join('')
    expect(moved).toContain('[a \\[literal\\] `code`]( \t../../../fixture-guides/guide.md) `a `` b`')
  })

  it('rejects an exact source receipt that exceeds the screen limit even when rebasing shortens its wrapping', () => {
    const line = 'a'.repeat(9) + ' [x](' + 'b'.repeat(80) + ') ccccc\n'
    expect(measureMarkdown(line).screenLines).toBe(3)
    expect(exception(introduction + '## Topic\n\n' + line.repeat(70) + '\n' + padding)).toMatch(/exact source fragment/)
  })

  it('returns no partial plan when an oversized later block follows a complete first topic', () => {
    expect(exception(introduction + '## Topic\n\nFirst bounded paragraph.\n\n' + 'word '.repeat(4000))).toMatch(/indivisible/)
  })

  it('rejects an oversized document with no later paragraph boundary', () => {
    expect(exception('a'.repeat(19000))).toMatch(/introduction/)
  })

  it('rejects an unclosed initial header and a terminal unfinished link destination', () => {
    expect(exception('---\nname: example\n' + padding)).toMatch(/Unclosed frontmatter/)
    expect(exception(introduction + '## Topic\n\n' + padding + '[x](   ')).toMatch(/Multiline/)
  })

  it('propagates an unexpected measurement failure without creating an exception plan', () => {
    const failure = new Error('Measurement unavailable')
    const measurement = vi.spyOn(markdownSize, 'markdownWithinLimit')
      .mockReturnValueOnce(false).mockImplementationOnce(() => { throw failure })
    try {
      expect(() => planMarkdownSplit(introduction + '## Topic\n\n' + padding)).toThrow(failure)
    } finally {
      measurement.mockRestore()
    }
  })

  it('leaves root-prefix links byte-for-byte unchanged while validating moved links', () => {
    const prefix = '# Skill\n\n[Intro](fixture-guides/intro.md)\n\n'
    const plan = split(prefix + '## Deployment\n\n[Detail](fixture-guides/detail.md)\n\n' + padding)
    expect(plan.after.startsWith(prefix)).toBe(true)
    expect(bodies(plan).join('')).toContain('[Detail](../../../fixture-guides/detail.md)')
  })

  it('uses the raw SHA256 for deterministic generation, paths, metadata, and links', () => {
    const raw = introduction + '## Topic\n\n' + padding
    const plan = split(raw, 'GUIDE.md')
    const hash = createHash('sha256').update(raw).digest('hex')
    expect(plan).toEqual(planMarkdownSplit(raw, 'GUIDE.md'))
    expect(plan.generation).toBe(hash)
    expect(plan.generation).toMatch(/^[a-f0-9]{64}$/)
    for (const [at, file] of plan.files.filter(file => file.path.startsWith('topics/')).entries()) {
      expect(file.path).toMatch(new RegExp(`^topics/${String(at + 1).padStart(3, '0')}-topic\\.md$`))
      expect(file.content).toContain('source_file: "GUIDE.md"\nsource_sha256: ' + hash)
      expect(file.content).toContain('[Back to GUIDE.md](../../../GUIDE.md#topic)')
      expect(plan.after).toContain(`.y-topics/${hash}/${file.path}`)
    }
    expect(split(raw + '\n', 'GUIDE.md').generation).not.toBe(hash)
  })

  it('records contiguous inclusive source line ranges with metadata included in every budget', () => {
    const raw = introduction + '## Topic\n\n' + padding
    const plan = split(raw)
    const sourceLines = raw.split('\n')
    let next = introduction.split('\n').length
    for (const file of plan.files.filter(file => file.path.startsWith('topics/'))) {
      const match = /source_lines: "(\d+)-(\d+)"/.exec(file.content)!
      const start = Number(match[1]); const end = Number(match[2])
      expect(start).toBe(next)
      const body = file.content.replace(/^---\n[\s\S]*?\n---\n\n\[Back to [^\n]+\n\n/, '')
      expect(body).toBe(sourceLines.slice(start - 1, end).join('\n') + '\n')
      expect(measureMarkdown(file.content).screenLines).toBeLessThanOrEqual(200)
      next = end + 1
    }
    expect(next).toBe(sourceLines.length)
  })

  it('retains exact source fragments and an exact root receipt alongside safely rebased topics', () => {
    const raw = introduction + '## Topic\n\n[guide](fixture-guides/guide.md) [[#Topic]]\n\n' + padding + 'Final paragraph without a terminal newline.'
    const plan = split(raw)
    const source = plan.files.filter(file => file.path.startsWith('source/'))
    expect(source.map(file => file.content).join('')).toBe(raw)
    expect(source.map(file => file.path)).toEqual(source.map((_file, at) => `source/${String(at).padStart(4, '0')}.txt`))
    expect(source[0]!.content).toBe(introduction)
    expect(plan.files.find(file => file.path === 'entry.txt')?.content).toBe(plan.after)
    expect(plan.files).toHaveLength(2 * bodies(plan).length + 2)
    expect(plan.files.every(file => markdownWithinLimit(file.content))).toBe(true)
    expect(bodies(plan).join('')).toContain('[guide](../../../fixture-guides/guide.md)')
    expect(createHash('sha256').update(source.map(file => file.content).join('')).digest('hex')).toBe(plan.generation)
  })

  it('uses UTF-8 byte limits on complete multibyte child documents', () => {
    const paragraph = '界'.repeat(7000) + '\n\n'
    const raw = introduction + '## 字符\n\n' + paragraph + paragraph
    const plan = split(raw)
    expect(bodies(plan).join('')).toBe('## 字符\n\n' + paragraph + paragraph)
    expect(bodies(plan)).toHaveLength(2)
    expect(plan.files.every(file => measureMarkdown(file.content).bytes <= 25 * 1024)).toBe(true)
    expect(exception(introduction + '## 字符\n\n' + '界'.repeat(8600))).toMatch(/indivisible/)
  })

  it.each([62, 64])('admits %i complete generation files without a recursive index', (count) => {
    const block = 'x'.repeat(16000) + '\n\n'
    const plan = split(introduction + '## Topic\n\n' + block.repeat((count - 2) / 2))
    expect(plan.files).toHaveLength(count)
    expect(plan.files.every(file => /^(?:topics\/[^/]+\.md|source\/\d{4}\.txt|entry\.txt)$/.test(file.path))).toBe(true)
    expect(plan.files.every(file => markdownWithinLimit(file.content))).toBe(true)
    expect(markdownWithinLimit(plan.after)).toBe(true)
  })

  it('returns no partial plan when the topics and receipts exceed 64 files', () => {
    expect(exception(introduction + '## Topic\n\n' + ('x'.repeat(16000) + '\n\n').repeat(32))).toMatch(/64 topic and receipt/)
  })

  it('rejects a long paragraph, oversized title and introduction, and oversized root index', () => {
    expect(exception(introduction + '## Topic\n\n' + 'word '.repeat(4000))).toMatch(/indivisible/)
    expect(exception('# Skill\n\n' + 'x\n'.repeat(205) + '\n## Topic\n\nbody.')).toMatch(/introduction/)
    const sections = Array.from({ length: 70 }, (_, at) => `## Topic ${at}\n\nbody.\n\n`).join('')
    expect(exception(introduction + sections)).toMatch(/64 topic|index/)
    const fewer = Array.from({ length: 30 }, (_, at) => `## Topic ${at} ${'wide '.repeat(30).trimEnd()}\n\nbody.\n\n`).join('')
    expect(exception(introduction + fewer + padding)).toMatch(/index/)
  })

  it.each([
    ['duplicate headings', '## Same\n\nbody.\n\n## Same\n\n', /Repeated/],
    ['case duplicate anchors', '## Same\n\nbody.\n\n## SAME\n\n', /Repeated/],
    ['explicit IDs', '## Topic {#custom}\n\n', /Heading/],
    ['emphasis in a heading', '## _Topic_\n\n', /Heading/],
    ['heading lowercase produces a combining mark', '## İ\n\n', /Heading/],
    ['setext heading', 'Topic\n=====\n\n', /Setext/],
    ['pipe-bearing setext heading', 'A | B\n---\n\n', /Setext/],
    ['unclosed fence', '## Topic\n\n```\ncode\n', /Unclosed fenced/],
    ['ambiguous fence info', '## Topic\n\n```bad`language\ncode\n```\n\n', /Ambiguous fenced/],
    ['empty heading', '## Topic\n\n#\n\n', /Empty/],
    ['indented table row', '## Topic\n\n| a | b |\n| - | - |\n    row\n\n', /Indented table/],
    ['oversized fence', '## Topic\n\n```\n' + 'code\n'.repeat(201) + '```\n\n', /indivisible/],
    ['oversized table', '## Topic\n\n| a | b |\n| - | - |\n' + '| a | b |\n'.repeat(201) + '\n', /indivisible/],
    ['table with unpiped rows near the limit', '## Topic\n\n| a | b |\n| - | - |\n' + '| a | b |\n'.repeat(180) + 'row\n'.repeat(12) + '\n', /indivisible/],
    ['heading interrupting a table', '## Topic\n\n| a | b |\n| - | - |\n## Heading with pipe | text\n\n', /Heading/],
    ['oversized list', '## Topic\n\n' + '- item\n'.repeat(201) + '\n', /indivisible/],
    ['oversized callout', '## Topic\n\n> [!NOTE]\n' + '> line\n'.repeat(201) + '\n', /indivisible/],
    ['reference definition', '## Topic\n\n[x][ref]\n\n[ref]: fixture-guides/ref.md\n\n', /Reference/],
    ['unused reference definition', '## Topic\n\n[ref]: fixture-guides/ref.md\n\n', /Reference/],
    ['reference definition in a list', '## Topic\n\n- [ref]: fixture-guides/ref.md\n\n', /Reference/],
    ['reference definition in nested lists', '## Topic\n\n- - [ref]: fixture-guides/ref.md\n\n- use [ref]\n\n', /Reference/],
    ['reference definition in a quoted list', '## Topic\n\n> - > [ref]: fixture-guides/ref.md\n>\n> use [ref]\n\n', /Reference/],
    ['footnote', '## Topic\n\nText[^one].\n\n', /Footnotes/],
    ['raw HTML', '## Topic\n\n<a href="relative.md">link</a>\n\n', /HTML/],
    ['HTML in label', '## Topic\n\n[<b>link</b>](relative.md)\n\n', /HTML/],
    ['directive', '## Topic\n\n:::note\nbody\n:::\n\n', /extensions/],
    ['indented code', '## Topic\n\n    code\n\n', /Indented/],
    ['nested heading', '## Topic\n\n> ## Nested\n> body\n\n', /Nested/],
    ['nested setext heading', '## Topic\n\n> Nested\n> ===\n\n', /Nested/],
    ['nested list heading in a quote', '## Topic\n\n> - ## Nested\n>   body\n\n', /Nested/],
    ['indented code in a quote', '## Topic\n\n>     [code](fixture-guides/code.md)\n\n', /Indented/],
    ['indented code in a list', '## Topic\n\n- item\n\n      [code](fixture-guides/code.md)\n\n', /Indented/],
    ['nested fence', '## Topic\n\n- item\n  ```\n  code\n  ```\n\n', /Nested/],
    ['unsafe URL', '## Topic\n\n[x](javascript:alert(1))\n\n', /URL schemes/],
    ['escaped scheme', '## Topic\n\n[x](javascript&#58;alert)\n\n', /ambiguous/],
    ['unknown self anchor', '## Topic\n\n[x](#missing)\n\n', /anchor/],
    ['invalid fragment encoding', '## Topic\n\n[x](#%ZZ)\n\n', /encoding/],
    ['unresolved wiki page', '## Topic\n\n[[Other#Topic]]\n\n', /Wiki/],
    ['wiki block anchor', '## Topic\n\n[[#^block]]\n\n', /anchor/],
    ['wiki embed', '## Topic\n\n![[#Topic]]\n\n', /wiki/],
    ['unclosed inline code', '## Topic\n\n`[x](relative.md)\n\n', /inline code/],
    ['multiline link', '## Topic\n\n[x](fixture-guides/ref.md\n "title")\n\n', /Multiline/],
    ['unfinished destination after spaces', '## Topic\n\n[x](   ', /Multiline/],
    ['unclosed angle destination', '## Topic\n\n[x](<fixture-guides/ref.md\n\n', /Unclosed link/],
    ['unbalanced destination', '## Topic\n\n[x](fixture-guides/a(b\n\n', /Unbalanced/],
    ['unclosed autolink', '## Topic\n\n<https://example.test\n\n', /HTML/],
    ['template expression', '## Topic\n\nText {% include "file" %}\n\n', /extensions/],
    ['wiki link inside Markdown label', '## Topic\n\n[outer [[#Topic]]](fixture-guides/outer.md)\n\n', /Wiki links inside/],
    ['deeply nested labels', '## Topic\n\n' + '[a '.repeat(17) + 'text' + ']'.repeat(17) + '(fixture-guides/ref.md)\n\n', /nested/],
    ['nested ordinary Markdown links', '## Topic\n\n[outer [inner](fixture-guides/inner.md)](fixture-guides/outer.md)\n\n', /Nested/],
    ['URL autolink inside a link label', '## Topic\n\n[outer <https://example.test>](fixture-guides/outer.md)\n\n', /Autolinks/],
    ['email autolink inside a link label', '## Topic\n\n[outer <reader@example.test>](fixture-guides/outer.md)\n\n', /Autolinks/],
    ['code span across list items', '## Topic\n\n- `first\n\n- [guide](fixture-guides/guide.md) `second\n\n', /inline code/],
    ['code span across callout paragraphs', '## Topic\n\n> `first\n>\n> [guide](fixture-guides/guide.md) `second\n\n', /inline code/],
    ['code span across table cells', '## Topic\n\n| A | B |\n| - | - |\n| `first | [guide](fixture-guides/guide.md) `second |\n\n', /inline code/],
    ['link label across list items', '## Topic\n\n- [outer\n\n- inner](fixture-guides/literal.md)\n\n', /Cross-line/],
    ['link label across callout paragraphs', '## Topic\n\n> [outer\n>\n> inner](fixture-guides/literal.md)\n\n', /Cross-line/],
    ['link label across table cells', '## Topic\n\n| A | B |\n| - | - |\n| [outer | inner](fixture-guides/literal.md) |\n\n', /Cross-line/],
    ['block ID', '## Topic\n\nbody. ^block-id\n\n', /block IDs/],
  ])('returns an explicit exception for %s', (_name, content, pattern) => {
    expect(exception(introduction + content + padding)).toMatch(pattern)
  })

  it('rejects CRLF splitting and non-simple entry filenames without exposing generated files', () => {
    expect(exception((introduction + '## Topic\n\n' + padding).replace(/\n/g, '\r\n'))).toMatch(/CRLF/)
    for (const name of ['../SKILL.md', 'nested/SKILL.md', 'SKILL.txt', '.hidden.md', 'a..md']) {
      expect(planMarkdownSplit('short', name)).toEqual({ kind: 'exception', reason: 'The entry name must be a simple Markdown filename.' })
    }
  })
})
