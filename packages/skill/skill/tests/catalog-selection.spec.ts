import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry, { selectSkillCatalog, type SkillSummary } from '@deepseek-ai/dsh-skill'

function summary(name: string, description: string, extra: Partial<SkillSummary> = {}): SkillSummary {
  return { name, description, source: 'runtime', provider: 'fixture', invocation: { modelInvocable: true, userInvocable: true }, ...extra }
}

describe('metadata catalog selection', () => {
  it('retrieves current scoped winners without loading a provider body, preserving incomplete discovery', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.register({ name: 'review', description: 'Garden', source: 'runtime', content: 'Global body' })
    const subject = { id: 'current-project' }
    const scoped = createScope(ctx, subject)
    const service = scoped.ctx.get('skills')!
    let bodyLoads = 0
    let seenCwd: string | undefined
    let lookupKeys: string[] = []
    service.registerProvider(() => ({
      name: 'preset-probe',
      async list(options) {
        seenCwd = options.cwd
        lookupKeys = Object.keys(options)
        return { complete: false, candidates: [{ ...summary('review', 'Database', { provider: 'preset-probe' }), rank: 10, locator: 'opaque' }] }
      },
      async get() { bodyLoads++; return undefined },
    }))
    const result = await ctx.skills.retrieve({ query: 'Database', limit: 1, maxBytes: 1000, scope: subject, cwd: '/project' })
    expect(result.skills.map(skill => skill.description)).toEqual(['Database'])
    expect(result.complete).toBe(false)
    expect(seenCwd).toBe('/project')
    expect(lookupKeys).not.toContain('query')
    expect(lookupKeys).not.toContain('requestedNames')
    expect(bodyLoads).toBe(0)
    expect(await ctx.skills.retrieve({ query: 'Database', limit: 1, maxBytes: 1000 })).toMatchObject({ skills: [], complete: true })
    await scoped.dispose()
  })

  it('ranks metadata only, caps ordinary candidates, and keeps input objects unchanged', () => {
    const entries = [summary('garden', 'Garden planting'), summary('database-review', 'Database migrations'), summary('sql-check', 'Database query review')]
    const result = selectSkillCatalog(entries, { query: 'review database', limit: 1, maxBytes: 1000 })
    expect(result.skills.map(skill => skill.name)).toEqual(['database-review'])
    expect(result.skills[0]).toBe(entries[1])
    expect(result.omittedCount).toBe(2)
    expect(result.explicitOverflow).toBe(false)
  })

  it('uses whenToUse routing guidance, ignores common words, and omits disabled model skills', () => {
    const entries = [summary('useful', 'Use this for a task'), summary('schema', 'Check structure', { whenToUse: 'database migrations' }), summary('hidden', 'database', { invocation: { modelInvocable: false, userInvocable: true } })]
    expect(selectSkillCatalog(entries, { query: 'Please use this for database migrations', limit: 8, maxBytes: 1000 }).skills.map(skill => skill.name)).toEqual(['schema'])
    expect(selectSkillCatalog(entries, { query: 'Please do a task', limit: 8, maxBytes: 1000 }).skills).toEqual([])
  })

  it('counts rendered escaped UTF-8 metadata bytes and skips entries that exceed the budget', () => {
    const entries = [summary('large', '数据库 & '.repeat(20)), summary('small', '数据库')]
    const result = selectSkillCatalog(entries, { query: '数据库', limit: 8, maxBytes: 50 })
    expect(result.skills.map(skill => skill.name)).toEqual(['small'])
    expect(result.metadataBytes).toBe(new TextEncoder().encode('- `small`: 数据库').length)
    expect(result.metadataBytes).toBeLessThanOrEqual(50)
  })

  it('preserves exact requested names even when ordinary bounds are exceeded', () => {
    const entries = [summary('alpha', 'A very long requested skill'), summary('beta', 'Another requested skill'), summary('hidden', 'Hidden', { invocation: { modelInvocable: false, userInvocable: true } })]
    const result = selectSkillCatalog(entries, { query: 'use alpha and beta', requestedNames: ['hidden'], preserveNamedSkills: true, limit: 1, maxBytes: 1 })
    expect(result.skills.map(skill => skill.name)).toEqual(['alpha', 'beta'])
    expect(result.explicitOverflow).toBe(true)
    expect(selectSkillCatalog(entries, { query: '/alphabet /alpha/path', preserveNamedSkills: true, limit: 1, maxBytes: 1000 }).explicitOverflow).toBe(false)
  })

  it('bounds routing descriptions without changing provider-owned metadata', () => {
    const entry = summary('bounded', '  Relevant\n  '.repeat(100))
    const result = selectSkillCatalog([entry], { query: 'relevant', limit: 1, maxBytes: 100, descriptionMaxLength: 10 })
    expect(result.skills).toEqual([entry])
    expect(result.metadataBytes).toBe(new TextEncoder().encode('- `bounded`: Relevan...').length)
    expect(entry.description).toContain('\n')
  })

  it('validates integer bounds', () => {
    for (const options of [{ limit: 0, maxBytes: 1 }, { limit: 1, maxBytes: 0 }, { limit: 1, maxBytes: 1, descriptionMaxLength: 2 }]) {
      expect(() => selectSkillCatalog([], { query: '', ...options })).toThrow()
    }
  })
})
