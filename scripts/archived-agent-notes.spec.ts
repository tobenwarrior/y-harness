import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  gitBlobHash,
  parseArchiveManifest,
  renderArchiveManifest,
  rewriteArchiveEnglishOnlySource,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

function fixture(): Map<string, Buffer> {
  const base = '2026-07-26-example'
  const source = Buffer.from(`# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [translation](${base}.zh.md)\n\n## Problem\n\nExample.\n`)
  const zh = Buffer.from(`# Agent Note: Translated Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n[English](${base}.md) | translation\n\n## Problem\n\nTranslated example.\n`)
  const meta = Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`)
  return new Map([
    [`process/${base}.md`, source],
    [`process/${base}.zh.md`, zh],
    [`process/${base}.i18n.yaml`, meta],
  ])
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one complete implemented triplet with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it.each(['# Agent Note: Example', '# Historical decision'])('preserves historical formatting: %s', (title) => {
    const artifacts = fixture()
    const base = '2026-07-26-example'
    const source = Buffer.from(`${title}\nStatus: implemented\nArchived: 2026-07-26\n[translation](${base}.zh.md)\n`)
    artifacts.set(`process/${base}.md`, source)
    const zh = artifacts.get(`process/${base}.zh.md`)!
    artifacts.set(`process/${base}.i18n.yaml`, Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`))
    expect(validateArchiveArtifacts(artifacts)).toEqual([])
  })

  it.each([
    ['Status: proposed\nArchived: 2026-07-26', /requires `Status: implemented`/],
    ['Status: implemented\n\nArchived: 2026-07-26', /immediately after the status/],
    ['Status: implemented\nArchived: 2026-02-30', /valid date/],
    ['Status: implemented\nArchived: 2026-07-25', /predates the note filename/],
    ['Status: implemented\nArchived: 2026-07-27', /English and Chinese archive dates differ/],
    ['Archived: 2026-07-26\nStatus: implemented\nArchived: 2026-07-27', /English and Chinese archive dates differ/],
  ])('rejects invalid archive metadata: %s', (metadata, error) => {
    const artifacts = fixture()
    const base = '2026-07-26-example'
    const source = Buffer.from(`# Historical decision\n${metadata}\n`)
    artifacts.set(`process/${base}.md`, source)
    const zh = artifacts.get(`process/${base}.zh.md`)!
    artifacts.set(`process/${base}.i18n.yaml`, Buffer.from(`${base}.md: ${gitBlobHash(source)}\n${base}.zh.md: ${gitBlobHash(zh)}\n`))
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(error)
  })

  it('rejects incomplete triplets and invalid archive headers', () => {
    const artifacts = fixture()
    artifacts.delete('process/2026-07-26-example.i18n.yaml')
    artifacts.set(
      'process/2026-07-26-example.md',
      Buffer.from('# Agent Note: Example\n\nStatus: proposed\nArchived: yesterday\n'),
    )
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(/incomplete archived triplet/)
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const empty: ArchiveManifest = { version: 1, files: {} }
    const first = extendArchiveManifest(empty, artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toHaveLength(3)

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set('process/2026-07-26-example.md', Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed).errors).toEqual([
      'process/2026-07-26-example.md: sealed content hash changed',
    ])
    changed.delete('process/2026-07-26-example.zh.md')
    expect(extendArchiveManifest(sealed, changed).errors).toContain(
      'process/2026-07-26-example.zh.md: sealed artifact is missing',
    )
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const initial = extendArchiveManifest({ version: 1, files: {} }, artifacts)
    const baseline: ArchiveManifest = { version: 1, files: initial.files }
    const path = 'process/2026-07-26-example.md'
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(path, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts)
    const current: ArchiveManifest = { version: 1, files: replacement.files }

    expect(extendArchiveManifest(current, changedArtifacts).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([
      `${path}: sealed manifest hash changed`,
    ])
    const removed: ArchiveManifest = {
      version: 1,
      files: Object.fromEntries(Object.entries(current.files).filter(([candidate]) => candidate !== path)),
    }
    expect(validateArchiveManifestExtension(baseline, removed)).toContain(
      `${path}: sealed manifest entry is missing`,
    )
  })

  it('rewrites only the exact English-only migration surface', () => {
    const source = Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [translation](2026-07-26-example.zh.md)\n\n## Problem\n\nExample.\n')
    expect(rewriteArchiveEnglishOnlySource('feature/example.md', source).toString()).toBe(
      '# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n',
    )
    expect(() => rewriteArchiveEnglishOnlySource('feature/example.md', Buffer.from('no switcher\n'))).toThrow(
      'expected exactly one English translation switcher',
    )
  })

  it('rewrites retained Han evidence to its sealed English equivalent', () => {
    const source = Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [translation](2026-07-30-web-context-injection-disclosure.zh.md)\n\n`MessageItem` routes context nodes to `ContextInjectionRow`. The row starts collapsed, names the presentation `\u{4E0A}\u{4E0B}\u{6587}\u{6CE8}\u{5165}`, uses the existing browse glyph, and exposes the whole 24px header as one pointer and keyboard disclosure target. Its expanded body begins 4px below the header at the shared 22px content indent and renders the design\'s 141px scrollport with 8px radius, code-block background, 11/16 code text, and no border.\n')
    expect(rewriteArchiveEnglishOnlySource('feature/2026-07-30-web-context-injection-disclosure.md', source).toString()).toBe(
      '# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n`MessageItem` routes context nodes to `ContextInjectionRow`. The row starts collapsed, names the presentation `Context injection`, uses the existing browse glyph, and exposes the whole 24px header as one pointer and keyboard disclosure target. Its expanded body begins 4px below the header at the shared 22px content indent and renders the design\'s 141px scrollport with 8px radius, code-block background, 11/16 code text, and no border.\n',
    )
  })

  it('rejects Han text in a retained English-only note', () => {
    const artifacts = new Map([
      [
        'process/2026-07-26-example.md',
        Buffer.from('# Agent Note: Example\nStatus: implemented\nArchived: 2026-07-26\nEvidence: \u{6C49}\n'),
      ],
    ])
    expect(validateArchiveArtifacts(artifacts, 'English-only archive')).toEqual([
      'process/2026-07-26-example.md: English-only archived notes must not contain Han characters',
    ])
  })

  it('accepts the complete one-time translation-artifact retirement', () => {
    const baseline: ArchiveManifest = {
      version: 1,
      files: {
        'feature/example.md': 'sha256:' + '1'.repeat(64),
        'feature/example.zh.md': 'sha256:' + '2'.repeat(64),
        'feature/example.i18n.yaml': 'sha256:' + '3'.repeat(64),
      },
    }
    const current: ArchiveManifest = {
      version: 2,
      files: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
      retired: {
        'feature/example.i18n.yaml': 'sha256:' + '3'.repeat(64),
        'feature/example.zh.md': 'sha256:' + '2'.repeat(64),
      },
      rewritten: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
    }
    expect(validateArchiveManifestExtension(baseline, current)).toEqual([])
    expect(validateArchiveManifestExtension(baseline, {
      ...current,
      retired: { ...current.retired, 'feature/other.zh.md': 'sha256:' + '4'.repeat(64) },
    })).toContain('manifest version 2 must retire exactly the baseline translation artifacts')
  })

  it('freezes retired translation seals after migration', () => {
    const retired = { 'feature/example.zh.md': 'sha256:' + '2'.repeat(64) }
    const baseline: ArchiveManifest = {
      version: 2,
      files: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
      retired,
      rewritten: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
    }
    const current: ArchiveManifest = {
      version: 2,
      files: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
      retired: { ...retired, 'feature/other.zh.md': 'sha256:' + '4'.repeat(64) },
      rewritten: { 'feature/example.md': 'sha256:' + '1'.repeat(64) },
    }
    expect(validateArchiveManifestExtension(baseline, current)).toContain('retired archive seals changed after the one-time migration')
  })

  it.each([
    {
      path: 'feature/2026-08-10-durable-workflow-runs-in-chat.md',
      before: 'sha256:f9f5290cd880908d17b1080ae5776f22e182f5253471f90cf8bead418b33b502',
      after: 'sha256:6018de4a89ca99d6cbfd618aff1c8136b23d8e4854a30f7b12a602f0417cbdc2',
    },
    {
      path: 'feature/2026-08-10-durable-workflow-runs-in-chat.zh.md',
      before: 'sha256:f4ffd2700bc9c2a0cc4b9d90f84e1d0a576939e2e6f0b130c5b142fd8cd518b0',
      after: 'sha256:0080859221773122022d5880efa3d52f29c0872b52d63e170250d94f214ff37a',
    },
    {
      path: 'feature/2026-08-10-durable-workflow-runs-in-chat.i18n.yaml',
      before: 'sha256:0db3c21a3c8785e56d5d7b90df990b158069cd1cea664e62fc4786c6d7588450',
      after: 'sha256:03eadb60c8ba4fde262cd61e3f911d8cd68ea4a58f57adeb8dd7bb9a97d08ca2',
    },
  ])('accepts only the authorized seal transition for $path', ({ path, before, after }) => {
    const manifest = (hash: string): ArchiveManifest => ({ version: 1, files: { [path]: hash } })
    expect(validateArchiveManifestExtension(manifest(before), manifest(after))).toEqual([])
    expect(validateArchiveManifestExtension(manifest(after), manifest(before))).toEqual([
      `${path}: sealed manifest hash changed`,
    ])
    expect(validateArchiveManifestExtension(manifest(before), manifest('sha256:' + '0'.repeat(64)))).toHaveLength(1)
    expect(validateArchiveManifestExtension(manifest('sha256:' + '0'.repeat(64)), manifest(after))).toHaveLength(1)
    expect(validateArchiveManifestExtension(manifest(before), { version: 1, files: {} })).toHaveLength(1)
    expect(validateArchiveManifestExtension(
      { version: 1, files: { 'process/other.md': before } },
      { version: 1, files: { 'process/other.md': after } },
    )).toHaveLength(1)
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })

  it('round-trips a version-2 migration manifest', () => {
    const content = renderArchiveManifest(
      { 'process/z.md': `sha256:${'a'.repeat(64)}` },
      {
        version: 2,
        retired: { 'process/z.zh.md': `sha256:${'b'.repeat(64)}` },
        rewritten: { 'process/z.md': `sha256:${'c'.repeat(64)}` },
      },
    )
    expect(parseArchiveManifest(content)).toEqual({
      version: 2,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
      retired: { 'process/z.zh.md': `sha256:${'b'.repeat(64)}` },
      rewritten: { 'process/z.md': `sha256:${'c'.repeat(64)}` },
    })
  })
})
