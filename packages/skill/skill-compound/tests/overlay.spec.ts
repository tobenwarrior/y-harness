import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import * as localFs from '@yharness/fs-local'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}))

import { activeOverlay, assertPrivateOverlayResources, legacyOverlayRoot, overlayRoot, parseGitTree, resolveOverlayRoot, updateOverlay } from '../src/overlay.ts'
import { privateOverlayRoot } from './private-overlay-root.ts'

type FakeChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill: () => boolean
}

function fakeChild(stdout: string | Buffer = '', stderr: string | Buffer = '', code = 0): FakeChild {
  const child = new EventEmitter() as EventEmitter & Partial<FakeChild>
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {
    child.killed = true
    return true
  }
  setImmediate(() => {
    if (stdout !== '') child.stdout?.emit('data', Buffer.from(stdout))
    if (stderr !== '') child.stderr?.emit('data', Buffer.from(stderr))
    child.emit('close', code)
  })
  return child as FakeChild
}

const gitRepository = 'https://github.com/tobenwarrior/compound-skills.git'

function expectGitPrefix(command: string, args: readonly string[]): void {
  expect(command).toBe('git')
  expect(args.slice(0, 4)).toEqual(['-c', 'credential.helper=', '-c', 'core.askPass='])
}

function expectCloneInvocation(command: string, args: readonly string[]): void {
  expectGitPrefix(command, args)
  expect(args.slice(4, 14)).toEqual([
    'clone', '--quiet', '--bare', '--depth', '1', '--single-branch', '--branch', 'main', '--no-tags', gitRepository,
  ])
  expect(args).toHaveLength(15)
  expect(args[14]).toMatch(/(?:^|[\\/])repo$/u)
}

afterEach(() => {
  vi.unstubAllGlobals()
  spawnMock.mockReset()
})

it('parses and validates NUL-delimited Git tree entries', () => {
  const sha = 'a'.repeat(40)
  const entries = parseGitTree(`100644 blob ${sha}    42\tskills/compound/SKILL.md\0`)
  expect(entries).toEqual([{ mode: '100644', type: 'blob', sha, size: 42, path: 'skills/compound/SKILL.md' }])
  expect(() => parseGitTree(`120000 blob ${sha} 42\tskills/compound/link\0`)).toThrow('unsafe upstream tree entry')
})

it('uses noninteractive Git settings for a rate-limited tree fallback', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  const bin = await mkdtemp(join(tmpdir(), 'compound-git-bin-'))
  const environment = join(bin, 'environment')
  const argumentsPath = join(bin, 'arguments')
  const commit = 'c'.repeat(40)
  const files = new Map(['compound', 'map', 'setup', 'setup-global', 'status-global']
    .map(name => [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: test\n---\ncontent\n`]))
  const tree = [...files].map(([path, text]) => {
    const size = Buffer.byteLength(text)
    const sha = createHash('sha1').update(`blob ${size}\0`).update(text).digest('hex')
    return `100644 blob ${sha}    ${size}\t${path}`
  }).join('\n')
  const treeOutput = tree.split('\n').map(line => `${line}\0`).join('')
  let environmentWritten = false
  spawnMock.mockImplementation((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const environmentValues = options.env ?? {}
    if (!environmentWritten) {
      writeFileSync(environment, `${environmentValues.GIT_TERMINAL_PROMPT ?? ''}|${environmentValues.GIT_ASKPASS ?? ''}|${environmentValues.SSH_ASKPASS ?? ''}|${environmentValues.SSH_ASKPASS_REQUIRE ?? ''}\n`)
      environmentWritten = true
    }
    appendFileSync(argumentsPath, `${args.join('\n')}\n`)
    switch (args[4]) {
      case 'clone':
        expectCloneInvocation(command, args)
        return fakeChild()
      case 'rev-parse':
        expectGitPrefix(command, args)
        expect(args).toEqual(['-c', 'credential.helper=', '-c', 'core.askPass=', 'rev-parse', 'HEAD'])
        return fakeChild(`${commit}\n`)
      case 'ls-tree':
        expectGitPrefix(command, args)
        expect(args).toEqual(['-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-tree', '-r', '-l', '-z', commit, '--', 'skills'])
        return fakeChild(treeOutput)
      default: throw new Error(`unexpected git subcommand: ${String(args[4])}`)
    }
  })
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
    if (url.includes('/git/trees/')) return Promise.resolve(new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version: '1.0.0' }))
    const path = [...files.keys()].find(key => url.endsWith(key))
    return Promise.resolve(new Response(path === undefined ? 'missing' : files.get(path)))
  })
  try {
    await expect(updateOverlay(root)).resolves.toEqual({ commit, version: '1.0.0' })
    expect(await readFile(environment, 'utf8')).toBe('0|||never\n')
    const argumentsLog = await readFile(argumentsPath, 'utf8')
    expect(argumentsLog).toContain('credential.helper=\n')
    expect(argumentsLog).toContain('core.askPass=\n')
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(bin, { recursive: true, force: true }),
    ])
  }
})

it('caps combined Git stdout and stderr during a rate-limited tree fallback', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  const commit = 'd'.repeat(40)
  const streamSize = 11 * 1024 * 1024
  spawnMock.mockImplementation((command: string, args: readonly string[]) => {
    expectCloneInvocation(command, args)
    return fakeChild(Buffer.alloc(streamSize), Buffer.alloc(streamSize))
  })
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
    if (url.includes('/git/trees/')) return Promise.resolve(new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    return Promise.resolve(new Response('missing', { status: 404 }))
  })
  try {
    await expect(updateOverlay(root)).rejects.toThrow('git output too large')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function upstream(
  commit: string,
  version: string,
  corrupt = false,
  extra = false,
  onFetch?: (url: string) => void,
): { calls: () => number } {
  const names = ['compound', 'map', 'setup', 'setup-global', 'status-global']
  const files = new Map(names.map(name => [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: test\n---\ncontent\n`]))
  if (extra) files.set('skills/compound/references/example.txt', 'reference\n')
  const tree = [...files].map(([path, text]) => ({ path, type: 'blob', mode: '100644', size: Buffer.byteLength(text), sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') }))
  let count = 0
  vi.stubGlobal('fetch', (url: string) => {
    count += 1
    onFetch?.(url)
    if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
    if (url.endsWith('/.codex-plugin/plugin.json')) return Promise.resolve(Response.json({ version }))
    if (url.endsWith('/plugin.json')) return Promise.resolve(new Response(null, { status: 404 }))
    if (url.includes('/git/trees/')) return Promise.resolve(Response.json({ truncated: false, tree }))
    const path = [...files.keys()].find(key => url.endsWith(key))!
    return Promise.resolve(new Response(corrupt ? 'bad' : files.get(path)))
  })
  return { calls: () => count }
}

it('publishes atomically, repeats updates and preserves the active revision on failure or downgrade', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    upstream('a'.repeat(40), '2.0.0')
    await updateOverlay(root)
    expect(activeOverlay(root)?.version).toBe('2.0.0')
    const before = await readFile(join(root, 'current.json'), 'utf8')
    await updateOverlay(root)
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before)
    upstream('b'.repeat(40), '1.9.9')
    await expect(updateOverlay(root)).rejects.toThrow('downgrade')
    upstream('b'.repeat(40), '2.1.0', true)
    await expect(updateOverlay(root)).rejects.toThrow()
    expect(await readFile(join(root, 'current.json'), 'utf8')).toBe(before)
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
    upstream('b'.repeat(40), '2.1.0')
    await updateOverlay(root)
    expect(activeOverlay(root)?.commit).toBe('b'.repeat(40))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a symlinked revisions directory', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'revisions'))
    upstream('a'.repeat(40), '1.0.0')
    await expect(updateOverlay(root)).rejects.toThrow('unsafe overlay directory')
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects symlinked current metadata', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    await mkdir(join(root, 'revisions'))
    await symlink(join(root, 'elsewhere'), join(root, 'current.json'))
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a malformed commit without publishing an overlay', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ sha: '../escape' })))
    await expect(updateOverlay(root)).rejects.toThrow('no valid commit')
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a truncated tree before publishing an overlay', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(Response.json(url.includes('/commits/') ? { sha: 'a'.repeat(40) } : url.endsWith('/plugin.json') ? { version: '1.0.0' } : { truncated: true, tree: [] })))
    await expect(updateOverlay(root)).rejects.toThrow('truncated')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('aborts during download without replacing the active revision or leaving staging files', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    upstream('a'.repeat(40), '1.0.0')
    await updateOverlay(root)
    const controller = new AbortController()
    let aborted = false
    upstream('b'.repeat(40), '2.0.0', false, false, (url) => {
      if (!aborted && url.includes('/skills/')) {
        aborted = true
        controller.abort()
      }
    })
    await expect(updateOverlay(root, undefined, controller.signal)).rejects.toThrow()
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
    expect((await readdir(join(root, 'revisions'))).some(name => name.startsWith('.stage-'))).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a release below the bundled baseline without publishing', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    upstream('a'.repeat(40), '1.9.9')
    await expect(updateOverlay(root, '2.0.0')).rejects.toThrow('bundled skills')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('shares one in-flight update for concurrent callers of the same root', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    const observed = upstream('a'.repeat(40), '1.0.0')
    const [first, second] = await Promise.all([updateOverlay(root), updateOverlay(root)])
    expect(first).toEqual({ commit: 'a'.repeat(40), version: '1.0.0' })
    expect(second).toEqual(first)
    expect(observed.calls()).toBe(8)
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('serializes different minimum versions on one root and enforces each caller constraint', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    upstream('a'.repeat(40), '1.9.9')
    const first = updateOverlay(root, '1.0.0')
    const second = updateOverlay(root, '2.0.0')
    await expect(first).resolves.toEqual({ commit: 'a'.repeat(40), version: '1.9.9' })
    await expect(second).rejects.toThrow('bundled skills')
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not reuse an existing revision with unsafe file permissions', async () => {
  const root = await privateOverlayRoot('compound-overlay-test-')
  try {
    upstream('a'.repeat(40), '1.0.0', false, true)
    await updateOverlay(root)
    const reference = join(root, 'revisions', 'a'.repeat(40), 'skills', 'compound', 'references', 'example.txt')
    if (process.platform === 'win32') {
      // Match the native fs-local fixture: chmod changes no Windows DACL, so add an untrusted trustee explicitly.
      execFileSync('icacls.exe', [reference, '/grant', '*S-1-1-0:F'], { stdio: 'ignore' })
    } else {
      await chmod(reference, 0o644)
    }
    const unsafeError = process.platform === 'win32' ? 'unsafe Windows private path' : 'unsafe overlay file'
    await expect(updateOverlay(root)).rejects.toThrow(unsafeError)
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a linked overlay resource directory before publishing its resource paths', async () => {
  const root = await privateOverlayRoot('compound-resource-link-')
  let linkedDirectory: string | undefined
  try {
    upstream('e'.repeat(40), '2.0.0')
    await updateOverlay(root)
    const overlay = activeOverlay(root)
    if (overlay === undefined) throw new Error('Expected the published overlay')
    const target = join(root, 'external-scripts')
    await mkdir(target, { mode: 0o700 })
    await writeFile(join(target, 'map_server.py'), '# external resource\n', { mode: 0o600 })
    const scripts = join(overlay.assetRoot, 'compound', 'scripts')
    await symlink(target, scripts, 'junction')
    linkedDirectory = scripts

    expect(activeOverlay(root)).toBeUndefined()
  } finally {
    if (linkedDirectory !== undefined) await unlink(linkedDirectory)
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { directoryMode: 0o755, fileMode: 0o644 },
  { directoryMode: 0o775, fileMode: 0o664 },
])('keeps owner-created Python caches usable with $directoryMode/$fileMode permissions', async ({ directoryMode, fileMode }) => {
  const root = await privateOverlayRoot('compound-resource-cache-')
  try {
    upstream('e'.repeat(40), '2.0.0')
    await updateOverlay(root)
    const overlay = activeOverlay(root)
    if (overlay === undefined) throw new Error('Expected the published overlay')
    const cache = join(overlay.assetRoot, 'compound', 'scripts', '__pycache__')
    const bytecode = join(cache, 'map_engine.cpython-311.pyc')
    await mkdir(cache, { recursive: true, mode: directoryMode })
    await writeFile(bytecode, 'generated cache', { mode: fileMode })
    await chmod(cache, directoryMode)
    await chmod(bytecode, fileMode)
    expect(activeOverlay(root)?.commit).toBe(overlay.commit)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(typeof process.getuid !== 'function')('rejects resources owned by another POSIX user', async () => {
  const root = await privateOverlayRoot('compound-resource-owner-')
  const getuid = process.getuid
  if (getuid === undefined) throw new Error('This case requires POSIX user identifiers')
  const currentUid = getuid()
  const owner = vi.spyOn(process, 'getuid').mockReturnValue(currentUid + 1)
  try {
    expect(() => { assertPrivateOverlayResources(root) }).toThrow('unsafe overlay resource')
  } finally {
    owner.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('rejects a POSIX resource writable through an external hard link', async () => {
  const root = await privateOverlayRoot('compound-resource-hardlink-')
  const external = await mkdtemp(join(tmpdir(), 'compound-resource-alias-'))
  try {
    upstream('e'.repeat(40), '2.0.0')
    await updateOverlay(root)
    const overlay = activeOverlay(root)
    if (overlay === undefined) throw new Error('Expected the published overlay')
    const scripts = join(overlay.assetRoot, 'compound', 'scripts')
    await mkdir(scripts, { mode: 0o700 })
    const alias = join(external, 'helper.py')
    await writeFile(alias, '# linked resource\n', { mode: 0o644 })
    await chmod(alias, 0o644)
    await link(alias, join(scripts, 'helper.py'))
    expect(activeOverlay(root)?.commit).toBe(overlay.commit)

    await chmod(alias, 0o664)
    expect(activeOverlay(root)).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

it('checks every Windows resource with the native private-file policy', async () => {
  const root = await privateOverlayRoot('compound-resource-windows-')
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const nativePolicy = vi.spyOn(localFs, 'assertOwnerPrivateWin32').mockImplementation(() => {})
  try {
    if (descriptor === undefined) throw new Error('Expected the Node platform property')
    upstream('e'.repeat(40), '2.0.0')
    await updateOverlay(root)
    const overlay = activeOverlay(root)
    if (overlay === undefined) throw new Error('Expected the published overlay')
    const directory = join(overlay.assetRoot, 'compound', 'scripts')
    const script = join(directory, 'map_server.py')
    await mkdir(directory, { mode: 0o700 })
    await writeFile(script, '# private resource\n', { mode: 0o600 })

    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    expect(activeOverlay(root)).toBeDefined()
    expect(nativePolicy).toHaveBeenCalledWith(directory, 'directory')
    expect(nativePolicy).toHaveBeenCalledWith(script, 'file')
    nativePolicy.mockImplementation((path) => {
      if (path === script) throw new Error('Resource ACL permits an untrusted writer')
    })
    expect(activeOverlay(root)).toBeUndefined()
  } finally {
    if (descriptor !== undefined) Object.defineProperty(process, 'platform', descriptor)
    nativePolicy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('uses the Y Harness data path and keeps a legacy active overlay selected', async () => {
  const home = await mkdtemp(join(tmpdir(), 'compound-overlay-home-'))
  try {
    expect(overlayRoot(home)).toBe(join(home, '.local', 'share', 'y-harness', 'compound-skills'))
    const legacy = legacyOverlayRoot(home)
    expect(legacy).toBe(join(home, '.local', 'share', 'deepseek-harness', 'compound-skills'))
    upstream('a'.repeat(40), '1.0.0')
    await updateOverlay(legacy)
    expect(resolveOverlayRoot(home)).toBe(legacy)
    expect(activeOverlay(legacy)?.commit).toBe('a'.repeat(40))
    expect(activeOverlay(overlayRoot(home))).toBeUndefined()
    upstream('b'.repeat(40), '1.1.0')
    await updateOverlay(overlayRoot(home))
    expect(resolveOverlayRoot(home)).toBe(overlayRoot(home))
    expect(activeOverlay(legacy)?.commit).toBe('a'.repeat(40))
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('keeps an existing but not-yet-published legacy root as the update target', async () => {
  const home = await mkdtemp(join(tmpdir(), 'compound-overlay-home-'))
  try {
    const legacy = legacyOverlayRoot(home)
    await mkdir(legacy, { recursive: true, mode: 0o700 })
    expect(resolveOverlayRoot(home)).toBe(legacy)
  } finally { await rm(home, { recursive: true, force: true }) }
})
