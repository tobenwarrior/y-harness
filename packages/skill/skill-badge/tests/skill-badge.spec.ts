import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@yharness/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@yharness/skill'
import * as SkillBadge from '@yharness/skill-badge'

describe('y-harness-skill-badge', () => {
  it('registers and disposes the bundled badge skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillBadge)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    const listed = await ctx.skills.list()
    expect(listed.map(skill => skill.name)).toEqual(['dsh-badge', 'y-harness-badge'])
    expect(listed.find(skill => skill.name === 'y-harness-badge')).toEqual({
      name: 'y-harness-badge',
      description: 'Add the official Y Harness badge to documents, pull requests, merge requests, and other content produced with Y Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Y Harness badge, Y Harness attribution, or a reusable Y Harness badge asset or snippet.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'y-harness-badge',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    })
    expect(listed.find(skill => skill.name === 'dsh-badge')).toMatchObject({
      name: 'dsh-badge',
      description: 'Legacy alias for the Y Harness badge skill. Use y-harness-badge for new references.',
      invocation: { modelInvocable: false, userInvocable: true },
      provider: 'y-harness-badge',
    })
    const loaded = await ctx.skills.get('y-harness-badge')
    expect(loaded?.content).toContain('Preserve the badge\'s 121×20 dimensions')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })
    expect((await ctx.skills.get('dsh-badge'))?.name).toBe('dsh-badge')

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('ships a Y Harness SVG badge without legacy visible branding', async () => {
    const image = await readFile(new URL('../assets/y-harness-badge.svg', import.meta.url), 'utf8')
    expect(image).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="726" height="120"')
    expect(image).toContain('<title id="title">Powered by Y Harness</title>')
    expect(image).not.toMatch(/dsh|deepseek|whale/i)
  })
})
