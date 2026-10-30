import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@yharness/cordis'
import Include from '@yharness/cordis-plugin-include'
import Loader from '@yharness/cordis-plugin-loader'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import SkillRegistry from '@yharness/skill'
import * as SkillCompound from '@yharness/skill-compound'
import { activeOverlay } from '../src/overlay.ts'
import { AUTO_UPDATE_INTERVAL_MS } from '../src/index.ts'
import { VENDORED_VERSION } from '../src/upstream.ts'
import { describe, expect, it, vi } from 'vitest'

const assets = fileURLToPath(new URL('../assets/', import.meta.url))
const names = ['compound', 'map', 'setup', 'setup-global', 'status-global']

/**
 * Write an executable stand-in that reports one Python release.
 * @param root - directory that receives the script.
 * @param version - release string the script prints.
 * @returns the absolute script path.
 */
async function fakePython(root: string, version: string): Promise<string> {
  const path = join(root, `python-${version}`)
  await writeFile(path, `#!/bin/sh\necho "Python ${version}"\n`)
  await chmod(path, 0o755)
  return path
}

/**
 * Write one vendored skill file beneath a temporary assets root.
 * @param root - assets root that receives `<name>/SKILL.md`.
 * @param content - complete file text.
 * @returns resolution after the file exists.
 */
async function writeSkill(root: string, content: string): Promise<void> {
  await mkdir(join(root, 'compound'), { recursive: true })
  await writeFile(join(root, 'compound', 'SKILL.md'), content)
}

describe('bundled Compound skills', () => {
  it('registers every vendored skill and serves its body with the runtime paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-bundled-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { overlayRoot: root })
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual(names)
      for (const skill of catalog) {
        expect(skill).toMatchObject({
          source: 'bundled',
          provider: 'dsh-compound',
          invocation: { modelInvocable: true, userInvocable: true },
        })
        expect(skill.description.length).toBeGreaterThan(0)
        const loaded = await ctx.skills.get(skill.name)
        expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assets, skill.name) })
        const raw = await readFile(join(assets, skill.name, 'SKILL.md'), 'utf8')
        expect(loaded?.content).toContain(raw.slice(raw.indexOf('\n---\n') + 5).trim())
        expect(loaded?.content).toContain('## Compound runtime')
        expect(loaded?.content).toContain('## Y Harness activation')
        expect(loaded?.content).toContain(JSON.stringify(join(assets, skill.name)))
        expect(loaded?.content).toContain('"python"')
      }
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes every candidate when its fiber is disposed', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillCompound)
      expect((await ctx.skills.list()).length).toBe(names.length)
      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads relocated assets through the assetRoot config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-skills-'))
    const ctx = new Context()
    try {
      const external = join(root, 'relocated assets')
      await mkdir(external, { recursive: true })
      for (const name of names) {
        await mkdir(join(external, name), { recursive: true })
        await writeFile(join(external, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "relocated ${name}"\n---\n\nBody for ${name}.\n`)
      }
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { assetRoot: external, overlayRoot: root })
      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.description)).toEqual(names.map(name => `relocated ${name}`))
      const loaded = await ctx.skills.get('map')
      expect(loaded?.content).toContain('Body for map.')
      expect(loaded?.content).toContain(JSON.stringify(join(external, 'map')))
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads a valid private overlay and keeps the bundled assets as fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-overlay-'))
    const ctx = new Context()
    try {
      const commit = 'a'.repeat(40)
      const skills = join(root, 'revisions', commit, 'skills')
      for (const name of names) {
        const directory = join(skills, name)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: "overlay ${name}"\n---\n\nOverlay body ${name}.\n`, { mode: 0o600 })
      }
      await writeFile(join(root, 'current.json'), JSON.stringify({ commit, version: '2.0.0' }), { mode: 0o600 })
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { overlayRoot: root })
      expect((await ctx.skills.list()).map(skill => skill.description)).toEqual(names.map(name => `overlay ${name}`))
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(skills, 'compound') })
      expect(loaded?.content).toContain('Overlay body compound.')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('automatically applies upstream revisions and stops after disposal', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-auto-update-'))
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    let upstreamVersion = '2.0.0'
    let upstreamCommit = 'a'.repeat(40)
    let fetchCalls = 0
    let treeStarted = Promise.withResolvers<undefined>()
    const filesFor = () => new Map(names.map(name => [
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: upstream ${upstreamVersion}\n---\n\nAuto body ${upstreamVersion}.\n`,
    ]))
    vi.stubGlobal('fetch', (url: string) => {
      fetchCalls += 1
      if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: upstreamCommit }))
      if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version: upstreamVersion }))
      const files = filesFor()
      if (url.includes('/git/trees/')) {
        treeStarted.resolve(undefined)
        const tree = [...files].map(([path, text]) => ({
          path, type: 'blob', mode: '100644', size: Buffer.byteLength(text),
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'),
        }))
        return Promise.resolve(Response.json({ truncated: false, tree }))
      }
      const path = [...files.keys()].find(key => url.endsWith(key))
      return Promise.resolve(new Response(path === undefined ? 'missing' : files.get(path)))
    })
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillCompound, { overlayRoot: root })
      await treeStarted.promise
      const applyRoute = routes.find(route => route.path === '/api/skill-compound.update.apply')
      expect(applyRoute).toBeDefined()
      await applyRoute!.fetch(new Request('http://localhost/api/skill-compound.update.apply', { method: 'POST' }))
      expect(activeOverlay(root)?.version).toBe('2.0.0')
      treeStarted = Promise.withResolvers<undefined>()
      upstreamVersion = '2.1.0'
      upstreamCommit = 'b'.repeat(40)
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS)
      await treeStarted.promise
      await applyRoute!.fetch(new Request('http://localhost/api/skill-compound.update.apply', { method: 'POST' }))
      expect(activeOverlay(root)?.version).toBe('2.1.0')
      const callsAfterUpdate = fetchCalls
      await fiber.dispose()
      upstreamVersion = '2.2.0'
      upstreamCommit = 'c'.repeat(40)
      await vi.advanceTimersByTimeAsync(AUTO_UPDATE_INTERVAL_MS * 2)
      expect(fetchCalls).toBe(callsAfterUpdate)
      expect(activeOverlay(root)?.version).toBe('2.1.0')
      expect(routes.map(route => route.path)).toContain('/api/skill-compound.update')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('applies an update and reports its status through a real Loader composition', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-loader-update-'))
    const configPath = join(root, 'cordis.yml')
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    const upstreamVersion = '2.0.0'
    const upstreamCommit = 'd'.repeat(40)
    const treeStarted = Promise.withResolvers<undefined>()
    const files = new Map(names.map(name => [
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: composed upstream ${upstreamVersion}\n---\n\nLoader body ${upstreamVersion}.\n`,
    ]))
    vi.stubGlobal('fetch', (url: string) => {
      if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: upstreamCommit }))
      if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version: upstreamVersion }))
      if (url.includes('/git/trees/')) {
        treeStarted.resolve(undefined)
        const tree = [...files].map(([path, text]) => ({
          path, type: 'blob', mode: '100644', size: Buffer.byteLength(text),
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'),
        }))
        return Promise.resolve(Response.json({ truncated: false, tree }))
      }
      const path = [...files.keys()].find(key => url.endsWith(key))
      return Promise.resolve(new Response(path === undefined ? 'missing' : files.get(path)))
    })
    await writeFile(configPath, [
      "- name: '@yharness/skill'",
      "- name: '@yharness/skill-compound'",
      '  config:',
      `    overlayRoot: ${JSON.stringify(root)}`,
      '',
    ].join('\n'))
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (specifier === '@yharness/skill') return SkillRegistry
          if (specifier === '@yharness/skill-compound') return SkillCompound
          throw new Error(`Unexpected Loader import: ${specifier}`)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      await treeStarted.promise
      const applyRoute = routes.find(route => route.path === '/api/skill-compound.update.apply')
      expect(applyRoute).toBeDefined()
      await applyRoute!.fetch(new Request('http://localhost/api/skill-compound.update.apply', { method: 'POST' }))
      expect(activeOverlay(root)?.version).toBe(upstreamVersion)
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.content).toContain(`Loader body ${upstreamVersion}.`)
      const statusRoute = routes.find(route => route.path === '/api/skill-compound.update')
      expect(statusRoute).toBeDefined()
      const response = await statusRoute!.fetch(new Request('http://localhost/api/skill-compound.update'))
      await expect(response.json()).resolves.toMatchObject({
        vendored: upstreamVersion, upstream: upstreamVersion, updateAvailable: false, error: null,
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('keeps a manual update alive after the request aborts and waits on disposal', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-manual-update-'))
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    let upstreamVersion = VENDORED_VERSION
    let upstreamCommit = 'd36f372a60624b92e0e364871cae2c50cbf4ba01'
    let upstreamSignal: AbortSignal | null | undefined
    const initialStatus = Promise.withResolvers<undefined>()
    const rawStarted = Promise.withResolvers<undefined>()
    const filesFor = () => new Map(names.map(name => [
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: manual upstream ${upstreamVersion}\n---\n\nManual body ${upstreamVersion}.\n`,
    ]))
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.includes('/commits/')) {
        initialStatus.resolve(undefined)
        return Promise.resolve(Response.json({ sha: upstreamCommit }))
      }
      if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version: upstreamVersion }))
      const files = filesFor()
      if (url.includes('/git/trees/')) {
        const tree = [...files].map(([path, text]) => ({
          path, type: 'blob', mode: '100644', size: Buffer.byteLength(text),
          sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'),
        }))
        return Promise.resolve(Response.json({ truncated: false, tree }))
      }
      const path = [...files.keys()].find(key => url.endsWith(key))
      if (path === undefined) return Promise.resolve(new Response('missing'))
      upstreamSignal = init?.signal
      rawStarted.resolve(undefined)
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('manual update aborted', { cause: init.signal?.reason }))
        }, { once: true })
      })
    })
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(SkillCompound, { overlayRoot: root })
      await initialStatus.promise
      upstreamVersion = '2.0.0'
      upstreamCommit = 'a'.repeat(40)
      const applyRoute = routes.find(route => route.path === '/api/skill-compound.update.apply')
      expect(applyRoute).toBeDefined()
      const controller = new AbortController()
      const responsePromise = applyRoute!.fetch(new Request('http://localhost/api/skill-compound.update.apply', { method: 'POST', signal: controller.signal }))
      await rawStarted.promise
      controller.abort()
      expect(upstreamSignal?.aborted).toBe(false)
      await fiber.dispose()
      await expect(responsePromise).rejects.toThrow()
      expect(upstreamSignal?.aborted).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('accepts an explicit interpreter, including a release above the minimum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-python-'))
    const ctx = new Context()
    try {
      const python = await fakePython(root, '4.0.1')
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { python })
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.content).toContain(JSON.stringify(python))
      expect(loaded?.content).not.toContain('older than the required Python')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('reports an interpreter older than the scripts require', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-old-'))
    const ctx = new Context()
    try {
      const python = await fakePython(root, '3.9.6')
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { python })
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.content).toContain(JSON.stringify(python))
      expect(loaded?.content).toContain('older than the required Python 3.11')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to a bare python3 when no candidate on PATH answers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-empty-path-'))
    const ctx = new Context()
    const previous = process.env.PATH
    try {
      process.env.PATH = root
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound)
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.content).toContain('"python": "python3"')
      expect(loaded?.content).toContain('older than the required Python 3.11')
    } finally {
      process.env.PATH = previous
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers relocated resources through a real cordis.yml composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-composition-'))
    const ctx = new Context()
    try {
      const external = join(root, 'relocated skills')
      await mkdir(external, { recursive: true })
      for (const name of names) {
        await mkdir(join(external, name), { recursive: true })
        await writeFile(join(external, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "composed ${name}"\n---\n\nComposed body ${name}.\n`)
      }
      const configPath = join(root, 'cordis.yml')
      await writeFile(configPath, [
        "- name: '@yharness/skill'",
        "- name: '@yharness/skill-compound'",
        '  config:',
        `    assetRoot: ${JSON.stringify(external)}`,
        `    overlayRoot: ${JSON.stringify(root)}`,
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@yharness/skill', SkillRegistry],
        ['@yharness/skill-compound', SkillCompound],
      ])
      const internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected Loader import: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      ctx.loader.internal = internal
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(names)
      const loaded = await ctx.skills.get('map')
      expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(external, 'map') })
      expect(loaded?.content).toContain('Composed body map.')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats an interpreter that cannot report a Python release as unsupported', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound, { python: process.execPath })
      const loaded = await ctx.skills.get('compound')
      expect(loaded?.content).toContain('older than the required Python 3.11')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a relative assetRoot or interpreter path', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: 'assets' })).rejects.toThrow('assetRoot must be an absolute directory')
      await expect(ctx.plugin(SkillCompound, { python: 'python3.11' })).rejects.toThrow('python must be an absolute interpreter path')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects vendored files without usable frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-bad-frontmatter-'))
    const ctx = new Context()
    try {
      await writeSkill(root, '# Compound\n\nNo frontmatter.\n')
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: root })).rejects.toThrow('has no YAML frontmatter')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects frontmatter that is not a mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-scalar-frontmatter-'))
    const ctx = new Context()
    try {
      await writeSkill(root, '---\njust-a-string\n---\n\nBody.\n')
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: root })).rejects.toThrow('has no YAML mapping')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a skill file with no name or no description', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-incomplete-frontmatter-'))
    const ctx = new Context()
    try {
      await writeSkill(root, '---\ndescription: "unnamed"\n---\n\nBody.\n')
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: root })).rejects.toThrow('has no name')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a description-less skill file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-no-description-'))
    const ctx = new Context()
    try {
      await writeSkill(root, '---\nname: compound\n---\n\nBody.\n')
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: root })).rejects.toThrow('has no description')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a directory whose file declares another skill name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-misnamed-'))
    const ctx = new Context()
    try {
      await writeSkill(root, '---\nname: not-compound\ndescription: "mismatch"\n---\n\nBody.\n')
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(SkillCompound, { assetRoot: root })).rejects.toThrow('but its directory is "compound"')
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
