import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillCompound from '@deepseek-ai/dsh-skill-compound'
import { describe, expect, it } from 'vitest'

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
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillCompound)
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
      await ctx.plugin(SkillCompound, { assetRoot: external })
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
        "- name: '@deepseek-ai/dsh-skill'",
        "- name: '@deepseek-ai/dsh-skill-compound'",
        '  config:',
        `    assetRoot: ${JSON.stringify(external)}`,
        '',
      ].join('\n'))
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-skill', SkillRegistry],
        ['@deepseek-ai/dsh-skill-compound', SkillCompound],
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
