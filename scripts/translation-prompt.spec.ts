/** Unit tests for the prompt-v7 content and unchanged three-section protocol. */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  consumeTranslationResponse,
  parseTranslationResponse,
  renderTranslationPrompt,
  renderTranslationRequest,
  renderTranslationResponse,
} from './translation-prompt.ts'
import { decodeUnicodeEscapes } from './legacy-unicode.ts'

const root = resolve(import.meta.dirname, '..')
const document = readFileSync(join(root, 'docs/i18n/translation-prompt.md'), 'utf8')
const decodedDocument = decodeUnicodeEscapes(document)
const terminology = '| English | \u{4E2D}\u{6587} |\n|---|---|\n| agent | agent |'

const retainedExamples = [
  ['### Colloquial verb → Professional verb', 'The repo pins pnpm@11.7.0 in package.json', '\u{8BE5}\u{4ED3}\u{5E93}\u{5728} package.json \u{4E2D}\u{56FA}\u{5B9A}\u{4F7F}\u{7528} pnpm@11.7.0'],
  ['### Run-on sentence → Natural phrasing with pause', 'Read docs/architecture.md before changing anything under packages/.', '\u{5728}\u{4FEE}\u{6539} packages/ \u{76EE}\u{5F55}\u{4E0B}\u{7684}\u{4EFB}\u{4F55}\u{5185}\u{5BB9}\u{4E4B}\u{524D}，\u{8BF7}\u{5148}\u{9605}\u{8BFB} docs/architecture.md。'],
  ['### Stiff passive voice → Active and natural', 'a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound.', '\u{95E8}\u{7981}\u{901A}\u{8FC7}\u{610F}\u{5473}\u{7740}\u{8FD9}\u{7EC4}\u{6587}\u{6863}\u{5728}\u{5F53}\u{524D}\u{5185}\u{5BB9}\u{4E0A}\u{7684}\u{4E00}\u{81F4}\u{6027}\u{5F97}\u{5230}\u{4E86}\u{786E}\u{8BA4}，\u{4E0D}\u{4EE3}\u{8868}\u{786E}\u{8BA4}\u{672C}\u{8EAB}\u{6B63}\u{786E}\u{53EF}\u{9760}。'],
  ['### Invented word → Natural expression', 'A sidecar record of both blob hashes makes consistency checkable', '\u{4F34}\u{968F}\u{8BB0}\u{5F55}\u{4FDD}\u{5B58}\u{4E24}\u{4FA7} blob hash，\u{4F7F}\u{4E00}\u{81F4}\u{6027}\u{53EF}\u{68C0}\u{67E5}'],
  ['### Em-dash → Colon/period', 'FIXME — an issue that should block a new release.', 'FIXME：\u{5E94}\u{5F53}\u{963B}\u{585E}\u{65B0}\u{7248}\u{672C}\u{53D1}\u{5E03}\u{7684}\u{95EE}\u{9898}。'],
  ['### Overly literal → Meaningful rendering', 'awkward phrasing is easier to notice when you read the translation without comparing it with the source', '\u{4E0D}\u{5BF9}\u{7167}\u{539F}\u{6587}\u{9605}\u{8BFB}\u{8BD1}\u{6587}\u{65F6}，\u{66F4}\u{5BB9}\u{6613}\u{5BDF}\u{89C9}\u{522B}\u{626D}\u{7684}\u{8868}\u{8FBE}'],
  ['### Terminology — do not translate what should be kept in English', 'typed service seams, and explicit extension points', '\u{7C7B}\u{578B}\u{5316}\u{7684}\u{670D}\u{52A1} seam \u{4E0E}\u{663E}\u{5F0F}\u{6269}\u{5C55}\u{70B9}'],
  ['### Slang/jargon → Professional phrasing', 'The committed agent workflow lives in .agents/skills/dsh-translate-docs', '\u{4ED3}\u{5E93}\u{5185}\u{7F6E}\u{7684} agent \u{5DE5}\u{4F5C}\u{6D41}\u{89C1} .agents/skills/dsh-translate-docs'],
  ['### "For humans" — translate the intent, not the word', 'For humans, start with the development guide', '\u{9762}\u{5411}\u{5F00}\u{53D1}\u{8005}：\u{8BF7}\u{5148}\u{9605}\u{8BFB}\u{5F00}\u{53D1}\u{6307}\u{5357}'],
  ['### Code block comments — NEVER translate', '# full-screen TUI coding agent (needs DEEPSEEK_API_KEY)', 'keep exactly as-is, byte-for-byte'],
  ['### Language switcher — flip direction', 'English | [\u{4E2D}\u{6587}](README.zh.md)', '[English](README.md) | \u{4E2D}\u{6587}'],
]

describe('translation prompt rendering', () => {
  it('renders both directions with every placeholder resolved', () => {
    const en = renderTranslationPrompt(document, { sourceLanguage: 'English', sourceFilename: 'guide.md', terminology })
    expect(en).toContain('from English to Chinese')
    expect(en).toContain(terminology)
    expect(en).not.toContain('{{')
    expect(en).toContain('plain source stays plain (\u{5FC5}\u{987B})')
    expect(en).toContain('For an English target, use the established English technical term')
    expect(en).toContain('does a Chinese target use an established Chinese rendering')
    expect(en).toContain('does an English target use the established English technical term')
    expect(en).toContain('The parser removes exactly one framing escape')
    const zh = renderTranslationPrompt(document, { sourceLanguage: 'Chinese', sourceFilename: 'guide.zh.md', terminology })
    expect(zh).toContain('from Chinese to English')
  })

  it('contains every embedded example', () => {
    for (const example of retainedExamples) {
      for (const fragment of example) expect(decodedDocument).toContain(fragment)
    }
  })

  it('states the selected v7 safeguards', () => {
    const rendered = renderTranslationPrompt(document, { sourceLanguage: 'English', sourceFilename: 'guide.md', terminology })
    expect(rendered).toContain('## Priority')
    expect(rendered).toContain('### Faithfulness')
    expect(rendered).toContain('do not invent a filename or switcher')
    expect(rendered).toContain('Markdown emphasis markers do not create a word boundary')
    expect(rendered).toContain('Never invent responsibility merely to avoid a passive construction')
    expect(rendered).toContain('Never vary a terminology-table form, defined concept, or contract verb merely for stylistic variety')
    expect(rendered).toContain('Chinese output uses its `.zh.md` path')
    expect(rendered).toContain('belongs to the active bilingual corpus')
    expect(rendered).toContain('a missing counterpart in that corpus is an error')
    expect(rendered).toContain('exact query/fragment suffix')
    expect(rendered).toContain('Return exactly three raw XML sections')
  })

  it('rejects a template with unknown or missing placeholders', () => {
    const alien = document.replaceAll('{{terminology}}', '{{terms_prompt}}')
    expect(() => renderTranslationPrompt(alien, { sourceLanguage: 'English', sourceFilename: 'guide.md', terminology })).toThrow(/unsupported placeholder/)
    const missing = document.replaceAll('{{terminology}}', '')
    expect(() => renderTranslationPrompt(missing, { sourceLanguage: 'English', sourceFilename: 'guide.md', terminology })).toThrow(/required placeholder/)
  })

  it('rejects unmatched placeholder delimiters', () => {
    for (const delimiter of ['{{', '}}']) {
      const malformed = document.replace('Your task is to translate', `Your task ${delimiter} is to translate`)
      expect(() => renderTranslationPrompt(malformed, {
        sourceLanguage: 'English',
        sourceFilename: 'guide.md',
        terminology,
      })).toThrow(/malformed placeholder syntax/)
    }
  })

  it('assembles bare few-shot turns before the real source document', () => {
    const request = renderTranslationRequest(document, {
      sourceLanguage: 'English',
      sourceFilename: 'guide.md',
      sourceDocument: '# Guide\n\nNew source.',
      terminology,
      examples: [{ english: '# Example\n\nEnglish.', chinese: '# \u{793A}\u{4F8B}\n\n\u{4E2D}\u{6587}。' }],
    })
    expect(request.targetFilename).toBe('guide.zh.md')
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(request.messages.slice(1).map(message => message.content)).toEqual([
      '# Example\n\nEnglish.',
      '# \u{793A}\u{4F8B}\n\n\u{4E2D}\u{6587}。',
      '# Guide\n\nNew source.',
    ])

    const reverse = renderTranslationRequest(document, {
      sourceLanguage: 'Chinese',
      sourceFilename: 'guide.zh.md',
      sourceDocument: '# \u{6307}\u{5357}\n\n\u{65B0}\u{6E90}\u{6587}。',
      terminology,
      examples: [{ english: '# Example\n\nEnglish.', chinese: '# \u{793A}\u{4F8B}\n\n\u{4E2D}\u{6587}。' }],
    })
    expect(reverse.targetFilename).toBe('guide.md')
    expect(reverse.messages.slice(1).map(message => message.content)).toEqual([
      '# \u{793A}\u{4F8B}\n\n\u{4E2D}\u{6587}。',
      '# Example\n\nEnglish.',
      '# \u{6307}\u{5357}\n\n\u{65B0}\u{6E90}\u{6587}。',
    ])
  })
})

describe('translation response sections', () => {
  it('round-trips Markdown bodies', () => {
    const response = { translation: '# \u{6807}\u{9898}\n\n\u{6B63}\u{6587} **\u{52A0}\u{7C97}**。', review: '- [Tone] \u{4FEE}\u{6B63}\u{4E00}\u{5904}。\n- \u{65E0}\u{4FEE}\u{6B63}', final: '# \u{6807}\u{9898}\n\n\u{5B9A}\u{7A3F}。' }
    expect(parseTranslationResponse(renderTranslationResponse(response))).toEqual(response)
  })

  it('tolerates a fenced xml wrapper around the whole response', () => {
    const fenced = '```xml\n<translation>\nA\n</translation>\n\n<review>\n- \u{65E0}\u{4FEE}\u{6B63}\n</review>\n\n<final>\nA\n</final>\n```'
    expect(parseTranslationResponse(fenced).final).toBe('A')
  })

  it('keeps an inline close tag inside prose from terminating the section', () => {
    const doc = { translation: 'the wire format uses </translation> as its close tag', review: '- \u{65E0}\u{4FEE}\u{6B63}', final: 'F' }
    expect(parseTranslationResponse(renderTranslationResponse(doc))).toEqual(doc)
  })

  it('round-trips wrapper-tag lines inside Markdown bodies', () => {
    const doc = {
      translation: '```xml\n</translation>\n```',
      review: '- [Structure] Preserved `<final>` on its own line.',
      final: 'literal delimiters\n</final>\n\\</final>',
    }
    const rendered = renderTranslationResponse(doc)
    expect(parseTranslationResponse(rendered)).toEqual(doc)
    expect(() => parseTranslationResponse(rendered.replace('\\</translation>', '</translation>'))).toThrow(/duplicate <translation>/)
  })

  it('rejects a duplicate section appearing before final', () => {
    const early = '<translation>\nA\n</translation>\n<translation>\nB\n</translation>\n<review>\nR\n</review>\n<final>\nF\n</final>'
    expect(() => parseTranslationResponse(early)).toThrow(/duplicate <translation>/)
  })

  it('rejects missing, unterminated, or duplicated sections', () => {
    expect(() => parseTranslationResponse('<translation>\nA\n</translation>')).toThrow(/missing or unterminated <review>/)
    expect(() => parseTranslationResponse('<translation>\nA')).toThrow(/missing or unterminated <translation>/)
    const dup = '<translation>\nA\n</translation>\n<review>\nR\n</review>\n<final>\nF\n</final>\n<final>\nG\n</final>'
    expect(() => parseTranslationResponse(dup)).toThrow(/duplicate <final>/)
    expect(() => parseTranslationResponse(`${renderTranslationResponse({ translation: 'A', review: 'R', final: 'F' })}\nstray`))
      .toThrow(/content is not allowed outside/)
  })

  it('inserts or corrects the target switcher after parsing a new-pair response', () => {
    const response = renderTranslationResponse({
      translation: '# \u{6307}\u{5357}\n\n\u{521D}\u{7A3F}。',
      review: '- \u{65E0}\u{4FEE}\u{6B63}',
      final: '# \u{6307}\u{5357}\n\nEnglish | [\u{4E2D}\u{6587}](guide.zh.md)\n\n\u{5B9A}\u{7A3F}。',
    })
    expect(consumeTranslationResponse(response, { sourceLanguage: 'English', sourceFilename: 'guide.md' }).final).toBe([
      '# \u{6307}\u{5357}',
      '',
      '[English](guide.md) | \u{4E2D}\u{6587}',
      '',
      '\u{5B9A}\u{7A3F}。',
      '',
    ].join('\n'))
  })

  it('preserves YAML frontmatter before inserting the target switcher', () => {
    const response = renderTranslationResponse({
      translation: '# \u{6307}\u{5357}\n\n\u{521D}\u{7A3F}。',
      review: '- \u{65E0}\u{4FEE}\u{6B63}',
      final: [
        '---',
        'layout: home',
        '---',
        '',
        '# \u{6307}\u{5357}',
        '',
        '\u{5B9A}\u{7A3F}。',
      ].join('\n'),
    })
    expect(consumeTranslationResponse(response, { sourceLanguage: 'English', sourceFilename: 'guide.md' }).final).toBe([
      '---',
      'layout: home',
      '---',
      '',
      '# \u{6307}\u{5357}',
      '',
      '[English](guide.md) | \u{4E2D}\u{6587}',
      '',
      '\u{5B9A}\u{7A3F}。',
      '',
    ].join('\n'))
  })

  it('rejects unterminated YAML frontmatter before the target H1', () => {
    const response = renderTranslationResponse({
      translation: '# \u{6307}\u{5357}\n\n\u{521D}\u{7A3F}。',
      review: '- \u{65E0}\u{4FEE}\u{6B63}',
      final: '---\nlayout: home\n\n# \u{6307}\u{5357}\n\n\u{5B9A}\u{7A3F}。',
    })
    expect(() => consumeTranslationResponse(response, {
      sourceLanguage: 'English',
      sourceFilename: 'guide.md',
    })).toThrow(/unterminated YAML frontmatter/)
  })

  it('rejects a source filename that contradicts the translation direction', () => {
    expect(() => renderTranslationPrompt(document, {
      sourceLanguage: 'Chinese',
      sourceFilename: 'guide.md',
      terminology,
    })).toThrow(/does not match source language Chinese/)
  })

  it('inserts the English target switcher for a Chinese source', () => {
    const response = renderTranslationResponse({
      translation: '# Guide\n\nDraft.',
      review: '- [None] No corrections.',
      final: '# Guide\n\nFinal.',
    })
    expect(consumeTranslationResponse(response, {
      sourceLanguage: 'Chinese',
      sourceFilename: 'guide.zh.md',
    }).final).toContain('\n\nEnglish | [\u{4E2D}\u{6587}](guide.zh.md)\n\n')
  })
})
