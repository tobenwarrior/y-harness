/** Validate and publish the signed Desktop artifacts as one GitHub Release. */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load, dump } from 'js-yaml'
import { prerelease, valid } from 'semver'
import { DESKTOP_GITHUB_OWNER, DESKTOP_GITHUB_REPOSITORY, desktopGitHubMetadataFilename } from './desktop-github-release.mjs'
import { desktopArtifactBase } from './desktop-artifact-name.mjs'

const execute = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '../../..')
const APP_ROOT = resolve(import.meta.dirname, '..')

/** Supported signed Desktop release targets. */
export const DESKTOP_RELEASE_TARGETS = ['mac-arm64', 'mac-x64', 'win-x64'] as const
export type DesktopReleaseTarget = typeof DESKTOP_RELEASE_TARGETS[number]

/** One file that is ready to be attached to a GitHub Release. */
export interface GitHubReleaseAsset {
  readonly path: string
  readonly filename: string
  readonly target?: DesktopReleaseTarget
}

/** One target directory containing a completed signed package. */
export interface GitHubReleaseTargetInput {
  readonly target: DesktopReleaseTarget
  readonly directory: string
}

/** Validated release payload before any GitHub mutation. */
export interface GitHubReleasePlan {
  readonly version: string
  readonly tag: string
  readonly repository: `${typeof DESKTOP_GITHUB_OWNER}/${typeof DESKTOP_GITHUB_REPOSITORY}`
  readonly assets: readonly GitHubReleaseAsset[]
  readonly metadata: readonly string[]
  /** Disposable staging directory owned by the plan creator. */
  readonly stagingDirectory?: string
}

/** Run an external command, injectable for validation tests. */
export type ReleaseCommand = (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>

const defaultRun: ReleaseCommand = async (command, args) => {
  const result = await execute(command, [...args], { cwd: ROOT })
  return { stdout: result.stdout, stderr: result.stderr }
}

function assertVersion(version: string): string {
  const normalized = valid(version)
  if (normalized === null) throw new Error(`desktop GitHub release: invalid version ${JSON.stringify(version)}`)
  return normalized
}

function assertTarget(value: string): DesktopReleaseTarget {
  if (!(DESKTOP_RELEASE_TARGETS as readonly string[]).includes(value)) {
    throw new Error(`desktop GitHub release: unsupported target ${JSON.stringify(value)}`)
  }
  return value as DesktopReleaseTarget
}

function targetOsArch(target: DesktopReleaseTarget): { os: 'mac' | 'win'; arch: 'arm64' | 'x64' } {
  return target === 'win-x64' ? { os: 'win', arch: 'x64' } : { os: 'mac', arch: target === 'mac-arm64' ? 'arm64' : 'x64' }
}

function expectedFiles(version: string, target: DesktopReleaseTarget): readonly string[] {
  const { os, arch } = targetOsArch(target)
  const base = desktopArtifactBase(version, os, arch)
  return target === 'win-x64'
    ? [`${base}.exe`, `${base}.exe.blockmap`, desktopGitHubMetadataFilename('win32', version)]
    : [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, desktopGitHubMetadataFilename('darwin', version)]
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`desktop GitHub release: ${label} must be an object`)
  return value as Record<string, unknown>
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`desktop GitHub release: ${label} must be a non-empty string`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`desktop GitHub release: ${label} must be a positive integer`)
  return value
}

async function sha512(path: string): Promise<string> {
  const hash = createHash('sha512')
  const bytes = await readFile(path)
  hash.update(bytes)
  return hash.digest('base64')
}

async function regularFile(path: string, label: string): Promise<void> {
  const details = await lstat(path).catch(() => undefined)
  if (details === undefined || !details.isFile() || details.isSymbolicLink() || details.size === 0) {
    throw new Error(`desktop GitHub release: ${label} must be a non-empty regular file`)
  }
}

async function readMetadata(path: string, version: string, target: DesktopReleaseTarget): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = load(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop GitHub release: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const metadata = object(parsed, basename(path))
  if (stringField(metadata.version, `${basename(path)}.version`) !== version) {
    throw new Error(`desktop GitHub release: ${basename(path)} version does not match ${version}`)
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error(`desktop GitHub release: ${basename(path)} must contain exactly one update file for ${target}`)
  }
  const file = object(metadata.files[0], `${basename(path)}.files[0]`)
  const expected = expectedFiles(version, target).find(name => name.endsWith(target === 'win-x64' ? '.exe' : '.zip'))
  const filename = basename(stringField(file.url, `${basename(path)}.files[0].url`))
  if (filename !== expected) throw new Error(`desktop GitHub release: ${basename(path)} points to ${filename}, expected ${expected}`)
  const size = positiveInteger(file.size, `${basename(path)}.files[0].size`)
  const checksum = stringField(file.sha512, `${basename(path)}.files[0].sha512`)
  const artifactPath = join(dirname(path), filename)
  await regularFile(artifactPath, filename)
  const details = await stat(artifactPath)
  if (details.size !== size || await sha512(artifactPath) !== checksum) {
    throw new Error(`desktop GitHub release: ${filename} does not match ${basename(path)} size or SHA-512`)
  }
  metadata.files = [{ ...file, url: filename }]
  return metadata
}

async function resolveTargetDirectory(input: string, target: DesktopReleaseTarget, version: string): Promise<string> {
  const expected = new Set(expectedFiles(version, target))
  async function search(directory: string, depth: number): Promise<string | undefined> {
    const details = await stat(directory).catch(() => undefined)
    if (!details?.isDirectory()) return undefined
    const entries = await readdir(directory, { withFileTypes: true })
    const targetFiles = [...expected].filter(name => !name.endsWith('.yml'))
    if (entries.some(entry => entry.isFile() && targetFiles.includes(entry.name))) return directory
    if (depth >= 3) return undefined
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const found = await search(join(directory, entry.name), depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const found = await search(input, 0)
  if (found !== undefined) return found
  throw new Error(`desktop GitHub release: cannot find artifact directory for ${target} below ${input}`)
}

/** Build and validate the release payload without contacting GitHub. */
export async function createGitHubReleasePlan(options: {
  readonly version: string
  readonly input: string
  readonly tag?: string
  readonly targets?: readonly GitHubReleaseTargetInput[]
}): Promise<GitHubReleasePlan> {
  const version = assertVersion(options.version)
  const tag = options.tag ?? `v${version}`
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(tag)) throw new Error(`desktop GitHub release: invalid release tag ${JSON.stringify(tag)}`)
  const targetInputs = options.targets ?? await Promise.all(DESKTOP_RELEASE_TARGETS.map(async target => ({ target, directory: await resolveTargetDirectory(options.input, target, version) })))
  if (targetInputs.length !== DESKTOP_RELEASE_TARGETS.length || new Set(targetInputs.map(item => item.target)).size !== DESKTOP_RELEASE_TARGETS.length) {
    throw new Error('desktop GitHub release: exactly one artifact directory is required for each supported target')
  }
  const metadataByName = new Map<string, Record<string, unknown>>()
  const assets: GitHubReleaseAsset[] = []
  const seen = new Set<string>()
  for (const input of targetInputs) {
    const target = assertTarget(input.target)
    const directory = resolve(input.directory)
    const names = [...expectedFiles(version, target)]
    for (const name of names) {
      const path = join(directory, name)
      await regularFile(path, name)
      if (name.endsWith('.yml')) {
        const metadata = await readMetadata(path, version, target)
        metadataByName.set(name, metadata)
      }
      else {
        if (seen.has(name)) throw new Error(`desktop GitHub release: duplicate asset ${name}`)
        seen.add(name)
        assets.push({ path, filename: name, target })
      }
    }
  }
  const macMetadata = metadataByName.get('latest-mac.yml')
  const winMetadata = metadataByName.get('latest.yml')
  if (macMetadata === undefined || winMetadata === undefined) throw new Error('desktop GitHub release: both latest.yml and latest-mac.yml are required')
  const macFiles = targetInputs.filter(input => input.target.startsWith('mac-')).map(input => {
    const target = input.target
    const directory = resolve(input.directory)
    return readMetadata(join(directory, 'latest-mac.yml'), version, target).then(metadata => {
      if (!Array.isArray(metadata.files) || metadata.files.length !== 1) throw new Error('desktop GitHub release: macOS metadata lost its update file')
      return metadata.files[0]
    })
  })
  const mergedMac = await Promise.all(macFiles)
  const mergedMacMetadata = { ...macMetadata, files: mergedMac }
  const staging = await mkdtemp(join(tmpdir(), 'yharness-release-'))
  const stagedAssets: GitHubReleaseAsset[] = []
  for (const asset of assets) {
    const stagedPath = join(staging, asset.filename)
    await copyFile(asset.path, stagedPath)
    stagedAssets.push({ ...asset, path: stagedPath })
  }
  const macMetadataPath = join(staging, 'latest-mac.yml')
  const winMetadataPath = join(staging, 'latest.yml')
  await writeFile(macMetadataPath, dump(mergedMacMetadata, { lineWidth: -1, noRefs: true }))
  await writeFile(winMetadataPath, dump(winMetadata, { lineWidth: -1, noRefs: true }))
  stagedAssets.push({ path: macMetadataPath, filename: 'latest-mac.yml' }, { path: winMetadataPath, filename: 'latest.yml' })
  return { version, tag, repository: `${DESKTOP_GITHUB_OWNER}/${DESKTOP_GITHUB_REPOSITORY}`, assets: stagedAssets,
    metadata: ['latest.yml', 'latest-mac.yml'], stagingDirectory: staging }
}

/** Publish a validated plan, refusing to operate on another repository. */
export async function publishGitHubRelease(plan: GitHubReleasePlan, run: ReleaseCommand = defaultRun): Promise<void> {
  const repository = `${DESKTOP_GITHUB_OWNER}/${DESKTOP_GITHUB_REPOSITORY}`
  if (plan.repository !== repository) throw new Error(`desktop GitHub release: plan repository must be ${repository}`)
  const repositoryEnvironment = process.env.GITHUB_REPOSITORY?.trim()
  if (repositoryEnvironment !== undefined && repositoryEnvironment !== repository) {
    throw new Error(`desktop GitHub release: GITHUB_REPOSITORY must be ${repository}`)
  }
  const filenames = plan.assets.map(asset => asset.filename)
  try {
    await run('gh', ['release', 'view', plan.tag, '--repo', repository])
    if (plan.stagingDirectory !== undefined) await rm(plan.stagingDirectory, { recursive: true, force: true })
    throw new Error(`desktop GitHub release: ${plan.tag} already exists; refusing to mutate an existing release`)
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!/(?:not found|404|could not find)/iu.test(detail)) {
      if (plan.stagingDirectory !== undefined) await rm(plan.stagingDirectory, { recursive: true, force: true })
      throw error
    }
  }
  try {
    await run('gh', ['release', 'create', plan.tag, '--repo', repository, '--verify-tag', '--title', `Y Harness ${plan.version}`, '--notes', `Y Harness ${plan.version}`,
      ...(prerelease(plan.version) === null ? [] : ['--prerelease']), ...plan.assets.map(asset => asset.path)])
    process.stdout.write(`desktop GitHub release: ${plan.tag} published ${filenames.join(', ')}\n`)
  }
  finally {
    if (plan.stagingDirectory !== undefined) await rm(plan.stagingDirectory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))?.version
  if (typeof version !== 'string') throw new Error('desktop GitHub release: root package has no version')
  const inputIndex = process.argv.indexOf('--input')
  const input = inputIndex === -1 ? join(APP_ROOT, '.desktop-release-input') : process.argv[inputIndex + 1]
  if (input === undefined || input.startsWith('--')) throw new Error('desktop GitHub release: --input requires a directory')
  const tagIndex = process.argv.indexOf('--tag')
  const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1]
  const plan = await createGitHubReleasePlan({ version, input, ...(tag === undefined ? {} : { tag }) })
  await publishGitHubRelease(plan)
}
