/** Render historical format references from complete, validated in-tree schemas. */

import { readFileSync } from 'node:fs'
import { pairedDocsEnabled } from './translation-pairing.ts'
import { basename, join, posix } from 'node:path'
import { renderPersistencePair, type PersistenceArtifact } from './persistence-artifacts.ts'
import type { PersistenceFormatEntry, PersistenceFormats } from './persistence-formats.ts'
import { renderPersistenceSchemaDefinitions, renderPersistenceSchemaIndex } from './render-persistence-schema.ts'

type Language = 'en' | 'zh'

function replaceRegion(source: string, name: string, content: string, path: string): string {
  const start = `<!-- persistence-format-${name}:start -->`
  const end = `<!-- persistence-format-${name}:end -->`
  const opening = source.indexOf(start)
  const closing = source.indexOf(end)
  if (opening < 0 || closing < opening || source.indexOf(start, opening + start.length) >= 0
    || source.indexOf(end, closing + end.length) >= 0) throw new Error(`${path}: expected one ${name} factual block`)
  return source.slice(0, opening + start.length) + '\n\n' + content.trim() + '\n\n' + source.slice(closing)
}

function historicalSchema(entry: PersistenceFormatEntry, language: Language): string {
  const schema = basename(entry.schemaPath)
  const introduction = language === 'en'
    ? `The [complete machine inventory](${schema}) contains ${entry.inventory.roots.length} roots and ${entry.inventory.types.length} reachable types. Digests include all referenced fields; source names and paths describe the selected historical tree.`
    : `[\u5b8c\u6574\u673a\u5668\u76ee\u5f55](${schema})\u5305\u542b ${entry.inventory.roots.length} \u4e2a\u6839\u7c7b\u578b\u548c ${entry.inventory.types.length} \u79cd\u53ef\u8fbe\u7c7b\u578b。\u6458\u8981\u5305\u542b\u6240\u6709\u5f15\u7528\u5b57\u6bb5；\u6e90\u7801\u540d\u79f0\u548c\u8def\u5f84\u63cf\u8ff0\u6240\u9009\u7684\u5386\u53f2\u6e90\u7801\u6811。`
  return [
    '<a id="schema"></a>',
    language === 'en' ? '## Complete schemas' : '## \u5b8c\u6574 schema',
    '',
    introduction,
    '',
    renderPersistenceSchemaIndex(entry.inventory, language, [], 3),
    '<details>',
    language === 'en' ? '<summary>Complete resolved types</summary>' : '<summary>\u5b8c\u6574\u89e3\u6790\u7c7b\u578b</summary>',
    '',
    renderPersistenceSchemaDefinitions(entry.inventory, language, () => undefined, 3),
    '</details>',
  ].join('\n')
}

function formatIndex(formats: PersistenceFormats, language: Language): string {
  const path = (target: string): string => posix.relative('docs/persistence-changes/historical-formats',
    language === 'zh' && target.endsWith('.md') ? target.replace(/\.md$/u, '.zh.md') : target)
  return [
    language === 'en' ? '| Format | Source | Reference | Machine schema | Roots / types |' : '| \u683c\u5f0f | \u6765\u6e90 | \u53c2\u8003\u6587\u6863 | \u673a\u5668 schema | \u6839\u7c7b\u578b / \u7c7b\u578b |',
    '|---|---|---|---|---|',
    ...formats.entries.map((entry) => {
      const source = entry.source === undefined ? language === 'en' ? 'Current checkout' : '\u5f53\u524d\u5de5\u4f5c\u6811'
        : 'tag' in entry.source ? `\`${entry.source.tag}\`` : `PR #${entry.source.pullRequest}`
      const label = entry.version === formats.currentVersion ? language === 'en' ? 'Current catalog' : '\u5f53\u524d\u76ee\u5f55' : `V${entry.version}`
      return `| ${entry.version} | ${source} | [${label}](${path(entry.document)}) | [JSON](${path(entry.schemaPath)}) | ${entry.inventory.roots.length} / ${entry.inventory.types.length} |`
    }),
  ].join('\n')
}

/**
 * Refresh bounded schema regions and the format index, preserving authored evidence.
 * @param root - repository with both document languages and factual markers.
 * @param formats - complete validated versions through the current writer.
 * @returns paired references and consistency records without modifying files.
 */
export function persistenceFormatFactArtifacts(root: string, formats: PersistenceFormats): PersistenceArtifact[] {
  const artifacts: PersistenceArtifact[] = []
  // English-only: one artifact per reference, with no translated sibling or record.
  const paired = pairedDocsEnabled(root)
  for (const entry of formats.entries.filter(entry => entry.version < formats.currentVersion)) {
    const english = replaceRegion(readFileSync(join(root, entry.document), 'utf8'), 'schema', historicalSchema(entry, 'en'), entry.document)
    if (!paired) {
      artifacts.push({ path: entry.document, content: english })
      continue
    }
    const chinese = replaceRegion(readFileSync(join(root, entry.document.replace(/\.md$/u, '.zh.md')), 'utf8'),
      'schema', historicalSchema(entry, 'zh'), entry.document.replace(/\.md$/u, '.zh.md'))
    artifacts.push(...renderPersistencePair(root, entry.document, english, chinese))
  }
  const index = 'docs/persistence-changes/historical-formats/README.md'
  const renderIndex = (language: Language): string => {
    const path = language === 'en' ? index : index.replace(/\.md$/u, '.zh.md')
    return replaceRegion(readFileSync(join(root, path), 'utf8'), 'index', formatIndex(formats, language), path)
  }
  if (!paired) {
    artifacts.push({ path: index, content: renderIndex('en') })
    return artifacts
  }
  artifacts.push(...renderPersistencePair(root, index, renderIndex('en'), renderIndex('zh')))
  return artifacts
}
