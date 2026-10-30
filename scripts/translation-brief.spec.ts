/** Regression tests for the minimal-update briefing assembly. */

import { describe, expect, it } from 'vitest'
import {
  changedSpanIndices,
  computeMechanicalUpdate,
  firstOccurrenceContext,
  markdownUnits,
  parseTerminologyRows,
  relevantTerminologyRows,
  renderTranslationBrief,
  sectionSpans,
  spansAligned,
  termOffsets,
} from './translation-brief.ts'

const DOC = [
  'Preamble line.',
  '',
  '# Title',
  '',
  'Intro paragraph.',
  '',
  '## First',
  '',
  'First body.',
  '',
  '```ts',
  'const value = 1',
  '```',
  '',
  '## Second',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '- item one',
  '- item two',
].join('\n')

describe('markdown spans', () => {
  it('lists units with container-scoped kinds in document order', () => {
    const kinds = markdownUnits(DOC).map(span => span.kind)
    expect(kinds).toEqual([
      'root.0:paragraph',
      'root.1:heading:1',
      'root.2:paragraph',
      'root.3:heading:2',
      'root.4:paragraph',
      'root.5:code',
      'root.6:heading:2',
      'root.7.0:tableRow',
      'root.7.1:tableRow',
      'root.8.0:listItem',
      'root.8.1:listItem',
    ])
  })

  it('lists heading sections with a preamble span and heading labels', () => {
    const sections = sectionSpans(DOC)
    expect(sections.map(span => span.label)).toEqual([
      '(preamble before the first heading)',
      'Title',
      'First',
      'Second',
    ])
    expect(sections[0]).toMatchObject({ startLine: 1, endLine: 2 })
    expect(sections[2]).toMatchObject({ startLine: 7, endLine: 14 })
  })

  it('labels units by their node type', () => {
    const units = markdownUnits(DOC)
    expect(units[0]!.label).toBe('paragraph')
    expect(units[1]!.label).toBe('heading')
    expect(units[7]!.label).toBe('tableRow')
  })

  it('aligns sections by depth only, so translated heading text still maps', () => {
    const zh = DOC.replace('## First', '## \u{7B2C}\u{4E00}\u{8282}').replace('## Second', '## \u{7B2C}\u{4E8C}\u{8282}').replace('# Title', '# \u{6807}\u{9898}')
    expect(spansAligned(sectionSpans(DOC), sectionSpans(zh))).toBe(true)
  })

  it('aligns span lists only on equal non-empty kind sequences', () => {
    const zh = DOC.replace('First body.', '\u{7B2C}\u{4E00}\u{6BB5}。').replace('item one', '\u{7B2C}\u{4E00}\u{9879}').replace('Intro paragraph.', '\u{5BFC}\u{8BED}。')
    expect(spansAligned(markdownUnits(DOC), markdownUnits(zh))).toBe(true)
    const reshaped = DOC.replace('- item one\n- item two', 'merged paragraph')
    expect(spansAligned(markdownUnits(DOC), markdownUnits(reshaped))).toBe(false)
    expect(spansAligned([], [])).toBe(false)
  })

  it('reports the indices whose text changed', () => {
    const edited = DOC.replace('First body.', 'First body, revised.').replace('| 1 | 2 |', '| 1 | 3 |')
    expect(changedSpanIndices(markdownUnits(DOC), markdownUnits(edited))).toEqual([4, 8])
  })
})

describe('mechanical code updates', () => {
  const en = '# T\n\nProse.\n\n```sh\nrun one\n```\n'
  const zh = '# T\n\n\u{4E2D}\u{6587}。\n\n```sh\nrun one\n```\n'

  it('splices a fence-only edit into the counterpart', () => {
    const edited = en.replace('run one', 'run two')
    expect(computeMechanicalUpdate(en, edited, zh)).toBe(zh.replace('run one', 'run two'))
  })

  it('refuses when prose changed too', () => {
    const edited = en.replace('Prose.', 'Prose!').replace('run one', 'run two')
    expect(computeMechanicalUpdate(en, edited, zh)).toBeUndefined()
  })

  it('refuses when the counterpart fences already diverge from last-confirmed', () => {
    const edited = en.replace('run one', 'run two')
    expect(computeMechanicalUpdate(en, edited, zh.replace('run one', 'run stale'))).toBeUndefined()
  })

  it('refuses when fence counts differ or nothing changed', () => {
    expect(computeMechanicalUpdate(en, `${en}\n\`\`\`sh\nextra\n\`\`\`\n`, zh)).toBeUndefined()
    expect(computeMechanicalUpdate(en, en, zh)).toBeUndefined()
  })
})

const TERMINOLOGY = [
  '| English | \u{4E2D}\u{6587} | \u{9996}\u{6B21}\u{51FA}\u{73B0} | \u{4E0D}\u{8981}\u{8BD1}\u{4F5C} | \u{5907}\u{6CE8} |',
  '|---|---|---|---|---|',
  '| agent | agent | agent（\u{667A}\u{80FD}\u{4F53}） | \u{667A}\u{80FD}\u{4F53} | |',
  '| session log | \u{4F1A}\u{8BDD}\u{65E5}\u{5FD7} | | \u{4F1A}\u{8BDD}\u{8BB0}\u{5F55} | |',
  '| gate | \u{95E8}\u{7981} | | | |',
  '| registry | \u{6CE8}\u{518C}\u{8868} | | | |',
].join('\n')

describe('terminology', () => {
  it('parses data rows and skips the header and separator', () => {
    const rows = parseTerminologyRows(TERMINOLOGY)
    expect(rows.map(row => row.english)).toEqual(['agent', 'session log', 'gate', 'registry'])
    expect(rows[0]).toMatchObject({ chinese: 'agent', first: 'agent（\u{667A}\u{80FD}\u{4F53}）' })
  })

  it('matches English terms on word boundaries with plural inflections', () => {
    expect(termOffsets('two agents met', 'agent', true)).toEqual([4])
    expect(termOffsets('two registries', 'registry', true)).toEqual([4])
    expect(termOffsets('reagents', 'agent', true)).toEqual([])
    expect(termOffsets('', 'agent', true)).toEqual([])
  })

  it('selects rows for the changed text per direction', () => {
    expect(relevantTerminologyRows(TERMINOLOGY, 'en-to-zh', 'All agents write a session log.').map(row => row.english))
      .toEqual(['agent', 'session log'])
    expect(relevantTerminologyRows(TERMINOLOGY, 'zh-to-en', '\u{95E8}\u{7981}\u{5728}\u{63D0}\u{4EA4}\u{65F6}\u{8FD0}\u{884C}。').map(row => row.english))
      .toEqual(['gate'])
    expect(relevantTerminologyRows(TERMINOLOGY, 'en-to-zh', 'delegate the work')).toEqual([])
  })

  it('decodes escaped legacy rows before matching translated text', () => {
    const encoded = String.raw`| English | \u{4E2D}\u{6587} | \u{9996}\u{6B21}\u{51FA}\u{73B0} | \u{4E0D}\u{8981}\u{8BD1}\u{4F5C} | \u{5907}\u{6CE8} |
|---|---|---|---|---|
| gate | \u{95E8}\u{7981} | | | |`
    const chinese = String.fromCodePoint(0x95e8, 0x7981)
    expect(parseTerminologyRows(encoded)[0]).toMatchObject({ chinese, line: `| gate | ${chinese} | | | |` })
    expect(relevantTerminologyRows(encoded, 'zh-to-en', `${chinese} runs here`)).toHaveLength(1)
  })
})

describe('first-occurrence tracking', () => {
  const before = '# T\n\nAlpha paragraph.\n\nThe agent runs.\n'
  const after = '# T\n\nAlpha paragraph with an agent.\n\nThe agent runs.\n'
  const rows = parseTerminologyRows(TERMINOLOGY).filter(row => row.english === 'agent')

  it('flags a moved first occurrence and pulls the vacated span in', () => {
    const context = firstOccurrenceContext(
      before, after, markdownUnits(before), markdownUnits(after), rows, new Set([1]),
    )
    expect(context.notes).toHaveLength(1)
    expect(context.notes[0]).toContain('moved from #2 to #1')
    expect(context.extraSpanIndices).toEqual([2])
  })

  it('stays silent when the first occurrence does not move', () => {
    const unmoved = before.replace('Alpha paragraph.', 'Alpha paragraph, revised.')
    const context = firstOccurrenceContext(
      before, unmoved, markdownUnits(before), markdownUnits(unmoved), rows, new Set([1]),
    )
    expect(context.notes).toEqual([])
    expect(context.extraSpanIndices).toEqual([])
  })

  it('ignores rows without a first-occurrence rendering', () => {
    const bare = parseTerminologyRows(TERMINOLOGY).filter(row => row.english === 'gate')
    const withGate = after.replace('The agent runs.', 'The gate runs.')
    const context = firstOccurrenceContext(
      before, withGate, markdownUnits(before), markdownUnits(withGate), bare, new Set([2]),
    )
    expect(context.notes).toEqual([])
  })
})

describe('brief rendering', () => {
  const base = {
    sourcePath: 'docs/foo.md',
    counterpartPath: 'docs/foo.zh.md',
    direction: 'en-to-zh' as const,
    diff: '@@ -5 +5 @@\n-old text about the agent\n+new text about the agent',
    terminology: relevantTerminologyRows(TERMINOLOGY, 'en-to-zh', 'the agent'),
  }
  const bundle = {
    index: 4,
    label: 'paragraph',
    confirmedSourceText: 'old text about the agent\n',
    currentSourceText: 'new text about the agent\n',
    counterpartText: '\u{5173}\u{4E8E} agent \u{7684}\u{65E7}\u{6587}\u{672C}\n',
    counterpartStartLine: 9,
  }

  it('renders unit bundles with three-way context and line anchors', () => {
    const brief = renderTranslationBrief({
      ...base,
      scope: { kind: 'units', bundles: [bundle], firstOccurrenceNotes: ['agent: the document-wide first occurrence moved from #2 to #1; the agent（\u{667A}\u{80FD}\u{4F53}） form moves with it (later occurrences drop the annotation).'] },
    })
    expect(brief).toContain('# Translation update briefing: docs/foo.md')
    expect(brief).toContain('## Changed units')
    expect(brief).toContain('### #4 paragraph — counterpart at docs/foo.zh.md:9')
    expect(brief).toContain('Last-confirmed English:')
    expect(brief).toContain('Current Chinese (bring this along):')
    expect(brief).toContain('## First-occurrence notes')
    expect(brief).toContain('agent（\u{667A}\u{80FD}\u{4F53}）')
    expect(brief).toContain('\u{9996}\u{6B21}\u{51FA}\u{73B0} annotations attach to the document-wide first occurrence only')
    expect(brief).toContain('targets in the active bilingual corpus use `.zh.md` for Chinese')
    expect(brief).toContain('a missing in-scope counterpart is an error')
    expect(brief).toContain('verify-translation-pairing --write docs/foo.md')
  })

  it('marks first-occurrence bundles and omits their unchanged confirmed text', () => {
    const brief = renderTranslationBrief({
      ...base,
      scope: {
        kind: 'units',
        bundles: [{ ...bundle, reason: 'first-occurrence', confirmedSourceText: bundle.currentSourceText }],
        firstOccurrenceNotes: [],
      },
    })
    expect(brief).toContain('unchanged; included for a first-occurrence move')
    expect(brief).not.toContain('Last-confirmed English:')
  })

  it('renders the mechanical scope with the --apply command', () => {
    const brief = renderTranslationBrief({ ...base, scope: { kind: 'mechanical' } })
    expect(brief).toContain('## Mechanical update — no translation judgment involved')
    expect(brief).toContain('gen-translation-brief --apply docs/foo.md')
    expect(brief).not.toContain('## Changed units')
  })

  it('renders the section fallback under its own heading', () => {
    const brief = renderTranslationBrief({
      ...base,
      scope: { kind: 'sections', bundles: [bundle], firstOccurrenceNotes: [] },
    })
    expect(brief).toContain('## Changed sections')
    expect(brief).toContain('fine-grained units do not align')
  })

  it('renders the document fallback with its reason and no bundles', () => {
    const brief = renderTranslationBrief({
      ...base,
      scope: { kind: 'document', reason: 'BOTH sides changed since the pair was last confirmed consistent, so no side is a trustworthy mapping anchor; decide which side owns each divergence.' },
    })
    expect(brief).toContain('## Whole-document update required')
    expect(brief).toContain('BOTH sides changed')
    expect(brief).toContain('locate the affected regions yourself')
  })

  it('renders the English-target digest for zh-to-en updates', () => {
    const brief = renderTranslationBrief({
      ...base,
      direction: 'zh-to-en',
      sourcePath: 'docs/foo.zh.md',
      counterpartPath: 'docs/foo.md',
      scope: { kind: 'units', bundles: [bundle], firstOccurrenceNotes: [] },
    })
    expect(brief).toContain('exactly what the new Chinese states')
    expect(brief).toContain('targets in the active bilingual corpus use `.md` for English')
    expect(brief).toContain('targets outside the corpus keep the authored path')
    expect(brief).toContain('verify-translation-pairing --write docs/foo.md')
  })

  it('grows bundle fences past tilde runs in the text', () => {
    const brief = renderTranslationBrief({
      ...base,
      scope: {
        kind: 'units',
        bundles: [{ ...bundle, counterpartText: '~~~~\ninner\n~~~~\n' }],
        firstOccurrenceNotes: [],
      },
    })
    expect(brief).toContain('~~~~~markdown')
  })
})
