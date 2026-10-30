import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { activeOverlay, legacyOverlayRoot, overlayRoot, parseGitTree, resolveOverlayRoot, updateOverlay } from '../src/overlay.ts'

afterEach(() => vi.unstubAllGlobals())

it('parses and validates NUL-delimited Git tree entries', () => {
  const sha = 'a'.repeat(40)
  const entries = parseGitTree(`100644 blob ${sha}    42\tskills/compound/SKILL.md\0`)
  expect(entries).toEqual([{ mode: '100644', type: 'blob', sha, size: 42, path: 'skills/compound/SKILL.md' }])
  expect(() => parseGitTree(`120000 blob ${sha} 42\tskills/compound/link\0`)).toThrow('unsafe upstream tree entry')
})

it('uses noninteractive Git settings for a rate-limited tree fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  const bin = await mkdtemp(join(tmpdir(), 'compound-git-bin-'))
  const git = join(bin, 'git')
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
  const treeOutput = tree.split('\n').map(line => `printf '%s\\000' '${line}'`).join('\n')
  const script = [
    '#!/bin/sh',
    `if [ ! -f ${JSON.stringify(environment)} ]; then printf '%s\\n' "$GIT_TERMINAL_PROMPT|$GIT_ASKPASS|$SSH_ASKPASS|$SSH_ASKPASS_REQUIRE" > ${JSON.stringify(environment)}; fi`,
    `printf '%s\\n' "$@" >> ${JSON.stringify(argumentsPath)}`,
    'command="$5"',
    'last=""',
    'for arg do last="$arg"; done',
    'if [ "$command" = clone ]; then mkdir -p "$last"; fi',
    `if [ "$command" = rev-parse ]; then printf '%s\\n' '${commit}'; fi`,
    'if [ "$command" = ls-tree ]; then',
    treeOutput,
    'fi',
    '',
  ].join('\n')
  await writeFile(git, script)
  await chmod(git, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
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
    process.env.PATH = previousPath
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(bin, { recursive: true, force: true }),
    ])
  }
})

it('caps combined Git stdout and stderr during a rate-limited tree fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  const bin = await mkdtemp(join(tmpdir(), 'compound-git-bin-'))
  const git = join(bin, 'git')
  const commit = 'd'.repeat(40)
  const streamSize = 11 * 1024 * 1024
  const script = [
    '#!/bin/sh',
    'command="$5"',
    `if [ "$command" = clone ]; then head -c ${String(streamSize)} /dev/zero; head -c ${String(streamSize)} /dev/zero >&2; exit 0; fi`,
    '',
  ].join('\n')
  await writeFile(git, script)
  await chmod(git, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
    if (url.includes('/git/trees/')) return Promise.resolve(new Response('rate limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    return Promise.resolve(new Response('missing', { status: 404 }))
  })
  try {
    await expect(updateOverlay(root)).rejects.toThrow('git output too large')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally {
    process.env.PATH = previousPath
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(bin, { recursive: true, force: true }),
    ])
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
    if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version }))
    if (url.includes('/git/trees/')) return Promise.resolve(Response.json({ truncated: false, tree }))
    const path = [...files.keys()].find(key => url.endsWith(key))!
    return Promise.resolve(new Response(corrupt ? 'bad' : files.get(path)))
  })
  return { calls: () => count }
}

it('publishes atomically, repeats updates and preserves the active revision on failure or downgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
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
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    await mkdir(join(root, 'elsewhere'))
    await symlink(join(root, 'elsewhere'), join(root, 'revisions'))
    upstream('a'.repeat(40), '1.0.0')
    await expect(updateOverlay(root)).rejects.toThrow('unsafe overlay directory')
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects symlinked current metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    await mkdir(join(root, 'revisions'))
    await symlink(join(root, 'elsewhere'), join(root, 'current.json'))
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a malformed commit without publishing an overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ sha: '../escape' })))
    await expect(updateOverlay(root)).rejects.toThrow('no valid commit')
    expect(activeOverlay(root)).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a truncated tree before publishing an overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(Response.json(url.includes('/commits/') ? { sha: 'a'.repeat(40) } : url.endsWith('/plugin.json') ? { version: '1.0.0' } : { truncated: true, tree: [] })))
    await expect(updateOverlay(root)).rejects.toThrow('truncated')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('aborts during download without replacing the active revision or leaving staging files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
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
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    upstream('a'.repeat(40), '1.9.9')
    await expect(updateOverlay(root, '2.0.0')).rejects.toThrow('bundled skills')
    await expect(readFile(join(root, 'current.json'))).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('shares one in-flight update for concurrent callers of the same root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
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
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
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
  const root = await mkdtemp(join(tmpdir(), 'compound-overlay-test-'))
  try {
    upstream('a'.repeat(40), '1.0.0', false, true)
    await updateOverlay(root)
    const reference = join(root, 'revisions', 'a'.repeat(40), 'skills', 'compound', 'references', 'example.txt')
    await chmod(reference, 0o644)
    await expect(updateOverlay(root)).rejects.toThrow('unsafe overlay file')
    expect(activeOverlay(root)?.commit).toBe('a'.repeat(40))
  } finally { await rm(root, { recursive: true, force: true }) }
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
