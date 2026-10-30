/** Render bounded release facts from validated offline records while preserving authored prose. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPersistencePair } from './persistence-artifacts.ts'
import { pairedDocsEnabled } from './translation-pairing.ts'
import type { PersistenceArtifact } from './persistence-artifacts.ts'
import type { PersistenceReleaseEntry, PersistenceReleases } from './persistence-releases.ts'
import { canonicalizeSchema, schemaDigest } from './persistence-schema-model.ts'

type Language = 'en' | 'zh'

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function replaceFacts(source: string, name: string, content: string, path: string): string {
  const start = `<!-- persistence-release-${name}:start -->`
  const end = `<!-- persistence-release-${name}:end -->`
  const opening = source.indexOf(start)
  const closing = source.indexOf(end)
  if (opening < 0 || closing < opening || source.indexOf(start, opening + start.length) >= 0
    || source.indexOf(end, closing + end.length) >= 0) throw new Error(`${path}: expected one ${name} factual block`)
  return source.slice(0, opening + start.length) + content + source.slice(closing)
}

function structuralChanges(entry: PersistenceReleaseEntry, language: Language): string {
  if (entry.record.previous === null) {
    return language === 'en'
      ? 'This entry establishes the historical comparison starting point. Its declaration lists every extracted root; it makes no compatibility judgment about earlier versions.'
      : '\u672c\u6761\u8bb0\u5f55\u5efa\u7acb\u5386\u53f2\u6bd4\u8f83\u8d77\u70b9。\u673a\u5668\u58f0\u660e\u5217\u51fa\u6240\u6709\u63d0\u53d6\u7684\u6839\u7c7b\u578b，\u4e0d\u5bf9\u66f4\u65e9\u7248\u672c\u4f5c\u517c\u5bb9\u6027\u5224\u65ad。'
  }
  if (entry.differences.length === 0) {
    return language === 'en'
      ? 'Normalized root types and their transitive digests are unchanged from the preceding tag.'
      : '\u89c4\u8303\u5316\u540e\u7684\u6839\u7c7b\u578b\u53ca\u5176\u4f20\u9012\u5f15\u7528\u6458\u8981\u4e0e\u524d\u4e00 tag \u76f8\u540c。'
  }
  const summary = language === 'en'
    ? `Detected ${count(entry.record.changes.length, 'changed root')} and ${count(entry.differences.length, 'structural difference')}. The minimum below is calculated using current rules for comparison only; it does not assert historical compliance, migration correctness, or runtime compatibility.`
    : `\u68c0\u6d4b\u5230 ${entry.record.changes.length} \u4e2a\u6839\u7c7b\u578b\u53d8\u5316、${entry.differences.length} \u9879\u7ed3\u6784\u5dee\u5f02。\u4e0b\u8868\u7684\u6700\u4f4e\u8981\u6c42\u6309\u5f53\u524d\u89c4\u5219\u8ba1\u7b97，\u53ea\u7528\u4e8e\u6bd4\u8f83；\u4e0d\u8868\u793a\u65e7\u7248\u672c\u66fe\u9075\u5b88\u8fd9\u4e9b\u89c4\u5219，\u4e5f\u4e0d\u8bc1\u660e\u8fc1\u79fb\u6216\u8fd0\u884c\u65f6\u517c\u5bb9\u6027。`
  const heading = language === 'en' ? '| Path | Change | Current minimum |' : '| \u8def\u5f84 | \u53d8\u5316 | \u5f53\u524d\u6700\u4f4e\u8981\u6c42 |'
  const rows = entry.differences.map((change) => {
    const path = change.path.replaceAll('`', '\\`').replaceAll('|', '\\|')
    return `| \`${path}\` | \`${change.kind}\` | \`${change.requiresVersionBump ? 'version-bump' : 'same-version'}\` |`
  })
  return [summary, '', heading, '|---|---|---|', ...rows].join('\n')
}

/** Compute paired factual updates without writing or changing machine declarations.
 * @param root - checkout containing existing documents with bounded factual markers.
 * @param archive - fully validated release records and reconstructed roots.
 * @returns complete bilingual documents and sidecars, validated together before any caller writes.
 */
export function persistenceReleaseFactArtifacts(root: string, archive: PersistenceReleases): PersistenceArtifact[] {
  const directory = 'docs/persistence-changes/releases'
  const rootTypes = new Map<string, readonly string[]>()
  const typeCounts = archive.entries.map((entry) => {
    const types = new Set<string>()
    for (const root of entry.roots.values()) {
      let digests = rootTypes.get(root.digest)
      if (digests === undefined) {
        digests = root.schema.nodes.map((_, index) => schemaDigest(canonicalizeSchema(root.schema.nodes, index)))
        rootTypes.set(root.digest, digests)
      }
      for (const digest of digests) types.add(digest)
    }
    return types.size
  })
  const read = (name: string): string => readFileSync(join(root, directory, name), 'utf8')
  const index = (language: Language): string => {
    const heading = language === 'en'
      ? '| Tag | Source date (UTC) | Session version | Roots / types | Changed roots |'
      : '| Tag | \u6e90\u7801\u65e5\u671f（UTC） | Session \u7248\u672c | \u6839 / \u7c7b\u578b | \u53d8\u5316\u6839 |'
    const rows = archive.entries.map((entry, index) => {
      const tag = entry.release.tag
      const date = new Date(entry.release.sourceDate).toISOString().slice(0, 10)
      return `| [${tag}](${tag}${language === 'zh' ? '.zh' : ''}.md) | ${date} | ${entry.release.sessionFormatVersion} | ${entry.roots.size} / ${typeCounts[index]} | ${entry.record.changes.length} |`
    })
    return '\n\n' + [heading, '|---|---|---|---|---|', ...rows].join('\n') + '\n\n'
  }
  // English-only: one artifact per page, with no translated sibling or record.
  if (!pairedDocsEnabled(root)) {
    const artifacts: PersistenceArtifact[] = [
      { path: `${directory}/README.md`, content: replaceFacts(read('README.md'), 'index', index('en'), 'README.md') },
    ]
    for (const [order, entry] of archive.entries.entries()) {
      const path = `${entry.release.tag}.md`
      const inventory = `${count(entry.roots.size, 'root')} / ${count(typeCounts[order] as number, 'type')}`
      artifacts.push({
        path: `${directory}/${path}`,
        content: replaceFacts(replaceFacts(read(path), 'inventory', inventory, path),
          'changes', '\n\n' + structuralChanges(entry, 'en') + '\n\n', path),
      })
    }
    return artifacts
  }
  const artifacts = renderPersistencePair(root, `${directory}/README.md`,
    replaceFacts(read('README.md'), 'index', index('en'), 'README.md'),
    replaceFacts(read('README.zh.md'), 'index', index('zh'), 'README.zh.md'))
  for (const [index, entry] of archive.entries.entries()) {
    const document = (language: Language): string => {
      const path = `${entry.release.tag}${language === 'zh' ? '.zh' : ''}.md`
      const inventory = language === 'en'
        ? `${count(entry.roots.size, 'root')} / ${count(typeCounts[index] as number, 'type')}`
        : `${entry.roots.size} \u4e2a\u6839\u7c7b\u578b / ${typeCounts[index]} \u79cd\u7c7b\u578b`
      return replaceFacts(replaceFacts(read(path), 'inventory', inventory, path),
        'changes', '\n\n' + structuralChanges(entry, language) + '\n\n', path)
    }
    artifacts.push(...renderPersistencePair(root, `${directory}/${entry.release.tag}.md`, document('en'), document('zh')))
  }
  return artifacts
}
