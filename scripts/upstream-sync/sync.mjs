#!/usr/bin/env node
/**
 * Scoped upstream sync for the Y Harness fork.
 *
 * The fork's `master` is a squashed import with no ancestry shared with
 * the source repository, so a normal merge cannot express "take the official
 * changes, but only the ones this fork wants". This tool expresses
 * that policy instead: `config.json` names the upstream paths this fork tracks
 * and the upstream commit whose content it has already ingested. The tool
 * diffs `baseline..target` over those paths, applies the result with git's
 * three-way patch machinery against the fetched upstream blobs, and reports
 * exactly what landed, what conflicted, and which new packages need bundle
 * wiring.
 *
 * The tool never merges, commits, or pushes. It prepares a branch (or only a
 * patch, with the default plan mode) so a human reviews the result; merging
 * that branch is what advances the recorded baseline.
 *
 * @module scripts/upstream-sync/sync
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/upstream-sync/sync.mjs [options]

Plans (default) or applies the scoped upstream delta declared by
scripts/upstream-sync/config.json.

Options:
  --to <ref>        upstream ref to sync to (default: config target)
  --baseline <ref>  override the recorded baseline
  --apply           create the sync branch and apply the delta
  --check           run the configured checks against the current tree
  --branch <name>   branch to create with --apply (default: derived)
  --no-align-version  skip the release version alignment after applying
  --no-fetch        do not fetch the upstream remote first
  --allow-dirty     apply on a tree with uncommitted changes (not recommended)
  --pnpm <command>  pnpm executable for checks and the version bump
  --json <path>     write the machine-readable report to this path
  --help            print this text

Exit codes: 0 clean or nothing to do, 2 applied with conflicts,
3 applied but a check failed, 1 error.`

const ALWAYS_EXCLUDED = ['**/lib/**', '**/dist/**', '**/node_modules/**']

/**
 * Run one command in the repository, capturing both streams.
 * @param command Executable name.
 * @param args Argument vector, passed without a shell.
 * @param options.cwd Working directory; defaults to the repository root.
 * @param options.allowFailure Return the result instead of throwing on a non-zero exit.
 * @returns Exit status, stdout, and stderr.
 */
function run(command, args, { cwd = root(), allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Repository root, resolved once from git. */
let rootCache
function root() {
  if (rootCache === undefined) {
    rootCache = run('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).stdout.trim()
  }
  return rootCache
}

/**
 * Translate one glob into a regular expression over repository-relative POSIX paths.
 * Supports `**` (any depth), `*` (within one segment), and `?`.
 * @param pattern Glob pattern using `/` separators.
 * @returns A matcher for normalized repository-relative paths.
 */
function globMatcher(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      const doubled = pattern[i + 1] === '*'
      if (doubled) {
        const slash = pattern[i + 2] === '/'
        out += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Normalize a repository-relative path to `/` separators.
 * @param path Platform path.
 * @returns The same path with `/` separators.
 */
function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/** Manifest sections a prerequisite merge may update; every other field is only reported. */
export const MANIFEST_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies']

/**
 * Select the files that match a prerequisite pattern and no exclusion.
 * @param changedPaths Repository-relative paths changed between the two revisions.
 * @param patterns Glob patterns of the declared prerequisite files.
 * @param excludeMatchers Matchers that must never be selected.
 * @returns The selected paths, in the order given.
 */
export function selectPrerequisites(changedPaths, patterns, excludeMatchers = []) {
  const matchers = patterns.map(globMatcher)
  return changedPaths.filter(path =>
    matchers.some(match => match.test(path)) && !excludeMatchers.some(match => match.test(path)))
}

/**
 * Whether accepting an upstream range would move a dependency backwards.
 * @param theirs Upstream's declared range.
 * @param ours This fork's declared range.
 * @returns True when both name a concrete version and upstream's is lower.
 */
export function movesBackwards(theirs, ours) {
  const base = spec => {
    if (typeof spec !== 'string') return undefined
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(spec)
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const next = base(theirs)
  const current = base(ours)
  if (next === undefined || current === undefined) return false
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] < current[index]
  }
  return false
}

/**
 * Merge upstream dependency entries into this fork's manifest.
 *
 * Upstream moves dependency entries between manifests that this fork does not own — the
 * workspace root, shared utilities — and a synced package then fails to resolve what it
 * imports. Only the dependency sections merge: a version field belongs to the release
 * alignment step, and an entry this fork added stays even when upstream drops it. A range
 * that would move a dependency backwards is reported instead of applied, because a fork
 * may pin ahead of upstream deliberately.
 * @param ours This fork's manifest object.
 * @param theirs Upstream's manifest object at the target revision.
 * @param fields Dependency sections to merge.
 * @returns The merged manifest, the entries it changed, the entries it kept as they were,
 *   entries kept against upstream, and the changed top-level fields it leaves alone.
 */
export function mergeManifestFields(ours, theirs, fields = MANIFEST_DEPENDENCY_FIELDS) {
  const merged = { ...ours }
  const changes = []
  const skipped = []
  const kept = []
  const untouchedFields = []
  for (const field of fields) {
    const upstreamBlock = theirs?.[field]
    if (upstreamBlock === undefined || typeof upstreamBlock !== 'object' || upstreamBlock === null) continue
    const currentBlock = { ...(merged[field] ?? {}) }
    for (const [name, spec] of Object.entries(upstreamBlock)) {
      if (currentBlock[name] === spec) continue
      // A fork may pin ahead of upstream on purpose; taking a lower range back would undo it.
      if (movesBackwards(spec, currentBlock[name])) {
        skipped.push({ field, name, from: currentBlock[name], to: spec })
        continue
      }
      changes.push({ field, name, from: currentBlock[name], to: spec })
      currentBlock[name] = spec
    }
    for (const name of Object.keys(currentBlock)) {
      if (Object.hasOwn(upstreamBlock, name)) continue
      kept.push({ field, name, spec: currentBlock[name] })
    }
    merged[field] = currentBlock
  }
  for (const key of new Set([...Object.keys(theirs ?? {}), ...Object.keys(ours)])) {
    if (key === 'version' || fields.includes(key)) continue
    if (JSON.stringify(ours[key]) === JSON.stringify(theirs?.[key])) continue
    untouchedFields.push(key)
  }
  return { merged, changes, skipped, kept, untouchedFields }
}

/**
 * Remove the incremental build state that caches module resolution.
 *
 * `tsc -b` records each package's resolved module identities. A sync that changes a
 * dependency version leaves those records pointing at the old copy, and since no source
 * changed the compiler keeps reporting the stale type. The caches rebuild on the next
 * compile, so removing them is safe.
 * @param repoRoot Repository root.
 * @returns The removed cache paths, repository-relative with `/` separators.
 */
export function clearBuildStateCaches(repoRoot) {
  const cleared = []
  const stack = [join(repoRoot, 'packages'), join(repoRoot, 'apps')]
  while (stack.length > 0) {
    const directory = stack.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(path)
      } else if (entry.name.endsWith('.tsbuildinfo')) {
        rmSync(path, { force: true })
        cleared.push(relative(repoRoot, path))
      }
    }
  }
  for (const name of ['tsconfig.host.tsbuildinfo', 'tsconfig.client.tsbuildinfo']) {
    const path = join(repoRoot, name)
    if (!existsSync(path)) continue
    rmSync(path, { force: true })
    cleared.push(name)
  }
  return cleared.map(toPosix)
}

/**
 * Read a manifest object at one revision, or undefined when unreadable.
 * @param revision Revision to read from.
 * @param path Repository-relative manifest path.
 * @returns The parsed manifest, or undefined.
 */
function manifestAt(revision, path) {
  const result = run('git', ['show', `${revision}:${path}`], { allowFailure: true })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

/**
 * Read `name` from a repository-relative manifest at one upstream revision.
 * @param target Upstream revision.
 * @param path Repository-relative manifest path.
 * @returns The declared package name, or undefined when unreadable.
 */
function packageNameAt(target, path) {
  const result = run('git', ['show', `${target}:${path}`], { allowFailure: true })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout).name
  } catch {
    return undefined
  }
}

/**
 * Write the merged dependency entries into this fork's prerequisite manifests.
 * @param entries Report entries produced for the selected prerequisite manifests.
 * @param target Upstream revision holding the entries to merge.
 * @returns Repository-relative paths whose content changed.
 */
function applyPrerequisiteManifests(entries, target) {
  const written = []
  for (const entry of entries) {
    if (!entry.readable) continue
    const path = join(root(), entry.path)
    let ours
    try {
      ours = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    const theirs = manifestAt(target, entry.path)
    if (theirs === undefined) continue
    const { merged, changes } = mergeManifestFields(ours, theirs)
    if (changes.length === 0) continue
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`)
    written.push(entry.path)
  }
  return written
}

/**
 * The version this fork advertises after syncing to `target`: the `dsh-v*` tag
 * naming the target when one exists, otherwise the target's root manifest.
 * @param target Upstream revision that was resolved.
 * @param targetRef The ref the caller asked for.
 * @returns A semver string, or undefined when neither source declares one.
 */
function targetVersion(target, targetRef) {
  const tagged = run('git', ['tag', '--points-at', target, '--list', 'dsh-v*'], { allowFailure: true })
  const tag = tagged.stdout.split('\n').map(line => line.trim()).filter(Boolean)[0]
    ?? (/^dsh-v\d/.test(targetRef) ? targetRef : '')
  if (tag !== '') return tag.replace(/^dsh-v/, '')
  const manifest = run('git', ['show', `${target}:package.json`], { allowFailure: true })
  if (manifest.status !== 0) return undefined
  try {
    return JSON.parse(manifest.stdout).version
  } catch {
    return undefined
  }
}

/**
 * Run the configured checks sequentially.
 * @param checks Shell-free command strings, split on spaces.
 * @param pnpm pnpm executable used when a check starts with `pnpm`.
 * @returns One result per check, with the tail of its output.
 */
function runChecks(checks, pnpm) {
  return checks.map(command => {
    const parts = command.split(' ').filter(Boolean)
    const argv = parts[0] === 'pnpm' ? [pnpm, ...parts.slice(1)] : parts
    const result = run(argv[0], argv.slice(1), { allowFailure: true })
    return {
      command,
      status: result.status === 0 ? 'passed' : 'failed',
      output: `${result.stdout}${result.stderr}`.split('\n').slice(-40).join('\n'),
    }
  })
}

/**
 * Collect the upstream commits and files the allowlist selects.
 * @param inputs Resolved revisions, config, and normalized matchers.
 * @returns The selected paths, excluded paths, and commit subjects.
 */
function selectDelta({ baseline, target, include, excludeMatchers }) {
  const listed = run('git', ['diff', '--name-only', `${baseline}..${target}`, '--', ...include]).stdout
  const changed = listed.split('\n').map(line => line.trim()).filter(Boolean).map(toPosix)
  const files = []
  const excluded = []
  for (const path of changed) {
    if (excludeMatchers.some(match => match.test(path))) excluded.push(path)
    else files.push(path)
  }
  const log = run('git', ['log', '--no-merges', '--format=%h %s', `${baseline}..${target}`, '--', ...include]).stdout
  const commits = log.split('\n').map(line => line.trim()).filter(Boolean)
  return { files, excluded, commits }
}

/**
 * Report the delta, optionally prepare a branch, and write the patch.
 * @returns The process exit code.
 */
function main() {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      baseline: { type: 'string' },
      branch: { type: 'string' },
      json: { type: 'string' },
      pnpm: { type: 'string' },
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'align-version': { type: 'boolean', default: true },
      'no-fetch': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowNegative: true,
  })
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }

  const configPath = join(root(), 'scripts/upstream-sync/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const pnpm = values.pnpm ?? 'pnpm'
  const include = config.include ?? []
  const excludeMatchers = [...(config.exclude ?? []), ...ALWAYS_EXCLUDED].map(globMatcher)
  const report = { generatedAt: new Date().toISOString(), remote: config.remote, target: {}, files: {}, commits: [], conflicts: [], newPackages: [], checks: [], applied: false }

  const baseline = values.baseline ?? config.baseline
  const targetRef = values.to ?? config.target
  if (values['no-fetch'] !== true) run('git', ['fetch', config.remote, '--tags'])
  const target = run('git', ['rev-parse', `${targetRef}^{commit}`]).stdout.trim()
  const baselineSha = run('git', ['rev-parse', `${baseline}^{commit}`]).stdout.trim()
  report.baseline = baselineSha
  report.target = { ref: targetRef, sha: target, version: targetVersion(target, targetRef) }

  if (values.check === true) {
    report.checks = runChecks(config.checks ?? [], pnpm)
    writeReport(report, values.json)
    for (const check of report.checks) console.log(`check ${check.status}: ${check.command}`)
    return report.checks.every(check => check.status === 'passed') ? 0 : 3
  }

  if (baselineSha === target) {
    report.upToDate = true
    writeReport(report, values.json)
    console.log(`upstream sync: up to date at ${target.slice(0, 10)}`)
    return 0
  }

  const { files, excluded, commits } = selectDelta({ baseline: baselineSha, target, include, excludeMatchers })
  report.files = { total: files.length, excluded: excluded.length, added: [], modified: [], deleted: [] }
  report.commits = commits
  report.excluded = excluded

  // Prerequisites: files a synced package depends on but does not contain. The patch never
  // carries them, so a missing dependency entry only surfaces as a failing typecheck later.
  const prerequisitePatterns = config.prerequisites?.manifests ?? []
  const prerequisiteCandidates = prerequisitePatterns.length === 0 ? [] : run('git',
    ['diff', '--name-only', `${baselineSha}..${target}`, '--', ...prerequisitePatterns]).stdout
  const prerequisitePaths = selectPrerequisites(
    prerequisiteCandidates.split('\n').map(line => line.trim()).filter(Boolean).map(toPosix)
      .filter(path => !files.includes(path)),
    prerequisitePatterns,
    excludeMatchers,
  )
  const prerequisiteEvaluations = prerequisitePaths.map(path => {
    const theirs = manifestAt(target, path)
    let ours
    try {
      ours = JSON.parse(readFileSync(join(root(), path), 'utf8'))
    } catch {
      ours = undefined
    }
    if (ours === undefined || theirs === undefined) return { path, readable: false, changes: [], skipped: [], kept: [], untouchedFields: [] }
    const { changes, skipped, kept, untouchedFields } = mergeManifestFields(ours, theirs)
    return { path, readable: true, changes, skipped, kept, untouchedFields }
  })
  // Every manifest touches a release bump, so only entries with work behind them are listed.
  const applicablePrerequisites = prerequisiteEvaluations.filter(entry => entry.changes.length > 0)
  report.prerequisites = {
    evaluated: prerequisiteEvaluations.length,
    applicable: applicablePrerequisites,
    skipped: prerequisiteEvaluations.filter(entry => entry.skipped.length > 0).map(entry => ({ path: entry.path, skipped: entry.skipped })),
    reported: prerequisiteEvaluations
      .filter(entry => entry.changes.length === 0 && entry.skipped.length === 0 && entry.untouchedFields.length > 0)
      .map(entry => ({ path: entry.path, fields: entry.untouchedFields })),
  }


  const nameStatus = run('git', ['diff', '--name-status', `${baselineSha}..${target}`, '--', ...files]).stdout
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t')
    const path = toPosix(rest[rest.length - 1])
    if (status === 'A') report.files.added.push(path)
    else if (status === 'D') report.files.deleted.push(path)
    else report.files.modified.push(path)
  }
  report.newPackages = report.files.added
    .filter(path => /(^|\/)package\.json$/.test(path))
    .map(path => ({ path, name: packageNameAt(target, path) }))
    .filter(entry => entry.name !== undefined)

  if (files.length === 0 && applicablePrerequisites.length === 0) {
    report.upToDate = true
    writeReport(report, values.json)
    console.log(`upstream sync: no in-scope changes between ${baselineSha.slice(0, 10)} and ${target.slice(0, 10)}`)
    return 0
  }

  const artifactDir = join(root(), '.artifacts/upstream-sync')
  mkdirSync(artifactDir, { recursive: true })
  const patchPath = join(artifactDir, `${baselineSha.slice(0, 10)}-${target.slice(0, 10)}.patch`)
  const patch = files.length === 0 ? '' : run('git', ['diff', '--binary', `${baselineSha}..${target}`, '--', ...files]).stdout
  writeFileSync(patchPath, patch)
  report.patch = relative(root(), patchPath)

  console.log(`upstream sync: ${baselineSha.slice(0, 10)} -> ${target.slice(0, 10)} (${targetRef})`)
  console.log(`  commits in scope: ${commits.length}`)
  console.log(`  files: ${report.files.added.length} added, ${report.files.modified.length} modified, ${report.files.deleted.length} deleted, ${excluded.length} excluded`)
  console.log(`  patch: ${report.patch}`)
  for (const entry of report.newPackages) console.log(`  new package: ${entry.name} (${entry.path})`)
  if (report.prerequisites.evaluated > 0) {
    console.log(`  prerequisites: ${report.prerequisites.evaluated} manifest(s) changed upstream, ${report.prerequisites.applicable.length} with dependency entries to apply`)
  }
  for (const entry of report.prerequisites.applicable) {
    console.log(`  prerequisite: ${entry.path} — ${entry.changes.length} dependency change(s)`)
    for (const change of entry.changes) console.log(`    ${change.field}.${change.name}: ${change.from ?? '(absent)'} -> ${change.to}`)
    for (const keep of entry.kept) console.log(`    kept ${keep.field}.${keep.name} (upstream no longer lists it)`)
  }
  for (const entry of report.prerequisites.skipped) {
    for (const skip of entry.skipped) {
      console.log(`  prerequisite kept ${skip.field}.${skip.name} at ${skip.from} (upstream lists ${skip.to}; a lower range is not applied)`)
    }
  }
  for (const entry of report.prerequisites.reported) {
    console.log(`  prerequisite fields changed upstream, not applied: ${entry.path} (${entry.fields.join(', ')})`)
  }

  if (values.apply !== true) {
    writeReport(report, values.json)
    console.log('plan only: pass --apply to prepare the sync branch')
    return 0
  }

  if (values['allow-dirty'] !== true) {
    const dirty = run('git', ['status', '--porcelain']).stdout.trim()
    if (dirty !== '') throw new Error(`working tree is not clean:\n${dirty}`)
  }

  const branch = values.branch ?? `upstream-sync/${target.slice(0, 10)}`
  run('git', ['switch', '-C', branch])
  let applied = { status: 0, stdout: '', stderr: '' }
  if (files.length > 0) {
    applied = run('git', ['apply', '--3way', '--index', '--whitespace=nowarn', patchPath], { allowFailure: true })
  }
  const conflicts = run('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout
    .split('\n').map(line => line.trim()).filter(Boolean).map(toPosix)
  report.applied = true
  report.branch = branch
  report.conflicts = conflicts
  if (applied.status !== 0 && conflicts.length === 0) {
    throw new Error(`git apply failed without conflicts:\n${applied.stdout}${applied.stderr}`)
  }

  const writtenManifests = applyPrerequisiteManifests(report.prerequisites.applicable, target)
  if (writtenManifests.length > 0) {
    const install = run(pnpm, ['install', '--lockfile-only', '--no-frozen-lockfile'], { allowFailure: true })
    report.prerequisiteInstall = {
      status: install.status === 0 ? 'updated' : 'failed',
      output: `${install.stdout}${install.stderr}`.slice(-2000),
    }
    console.log(`  prerequisite manifests: ${writtenManifests.join(', ')} — lockfile ${report.prerequisiteInstall.status}`)
    if (install.status !== 0) console.log(report.prerequisiteInstall.output)
  }
  const dependencyChanged = writtenManifests.length > 0
    || [...report.files.added, ...report.files.modified, ...report.files.deleted].includes('pnpm-lock.yaml')
    || [...report.files.added, ...report.files.modified].some(path => path.endsWith('package.json'))
  if (dependencyChanged) {
    report.buildStateCleared = clearBuildStateCaches(root())
    console.log(`  cleared ${report.buildStateCleared.length} incremental build-state cache(s)`)
  }

  config.baseline = target
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`  branch: ${branch}`)
  console.log(`  conflicts: ${conflicts.length === 0 ? 'none' : conflicts.join(', ')}`)

  const alreadyAligned = run('git', ['show', 'HEAD:package.json'], { allowFailure: true }).stdout
  const currentVersion = (() => {
    try {
      return JSON.parse(alreadyAligned).version
    } catch {
      return undefined
    }
  })()
  const version = report.target.version
  if (values['align-version'] !== false && version !== undefined && version !== currentVersion) {
    const bump = run(pnpm, ['run', 'release:dsh', '--', version], { allowFailure: true })
    report.versionAlignment = { version, status: bump.status === 0 ? 'aligned' : 'failed', output: `${bump.stdout}${bump.stderr}`.slice(-2000) }
    console.log(`  version alignment -> ${version}: ${report.versionAlignment.status}`)
    if (bump.status !== 0) console.log(report.versionAlignment.output)
  }

  writeReport(report, values.json)
  return conflicts.length === 0 ? 0 : 2
}

/**
 * Write the machine-readable report when a path was requested.
 * @param report Report object.
 * @param path Destination path, or undefined to skip.
 */
function writeReport(report, path) {
  if (path === undefined) return
  const destination = resolve(root(), path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`upstream sync: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
} else if (!existsSync(join(root(), 'scripts/upstream-sync/config.json'))) {
  throw new Error('scripts/upstream-sync/config.json is missing')
}
