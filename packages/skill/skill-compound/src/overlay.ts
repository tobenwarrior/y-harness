import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { lstatSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveUpstreamCommit, UPSTREAM_REPOSITORY } from './upstream-head.ts'

const repository = UPSTREAM_REPOSITORY
const names = ['compound', 'map', 'setup', 'setup-global', 'status-global'] as const
const shaPattern = /^[a-f0-9]{40}$/
const versionPattern = /^\d+\.\d+\.\d+$/
const maxFile = 2 * 1024 * 1024
const maxTotal = 20 * 1024 * 1024
const maxFiles = 1000
const gitRepository = `https://github.com/${repository}.git`
const skillPathPattern = /^skills\/(?:compound|map|setup|setup-global|status-global)\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/u

interface TreeEntry {
  readonly path: string
  readonly type: 'blob'
  readonly mode: '100644' | '100755'
  readonly sha: string
  readonly size: number
}

interface GitSnapshot {
  readonly commit: string
  readonly entries: readonly TreeEntry[]
}

export interface OverlayRevision { commit: string; version: string }
export interface ActiveOverlay extends OverlayRevision { assetRoot: string }

/** One update per overlay root at a time; callers share matching in-flight requests. */
interface UpdateLock {
  tail: Promise<void>
  pending: Map<string, Promise<OverlayRevision>>
}

const updateLocks = new Map<string, UpdateLock>()

/** A private, per-user location, never inside the managed installation. */
export function overlayRoot(): string {
  return join(homedir(), '.local', 'share', 'deepseek-harness', 'compound-skills')
}

/** Read only an explicitly published, syntactically valid revision. */
export function activeOverlay(root = overlayRoot()): ActiveOverlay | undefined {
  try {
    checkPrivateDirectory(root)
    checkPrivateDirectory(join(root, 'revisions'))
    const currentPath = join(root, 'current.json')
    checkPrivateFile(currentPath)
    const value: unknown = JSON.parse(readFileSync(currentPath, 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const { commit, version } = value as Record<string, unknown>
    if (typeof commit !== 'string' || !shaPattern.test(commit) || typeof version !== 'string' || !versionPattern.test(version)) return undefined
    const assetRoot = join(root, 'revisions', commit, 'skills')
    for (const path of [join(root, 'revisions', commit), assetRoot, ...names.map(name => join(assetRoot, name))]) checkPrivateDirectory(path)
    for (const name of names) {
      const path = join(assetRoot, name, 'SKILL.md')
      checkPrivateFile(path)
      validateSkill(readFileSync(path, 'utf8'), name)
    }
    return { commit, version, assetRoot }
  } catch { return undefined }
}

function checkPrivateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(`unsafe overlay directory: ${path}`)
}

function checkPrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(`unsafe overlay file: ${path}`)
}

function olderVersion(left: string, right: string): boolean {
  const a = left.split('.').map(BigInt)
  const b = right.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) {
    const leftPart = a[i] ?? 0n
    const rightPart = b[i] ?? 0n
    if (leftPart !== rightPart) return leftPart < rightPart
  }
  return false
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason as unknown
  return reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'The operation was aborted')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal)
}

function validateSkill(text: string, expected: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (!match?.[1]) throw new Error(`invalid ${expected} skill frontmatter`)
  const metadata: unknown = parseYaml(match[1])
  if (typeof metadata !== 'object' || metadata === null || (metadata as { name?: unknown }).name !== expected || typeof (metadata as { description?: unknown }).description !== 'string' || !(metadata as { description: string }).description) throw new Error(`invalid ${expected} skill metadata`)
}

async function request(url: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(30_000)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, { redirect: 'error', signal: requestSignal, headers: { accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`)
  return response
}

async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) throw new Error('empty upstream response')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > limit) throw new Error('upstream response too large')
      chunks.push(Buffer.from(item.value))
    }
    return Buffer.concat(chunks, size)
  } finally { await reader.cancel().catch(() => {}) }
}

async function json(url: string, signal?: AbortSignal): Promise<unknown> {
  return JSON.parse((await boundedBody(await request(url, signal), maxTotal)).toString('utf8')) as unknown
}

function validateTreeEntries(entries: readonly Record<string, unknown>[]): readonly TreeEntry[] {
  if (entries.length === 0 || entries.length > maxFiles) throw new Error('invalid upstream file count')
  let total = 0
  return entries.map((entry) => {
    const path = entry.path
    const mode = entry.mode
    const type = entry.type
    const sha = entry.sha
    const size = entry.size
    if (type !== 'blob' || mode !== '100644' && mode !== '100755' || typeof path !== 'string' || !skillPathPattern.test(path) || path.split('/').some(part => part === '.' || part === '..') || typeof sha !== 'string' || !shaPattern.test(sha) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maxFile) {
      throw new Error('unsafe upstream tree entry')
    }
    total += size
    if (total > maxTotal) throw new Error('upstream assets too large')
    return { path, type, mode, sha, size }
  })
}

function parseApiTree(value: unknown): readonly TreeEntry[] {
  if (typeof value !== 'object' || value === null || (value as { truncated?: unknown }).truncated !== false || !Array.isArray((value as { tree?: unknown }).tree)) throw new Error('invalid or truncated upstream tree')
  const entries = (value as { tree: unknown[] }).tree.filter((entry): entry is Record<string, unknown> => {
    if (typeof entry !== 'object' || entry === null) return false
    const path = (entry as { path?: unknown }).path
    const type = (entry as { type?: unknown }).type
    return typeof path === 'string' && path.startsWith('skills/') && type !== 'tree'
  })
  return validateTreeEntries(entries)
}

/** Parse NUL-delimited `git ls-tree -r -l -z` output into checked entries. */
export function parseGitTree(output: string): readonly TreeEntry[] {
  const records = output.split('\0')
  if (records.at(-1) === '') records.pop()
  const entries = records.map((record) => {
    const match = /^(\S+) (\S+) ([a-f0-9]{40})\s+([0-9]+)\t([\s\S]+)$/u.exec(record)
    if (match === null) throw new Error('invalid git tree output')
    const size = Number(match[4])
    return { mode: match[1], type: match[2], sha: match[3], size, path: match[5] }
  })
  return validateTreeEntries(entries)
}

function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolveGit, rejectGit) => {
    const timeout = AbortSignal.timeout(30_000)
    const runSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const child = spawn('git', [
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      ...args,
    ], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        SSH_ASKPASS_REQUIRE: 'never',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: runSignal,
    })
    const stdout: Buffer[] = []
    let outputSize = 0
    let stderr = ''
    let settled = false
    const resolveOnce = (value: Buffer): void => {
      if (settled) return
      settled = true
      resolveGit(value)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      rejectGit(error)
    }
    const collect = (chunk: unknown): Buffer | undefined => {
      if (settled) return undefined
      const value = Buffer.from(chunk as Uint8Array)
      outputSize += value.length
      if (outputSize > maxTotal) {
        rejectOnce(new Error('git output too large'))
        child.kill()
        return undefined
      }
      return value
    }
    child.stdout.on('data', (chunk: unknown) => {
      const value = collect(chunk)
      if (value !== undefined) stdout.push(value)
    })
    child.stderr.on('data', (chunk: unknown) => {
      const value = collect(chunk)
      if (value !== undefined) stderr += value.toString('utf8')
    })
    child.on('error', (error) => {
      rejectOnce(runSignal.aborted ? abortError(runSignal) : error instanceof Error ? error : new Error('git process failed'))
    })
    child.on('close', (code) => {
      if (runSignal.aborted) {
        rejectOnce(abortError(runSignal))
      } else if (code !== 0) {
        const detail = stderr.trim()
        rejectOnce(new Error(detail === '' ? `git ${args[0] ?? 'command'} failed` : detail))
      } else {
        resolveOnce(Buffer.concat(stdout, outputSize))
      }
    })
  })
}

async function readGitSnapshot(expectedCommit: string | undefined, signal?: AbortSignal): Promise<GitSnapshot> {
  throwIfAborted(signal)
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-compound-git-'))
  try {
    const checkout = join(workspace, 'repo')
    await runGit(['clone', '--quiet', '--bare', '--depth', '1', '--single-branch', '--branch', 'main', '--no-tags', gitRepository, checkout], workspace, signal)
    const commit = (await runGit(['rev-parse', 'HEAD'], checkout, signal)).toString('utf8').trim()
    if (!shaPattern.test(commit)) throw new Error('git clone returned no valid upstream commit')
    if (expectedCommit !== undefined && commit.toLowerCase() !== expectedCommit.toLowerCase()) throw new Error('upstream branch moved while checking the release')
    const output = await runGit(['ls-tree', '-r', '-l', '-z', commit, '--', 'skills'], checkout, signal)
    return { commit, entries: parseGitTree(output.toString('utf8')) }
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 })
  }
}

function shouldUseGitFallback(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /GitHub answered HTTP (?:403|429)/u.test(error.message)
}

/** Download and publish a commit-pinned overlay. This does not restart any process. */
export function updateOverlay(root = overlayRoot(), minimumVersion?: string, signal?: AbortSignal): Promise<OverlayRevision> {
  if (signal?.aborted) return Promise.reject(abortError(signal))
  const key = resolve(root)
  const variant = minimumVersion === undefined ? '<none>' : minimumVersion
  let lock = updateLocks.get(key)
  if (lock === undefined) {
    lock = { tail: Promise.resolve(), pending: new Map() }
    updateLocks.set(key, lock)
  }
  const state = lock
  const running = state.pending.get(variant)
  if (running !== undefined) return running
  const task = state.tail.then(() => updateOverlayOnce(root, minimumVersion, signal))
  state.pending.set(variant, task)
  const tail = task.then(() => undefined, () => undefined)
  state.tail = tail
  const release = (): void => {
    if (state.pending.get(variant) === task) state.pending.delete(variant)
    if (state.pending.size === 0 && updateLocks.get(key) === state && state.tail === tail) updateLocks.delete(key)
  }
  void task.then(release, release)
  return task
}

async function updateOverlayOnce(root: string, minimumVersion?: string, signal?: AbortSignal): Promise<OverlayRevision> {
  throwIfAborted(signal)
  let commit: string
  let entries: readonly TreeEntry[]
  let expectedCommit: string | undefined
  try {
    expectedCommit = await resolveUpstreamCommit(signal)
    const tree = await json(`https://api.github.com/repos/${repository}/git/trees/${expectedCommit}?recursive=1`, signal)
    commit = expectedCommit
    entries = parseApiTree(tree)
  } catch (error) {
    if (!shouldUseGitFallback(error)) throw error
    const snapshot = await readGitSnapshot(expectedCommit, signal)
    commit = snapshot.commit
    entries = snapshot.entries
  }
  const manifest = await json(`https://raw.githubusercontent.com/${repository}/${commit}/plugin.json`, signal)
  const version = typeof manifest === 'object' && manifest !== null ? (manifest as { version?: unknown }).version : undefined
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error('invalid upstream version')
  if (minimumVersion !== undefined && !versionPattern.test(minimumVersion)) throw new Error('invalid bundled version')
  if (minimumVersion !== undefined && olderVersion(version, minimumVersion)) throw new Error('upstream version would downgrade bundled skills')
  const current = activeOverlay(root)
  if (current && olderVersion(version, current.version)) throw new Error('upstream version would downgrade active overlay')
  await mkdir(root, { recursive: true, mode: 0o700 })
  checkPrivateDirectory(root)
  await mkdir(join(root, 'revisions'), { mode: 0o700 }).catch((error: unknown) => {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  checkPrivateDirectory(join(root, 'revisions'))
  const stage = await mkdtemp(join(root, 'revisions', '.stage-'))
  try {
    for (const entry of entries) {
      throwIfAborted(signal)
      const path = entry.path
      const response = await request(`https://raw.githubusercontent.com/${repository}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`, signal)
      const bytes = await boundedBody(response, entry.size)
      throwIfAborted(signal)
      if (bytes.length !== entry.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new Error(`invalid upstream blob: ${path}`)
      const target = join(stage, path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' })
    }
    throwIfAborted(signal)
    for (const name of names) validateSkill(await readFile(join(stage, 'skills', name, 'SKILL.md'), 'utf8'), name)
    const destination = join(root, 'revisions', commit)
    try { await rename(stage, destination) } catch {
      // Reuse only an existing revision whose downloaded files match exactly.
      try {
        checkPrivateDirectory(destination)
        for (const entry of entries) {
          const parts = entry.path.split('/')
          for (let i = 1; i < parts.length; i++) checkPrivateDirectory(join(destination, ...parts.slice(0, i)))
          const target = join(destination, ...parts)
          checkPrivateFile(target)
          if (!(await readFile(target)).equals(await readFile(join(stage, ...parts)))) throw new Error('revision differs')
        }
      } catch (reuseError) { throw new Error(`cannot publish revision: ${String(reuseError)}`) }
    }
    const temporary = join(root, `.current-${randomUUID()}.json`)
    try {
      throwIfAborted(signal)
      await writeFile(temporary, JSON.stringify({ commit, version }), { mode: 0o600, flag: 'wx' })
      const latest = activeOverlay(root)
      if (latest && olderVersion(version, latest.version)) throw new Error('upstream version would downgrade active overlay')
      throwIfAborted(signal)
      await rename(temporary, join(root, 'current.json'))
    } finally { await rm(temporary, { force: true }) }
    return { commit, version }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
