import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalGrokSkillName,
  importGrokBotSkills,
} from '../src/grok-import-skills.ts'

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

  it('allows a managed workspace preview before the workspace is prepared', async () => {
    const cwd = join(await botCwd(), 'unprepared')
    const skills = [{ name: 'Managed Preview', description: '', instructions: 'Prepare the checklist.' }]

    await expect(importGrokBotSkills(cwd, skills, { preview: true, previewMissingDirectory: true }))
      .resolves.toEqual({
        created: ['managed-preview'], skipped: [], namesBySourceName: { 'Managed Preview': 'managed-preview' },
      })
    await expect(importGrokBotSkills(cwd, skills, { preview: true })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(importGrokBotSkills(cwd, skills, { previewMissingDirectory: true })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects relative paths, filesystem roots, and files as workspace destinations', async () => {
    const cwd = await botCwd()
    const file = join(cwd, 'workspace-file')
    await writeFile(file, '')

    await expect(importGrokBotSkills('relative', [])).rejects.toThrow('absolute working directory')
    await expect(importGrokBotSkills(parse(cwd).root, [])).rejects.toThrow('must not be a filesystem root')
    await expect(importGrokBotSkills(file, [], { preview: true, previewMissingDirectory: true }))
      .rejects.toThrow('existing working directory')
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

  it('uses the same canonical mapping for routine references', () => {
    expect(canonicalGrokSkillName('  Weekly Research / Brief  ')).toBe('weekly-research-brief')
    expect(canonicalGrokSkillName('already-valid')).toBe('already-valid')
  })
})
