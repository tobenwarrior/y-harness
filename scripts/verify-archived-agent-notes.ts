/** Verify and append-seal the frozen Agent Note archive. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_NOTE_CLASSES, agentNoteRoot } from './agent-note-tree.ts'
import { englishOnlyReason } from './translation-pairing.ts'
import {
  extendArchiveManifest,
  isRetiredTranslationArtifact,
  parseArchiveManifest,
  renderArchiveManifest,
  rewriteArchiveEnglishOnlySource,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'

const args = process.argv.slice(2)
const writeMode = args.length === 1 && args[0] === '--write'
if (args.length > 0 && !writeMode) {
  console.error('verify-archived-agent-notes: usage: tsx scripts/verify-archived-agent-notes.ts [--write]')
  process.exit(1)
}

const archiveRoot = resolve(agentNoteRoot, 'archived')
const manifestPath = resolve(archiveRoot, 'manifest.json')
const repoRoot = resolve(agentNoteRoot, '../..')
const archiveRootRepoPath = '.agents/notes/archived'
const manifestRepoPath = '.agents/notes/archived/manifest.json'
const errors: string[] = []
const allowedRootFiles = new Set(['AGENTS.md', 'manifest.json'])
const kinds = new Set<string>()

if (!existsSync(resolve(archiveRoot, 'AGENTS.md'))) errors.push('archived/AGENTS.md is required')
const artifacts = new Map<string, Buffer>()
for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`)
    continue
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: only regular files and kind directories are allowed`)
    continue
  }
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) {
    errors.push(`archived/${entry.name}/: unknown Agent Note kind`)
    continue
  }
  kinds.add(entry.name)
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    const rel = `${entry.name}/${child.name}`
    if (!child.isFile()) {
      errors.push(`${rel}: archived kind directories contain regular files only`)
      continue
    }
    artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)))
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: required kind directory is missing`)
}
errors.push(...validateArchiveArtifacts(artifacts, englishOnlyReason(resolve(import.meta.dirname, '..'))))

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`)
  return result.stdout
}

function readBaselineArchiveSources(ref: string, paths: readonly string[]): Map<string, Buffer> {
  const input = Buffer.from(paths.map(path => `${ref}:${archiveRootRepoPath}/${path}\n`).join(''))
  const result = spawnSync('git', ['cat-file', '--batch'], { cwd: repoRoot, input, maxBuffer: 64 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.toString().trim() || `git exited with status ${result.status}`)
  if (!Buffer.isBuffer(result.stdout)) throw new Error('git cat-file --batch returned no data')
  const output = result.stdout
  const sources = new Map<string, Buffer>()
  let offset = 0
  for (const path of paths) {
    const headerEnd = output.indexOf(10, offset)
    if (headerEnd < 0) throw new Error(`git cat-file --batch returned no header for ${path}`)
    const [objectId, type, sizeText] = output.subarray(offset, headerEnd).toString('utf8').split(' ')
    if (type === 'missing') throw new Error(`baseline archive source is missing: ${path}`)
    const size = Number(sizeText)
    if (objectId === undefined || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid git cat-file header for ${path}`)
    }
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`invalid git cat-file payload for ${path}`)
    }
    sources.set(path, output.subarray(contentStart, contentEnd))
    offset = contentEnd + 1
  }
  return sources
}

function readBaselineManifest(ref: string): ArchiveManifest {
  runGit(['cat-file', '-e', `${ref}^{commit}`])
  const manifestEntry = runGit(['ls-tree', '--name-only', ref, '--', manifestRepoPath]).trim()
  if (manifestEntry === '') return { version: 1, files: {} }
  return parseArchiveManifest(runGit(['show', `${ref}:${manifestRepoPath}`]))
}

/** Prove that the version-2 manifest is the exact one-time English-only migration. */
function validateEnglishOnlyMigration(
  baselineRef: string,
  baseline: ArchiveManifest,
  current: ArchiveManifest,
  currentArtifacts: ReadonlyMap<string, Buffer>,
): string[] {
  if (baseline.version !== 1 || current.version !== 2) return []
  const errors: string[] = []
  const baselinePaths = new Set(Object.keys(baseline.files))
  for (const path of Object.keys(current.files)) {
    if (!baselinePaths.has(path)) errors.push(`${path}: new archive artifact cannot be added during the one-time migration`)
  }

  const sourcePaths = [...baselinePaths].filter(path => path.endsWith('.md') && !path.endsWith('.zh.md')).sort()
  let baselineSources: Map<string, Buffer>
  try {
    baselineSources = readBaselineArchiveSources(baselineRef, sourcePaths)
  } catch (error: unknown) {
    errors.push(`cannot read baseline archive sources: ${error instanceof Error ? error.message : String(error)}`)
    return errors
  }
  for (const path of sourcePaths) {
    let expected: Buffer
    try {
      const source = baselineSources.get(path)
      if (source === undefined) throw new Error(`baseline archive source is missing: ${path}`)
      expected = rewriteArchiveEnglishOnlySource(path, source)
    } catch (error: unknown) {
      errors.push(`${path}: cannot derive the deterministic migration result: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const actual = currentArtifacts.get(path)
    if (actual === undefined) errors.push(`${path}: migrated English archive source is missing`)
    else if (!actual.equals(expected)) errors.push(`${path}: migration changed archived prose beyond the approved switcher/reference rewrite`)
  }
  for (const path of currentArtifacts.keys()) {
    if (isRetiredTranslationArtifact(path)) errors.push(`${path}: translation artifact is forbidden after the English-only migration`)
  }
  return errors
}

let manifest: ArchiveManifest = { version: 1, files: {} }
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
} else if (!writeMode) {
  errors.push('archived/manifest.json is required; seal new artifacts with `pnpm run verify-archived-agent-notes --write`')
}

if (manifest.version === 2) {
  for (const path of artifacts.keys()) {
    if (isRetiredTranslationArtifact(path)) errors.push(`${path}: translation artifact is forbidden after the English-only migration`)
  }
}

// CI supplies its trusted pre-change commit; local writes compare with committed HEAD.
const baselineRef = process.env.DSH_ARCHIVE_BASE_REF ?? 'HEAD'
try {
  const baseline = readBaselineManifest(baselineRef)
  errors.push(...validateArchiveManifestExtension(baseline, manifest))
  errors.push(...validateEnglishOnlyMigration(baselineRef, baseline, manifest, artifacts))
} catch (error: unknown) {
  errors.push(`archived/manifest.json: cannot read baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`)
}

const extended = extendArchiveManifest(manifest, artifacts)
errors.push(...extended.errors)
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`)
}

if (errors.length > 0) {
  console.error('verify-archived-agent-notes: archive rules violated:')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files, {
    version: manifest.version,
    ...(manifest.retired === undefined ? {} : { retired: manifest.retired }),
    ...(manifest.rewritten === undefined ? {} : { rewritten: manifest.rewritten }),
  })
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== rendered) {
    writeFileSync(manifestPath, rendered)
  }
  console.log(`verify-archived-agent-notes: sealed ${extended.added.length} new artifact(s); existing seals unchanged.`)
} else {
  console.log(`verify-archived-agent-notes: ${artifacts.size} frozen artifact(s) checked across ${kinds.size} kind(s).`)
}
