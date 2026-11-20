import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalGrokSkillName,
  importGrokBotSkills,
} from '../src/grok-import-skills.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function botCwd(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yh-grok-skill-import-'))
  roots.push(root)
  return root
}

describe('Grok Bot skill import', () => {
  it('maps display names to discoverable kebab-case bundles with private permissions', async () => {
    const cwd = await botCwd()

    const result = await importGrokBotSkills(cwd, [{
      name: 'Release Captain',
      description: 'Prepare a release checklist.',
      instructions: '# Release Captain\n\nPrepare the checklist.',
    }])

    expect(result).toMatchObject({
      created: ['release-captain'],
      skipped: [],
      namesBySourceName: { 'Release Captain': 'release-captain' },
    })
    const agents = join(cwd, '.agents')
    const skills = join(agents, 'skills')
    const file = join(skills, 'release-captain', 'SKILL.md')
    expect(await readFile(file, 'utf8')).toBe([
      '---',
      'name: release-captain',
      'description: "Prepare a release checklist."',
      '---',
      '',
      '# Release Captain',
      '',
      'Prepare the checklist.',
      '',
    ].join('\n'))
    if (process.platform !== 'win32') {
      expect((await lstat(agents)).mode & 0o777).toBe(0o700)
      expect((await lstat(skills)).mode & 0o777).toBe(0o700)
      expect((await lstat(file)).mode & 0o777).toBe(0o600)
    }
  })

  it('is idempotent and never overwrites an existing skill body', async () => {
    const cwd = await botCwd()
    const skill = {
      name: 'release-captain',
      description: 'Prepare a release checklist.',
      instructions: 'Prepare the checklist.',
    }

    await expect(importGrokBotSkills(cwd, [skill])).resolves.toMatchObject({
      created: ['release-captain'],
      skipped: [],
    })
    const path = join(cwd, '.agents/skills/release-captain/SKILL.md')
    if (process.platform !== 'win32') await chmod(path, 0o644)
    const before = await lstat(path)
    await expect(importGrokBotSkills(cwd, [skill])).resolves.toMatchObject({
      created: [],
      skipped: ['release-captain'],
    })
    expect((await lstat(path)).mode).toBe(before.mode)
    await expect(importGrokBotSkills(cwd, [{ ...skill, instructions: 'Do something else.' }]))
      .rejects.toThrow(/already exists with different content/)
    await expect(readFile(path, 'utf8'))
      .resolves.toContain('Prepare the checklist.')
  })

  it('previews a new import without creating or changing filesystem paths', async () => {
    const cwd = await botCwd()
    await expect(importGrokBotSkills(cwd, [{
      name: 'Preview Only', description: 'Preview', instructions: 'Do not write.',
    }], { preview: true })).resolves.toMatchObject({
      created: ['preview-only'],
      skipped: [],
    })
    await expect(lstat(join(cwd, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('previews a new Bot workspace before the directory exists', async () => {
    const cwd = join(await botCwd(), 'new-bot')
    const skill = { name: 'Draft Status', description: '', instructions: 'Write a status update.' }

    await expect(importGrokBotSkills(cwd, [skill], { preview: true, previewMissingDirectory: true }))
      .resolves.toEqual({ created: ['draft-status'], skipped: [], namesBySourceName: { 'Draft Status': 'draft-status' } })
    await expect(importGrokBotSkills(cwd, [skill], { preview: true })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses a supplied workspace installer without touching the Host placeholder', async () => {
    const cwd = await botCwd()
    const installed = new Map<string, string>()
    const install = vi.fn(async (name: string, content: string, preview: boolean): Promise<boolean> => {
      const previous = installed.get(name)
      if (previous !== undefined) {
        if (previous !== content) throw new Error('A Grok skill file already exists with different content.')
        return false
      }
      if (!preview) installed.set(name, content)
      return true
    })
    const skill = { name: 'Container Skill', description: 'Container', instructions: 'Run in the Computer.' }

    await expect(importGrokBotSkills(cwd, [skill], { preview: true, install })).resolves.toMatchObject({
      created: ['container-skill'], skipped: [],
    })
    expect(installed).toEqual(new Map())
    await expect(lstat(join(cwd, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(importGrokBotSkills(cwd, [skill], { install })).resolves.toMatchObject({
      created: ['container-skill'], skipped: [],
    })
    await expect(importGrokBotSkills(cwd, [skill], { install })).resolves.toMatchObject({
      created: [], skipped: ['container-skill'],
    })
    expect(install).toHaveBeenCalledTimes(3)
  })

  it('retries a partially published workspace batch without replacing the first skill', async () => {
    const cwd = await botCwd()
    const installed = new Map<string, string>()
    let failSecond = true
    const install = async (name: string, content: string, preview: boolean): Promise<boolean> => {
      const previous = installed.get(name)
      if (previous !== undefined) {
        if (previous !== content) throw new Error('A Grok skill file already exists with different content.')
        return false
      }
      if (name === 'second-skill' && failSecond) {
        failSecond = false
        throw new Error('The Computer transfer was interrupted.')
      }
      if (!preview) installed.set(name, content)
      return true
    }
    const skills = [
      { name: 'First Skill', description: '', instructions: 'First.' },
      { name: 'Second Skill', description: '', instructions: 'Second.' },
    ]

    await expect(importGrokBotSkills(cwd, skills, { install })).rejects.toThrow('transfer was interrupted')
    expect([...installed.keys()]).toEqual(['first-skill'])
    await expect(importGrokBotSkills(cwd, skills, { install })).resolves.toMatchObject({
      created: ['second-skill'], skipped: ['first-skill'],
    })
    expect(installed.has('first-skill')).toBe(true)
    expect(installed.has('second-skill')).toBe(true)
  })

  it('rejects relative, broad, and non-directory workspace destinations', async () => {
    const cwd = await botCwd()
    await expect(importGrokBotSkills('relative', [])).rejects.toThrow(/absolute working directory/)
    await expect(importGrokBotSkills(parse(cwd).root, [])).rejects.toThrow(/filesystem root/)
    const file = join(cwd, 'workspace.txt')
    await writeFile(file, 'existing file')
    await expect(importGrokBotSkills(file, [])).rejects.toThrow(/existing working directory/)

    await writeFile(join(cwd, '.agents'), 'existing skill settings')
    await expect(importGrokBotSkills(cwd, [])).rejects.toThrow(/must be a directory/)
    await expect(readFile(join(cwd, '.agents'), 'utf8')).resolves.toBe('existing skill settings')
  })

  it('rejects conflicting names before writing any skill in the batch', async () => {
    const cwd = await botCwd()
    const skill = { name: 'Draft Status', description: '', instructions: 'Write a status update.' }
    await expect(importGrokBotSkills(cwd, [skill, { ...skill, name: 'draft status', instructions: 'Read the notes.' }]))
      .rejects.toThrow(/same workspace name/)
    await expect(lstat(join(cwd, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => canonicalGrokSkillName('🤖')).toThrow(/workspace identifier/)
  })

  it('reuses an identical skill imported concurrently and cleans up temporary files', async () => {
    const cwd = await botCwd()
    const skill = { name: 'Draft Status', description: '', instructions: 'Write a status update.' }
    const [first, second] = await Promise.all([importGrokBotSkills(cwd, [skill]), importGrokBotSkills(cwd, [skill])])
    expect([...first.created, ...second.created]).toEqual(['draft-status'])
    expect([...first.skipped, ...second.skipped]).toEqual(['draft-status'])
    const folder = join(cwd, '.agents', 'skills', 'draft-status')
    expect(await readdir(folder)).toEqual(['SKILL.md'])
    expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toContain('Write a status update.')
  })

  it('rejects symlinked skill roots before writing outside the Bot workspace', async () => {
    const cwd = await botCwd()
    const outside = await botCwd()
    const agents = join(cwd, '.agents')
    const skillRoot = join(outside, 'skills')
    await symlink(skillRoot, agents, 'junction')

    await expect(importGrokBotSkills(cwd, [{
      name: 'Unsafe', description: 'Unsafe', instructions: 'Unsafe',
    }])).rejects.toThrow(/symbolic link/)
    await expect(lstat(join(outside, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a symbolic link in place of a skill file', async () => {
    const cwd = await botCwd()
    const outside = await botCwd()
    const folder = join(cwd, '.agents', 'skills', 'draft-status')
    await mkdir(folder, { recursive: true })
    await symlink(outside, join(folder, 'SKILL.md'), 'junction')

    await expect(importGrokBotSkills(cwd, [{ name: 'Draft Status', description: '', instructions: 'Write a status update.' }]))
      .rejects.toThrow(/symbolic link file/)
    expect(await readdir(outside)).toEqual([])
  })

  it.each(['lstat', 'mkdir', 'link'] as const)('propagates an unexpected %s error without publishing a partial skill', async (operation) => {
    const cwd = await botCwd()
    const fs = await import('node:fs/promises')
    const failure = Object.assign(new Error('Workspace storage unavailable'), { code: 'EIO' })
    const operationMock = operation === 'lstat'
      ? vi.spyOn(fs, 'lstat').mockResolvedValueOnce(await lstat(cwd)).mockRejectedValueOnce(failure)
      : vi.spyOn(fs, operation).mockRejectedValueOnce(failure)
    try {
      await expect(importGrokBotSkills(cwd, [{ name: 'Draft Status', description: '', instructions: 'Write a status update.' }]))
        .rejects.toBe(failure)
    } finally {
      operationMock.mockRestore()
    }
    const folder = join(cwd, '.agents', 'skills', 'draft-status')
    if (operation === 'link') expect(await readdir(folder)).toEqual([])
    else await expect(lstat(folder)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses the same canonical mapping for routine references', () => {
    expect(canonicalGrokSkillName('  Weekly Research / Brief  ')).toBe('weekly-research-brief')
    expect(canonicalGrokSkillName('already-valid')).toBe('already-valid')
  })
})
