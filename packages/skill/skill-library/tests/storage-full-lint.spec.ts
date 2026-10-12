/** Retained creation plans refuse missing nested directories before journal admission. */
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishMarkdownCreation } from '../src/markdown-creation.ts'
import { planMarkdownSplit } from '../src/markdown-split.ts'

describe('managed storage traversal', () => {
  it.each(['topics', 'source'])('refuses a retained bundle whose %s directory disappeared', async (directory) => {
    const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'dsh-storage-lint-'))
    try {
      const discovery = join(root, '.dsh/skills')
      await fs.mkdir(discovery, { recursive: true, mode: 0o700 })
      const entry = join(discovery, 'created-skill/SKILL.md')
      const original = '# Long skill\n\nIntroduction.\n\n## Topic\n\n' + 'Complete topic paragraph.\n\n'.repeat(110)
      const plan = planMarkdownSplit(original, 'SKILL.md')
      if (plan.kind !== 'split') throw new Error('Fixture source did not split')
      const generation = { id: plan.generation, files: plan.files }
      await expect(publishMarkdownCreation(entry, plan.after, generation, async () => {
        throw new Error('Fixture journal was interrupted')
      })).rejects.toThrow('journal was interrupted')
      const store = join(root, '.dsh/.y-markdown-create')
      const stages = (await fs.readdir(store)).filter(name => !name.startsWith('.'))
      expect(stages).toHaveLength(1)
      const [stageName] = stages
      if (stageName === undefined) throw new Error('Fixture retained stage is absent')
      const stage = join(store, stageName)
      const metadata = await fs.readFile(join(stage, '.creation.json'))
      const stagedEntry = join(stage, 'bundle/SKILL.md')
      const rootBytes = await fs.readFile(stagedEntry)
      await fs.rm(join(stage, 'bundle/.y-topics', plan.generation, directory), { recursive: true })
      let admitted = false
      await expect(publishMarkdownCreation(entry, plan.after, generation, async () => {
        admitted = true
      })).rejects.toThrow('staged bundle is incomplete')
      expect(admitted).toBe(false)
      expect(await fs.readdir(discovery)).toEqual([])
      expect(await fs.readdir(store)).toEqual([stageName])
      expect(await fs.readFile(join(stage, '.creation.json'))).toEqual(metadata)
      expect(await fs.readFile(stagedEntry)).toEqual(rootBytes)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
