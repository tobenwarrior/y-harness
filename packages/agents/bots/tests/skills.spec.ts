import { describe, expect, it, vi } from 'vitest'
import type { SkillCandidate, SkillDefinition, SkillViewOptions } from '@yharness/skill'
import type { ScopeKey } from '@yharness/scope'
import {
  botSkillPolicyAllows,
  createBotSkillPolicyProvider,
  normalizeBotSkillPolicy,
  type BotSkillPolicy,
} from '../src/skills.ts'

describe('Bot skill policy', () => {
  it('defaults to all skills and canonicalizes names without duplicates', () => {
    expect(normalizeBotSkillPolicy()).toEqual({ mode: 'all', enabled: [], disabled: [] })
    expect(normalizeBotSkillPolicy({
      mode: 'selected', enabled: ['release-notes', 'release-notes', 'code-review'], disabled: ['code-review'],
    })).toEqual({
      mode: 'selected', enabled: ['code-review', 'release-notes'], disabled: ['code-review'],
    })
  })

  it('uses selected mode as an allow list while disabled always wins', () => {
    const selected: BotSkillPolicy = { mode: 'selected', enabled: ['code-review'], disabled: [] }
    expect(botSkillPolicyAllows(selected, 'code-review')).toBe(true)
    expect(botSkillPolicyAllows(selected, 'release-notes')).toBe(false)
    expect(botSkillPolicyAllows({ ...selected, disabled: ['code-review'] }, 'code-review')).toBe(false)
    expect(botSkillPolicyAllows({ mode: 'all', enabled: [], disabled: ['release-notes'] }, 'code-review')).toBe(true)
  })

  it('rejects malformed policy names and modes', () => {
    expect(() => normalizeBotSkillPolicy({ mode: 'unknown' as 'all', enabled: [], disabled: [] }))
      .toThrow('Bot skill policy mode')
    expect(() => normalizeBotSkillPolicy({ mode: 'all', enabled: ['not valid'], disabled: [] }))
      .toThrow('Bot skill name')
    expect(() => normalizeBotSkillPolicy({ mode: 'all', enabled: [], disabled: [''] }))
      .toThrow('Bot skill name')
    expect(() => normalizeBotSkillPolicy({ mode: 'all', enabled: ['a'.repeat(129)], disabled: [] }))
      .toThrow('Bot skill name')
  })

  it('projects a policy into a scoped registry without mutating the source catalog or loading denied bodies', async () => {
    const candidates: SkillCandidate[] = [
      {
        name: 'code-review', description: 'Review code', invocation: { modelInvocable: true, userInvocable: true },
        provider: 'bundled', source: 'bundled', rank: 600, locator: 'code-review',
      },
      {
        name: 'release-notes', description: 'Write release notes', invocation: { modelInvocable: true, userInvocable: true },
        provider: 'bundled', source: 'bundled', rank: 600, locator: 'release-notes',
      },
    ]
    const definitions = new Map<string, SkillDefinition>(candidates.map(candidate => [candidate.name, {
      ...candidate, content: `${candidate.name} body.`,
    }]))
    const list = vi.fn(async (options: SkillViewOptions = {}) => {
      expect(options.scope).toBe(parentScope)
      return candidates
    })
    const get = vi.fn(async (name: string, options: SkillViewOptions = {}) => {
      expect(options.scope).toBe(parentScope)
      return definitions.get(name)
    })
    const parentScope: ScopeKey = {}
    const provider = createBotSkillPolicyProvider({ list, get }, parentScope, () => ({
      mode: 'selected', enabled: ['code-review'], disabled: [],
    }))

    const listed = await provider.list({ cwd: '/workspace' })
    const projected = 'candidates' in listed ? listed.candidates : listed
    expect(projected.map(skill => [skill.name, skill.invocation.modelInvocable])).toEqual([
      ['code-review', true], ['release-notes', false],
    ])
    expect(projected[1]).toMatchObject({ provider: 'bot-skill-policy', source: 'runtime', rank: 1_000_000 })
    expect(candidates[1]?.invocation.modelInvocable).toBe(true)

    const hidden = await provider.get(candidates[1]!, { cwd: '/workspace' })
    expect(hidden).toMatchObject({ name: 'release-notes', provider: 'bot-skill-policy', content: '' })
    expect(hidden?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(get).not.toHaveBeenCalled()

    const loaded = await provider.get(candidates[0]!, { cwd: '/workspace' })
    expect(loaded).toMatchObject({ name: 'code-review', content: 'code-review body.' })
    expect(list).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledOnce()
  })

  it('rechecks the current policy after a delayed body load', async () => {
    const candidate: SkillCandidate = {
      name: 'release-notes', description: 'Write release notes',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'bundled', source: 'bundled', rank: 600, locator: 'release-notes',
    }
    let current: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    let releaseBody!: (definition: SkillDefinition) => void
    const body = new Promise<SkillDefinition>((resolve) => { releaseBody = resolve })
    const provider = createBotSkillPolicyProvider({
      list: async () => [candidate],
      get: async () => body,
    }, undefined, () => current)

    const loading = provider.get(candidate, { cwd: '/workspace' })
    current = { mode: 'all', enabled: [], disabled: ['release-notes'] }
    releaseBody({ ...candidate, content: 'The revoked body must not be returned.' })

    await expect(loading).resolves.toMatchObject({
      name: 'release-notes',
      invocation: { modelInvocable: false, userInvocable: false },
      content: '',
    })
  })
})
