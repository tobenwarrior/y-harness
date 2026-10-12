import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'
import { createRegistryInventory, type RegistryInventoryReader } from '../src/registry-inventory.ts'

const projects = [
  { id: 'one', title: 'One', path: '/work/one' },
  { id: 'two', title: 'Two', path: '/work/two' },
]

function summary(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
  return { name, description: `${name} workflow`, provider: 'packaged', source: 'bundled', invocation: { modelInvocable: true, userInvocable: true }, ...extra }
}

function reader(skills: readonly SkillSummary[], content = 'Selected instructions'): RegistryInventoryReader {
  return {
    list: async () => [...skills],
    get: async (name) => {
      const selected = skills.find(skill => skill.name === name)
      return selected === undefined ? undefined : { ...selected, content }
    },
  }
}

test('includes pathless packaged summaries without loading their instruction bodies', async () => {
  let loaded = false
  const skills = [summary('office'), summary('badge', { invocation: { modelInvocable: false, userInvocable: true } })]
  const global: RegistryInventoryReader = { list: async () => skills, get: async () => { loaded = true; return undefined } }
  const inventory = createRegistryInventory({ global: () => global, views: () => [] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 2)
  assert.deepEqual(result.entries.map(entry => [entry.name, entry.provider, entry.native]), [['office', 'packaged', false], ['badge', 'packaged', false]])
  assert.match(result.entries[0]!.path, /^skill:\/\/registry\//)
  assert.equal(result.entries[1]!.enabled, true)
  assert.equal(result.entries[1]!.modelInvocable, false)
  assert.equal(result.entries[1]!.userInvocable, true)
  assert.equal(loaded, false)
})

test('merges actual provider and file identity across project observations', async () => {
  const skill = summary('review', { provider: 'filesystem', source: 'project-agents', path: '/work/repo/.agents/skills/review/SKILL.md' })
  const global = reader([skill])
  const inventory = createRegistryInventory({ global: () => global, views: () => [{ key: 'live', cwd: '/work/one/nested', registry: global }] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]!.path, '/work/repo/.agents/skills/review/SKILL.md')
  assert.deepEqual(result.entries[0]!.projectIds, ['one', 'two'])
})

test('keeps same-name runtime skills in separate live scopes and loads the selected body lazily', async () => {
  const skill = summary('session-rule', { provider: 'runtime', source: 'runtime' })
  const inventory = createRegistryInventory({ global: () => undefined, views: () => [
    { key: 'session-one', cwd: '/work/one', registry: reader([skill], 'First instructions') },
    { key: 'session-two', cwd: '/work/two', registry: reader([skill], 'Second instructions') },
  ] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 2)
  assert.notEqual(result.entries[0]!.path, result.entries[1]!.path)
  assert.deepEqual(result.entries.map(entry => entry.projectIds), [['one'], ['two']])
  assert.equal(await inventory.detail(result.entries[0]!.path), 'First instructions')
  assert.equal(await inventory.detail(result.entries[1]!.path), 'Second instructions')
})

test('uses the original view when selected provider instructions are loaded', async () => {
  const scope = {}
  const skill = summary('custom', { provider: 'custom-filesystem', source: 'custom', path: '/custom/custom/SKILL.md' })
  const scoped: RegistryInventoryReader = {
    list: async options => options?.scope === scope && options?.cwd === '/work/one/nested' ? [skill] : [],
    get: async (name, options): Promise<SkillDefinition | undefined> => options?.scope === scope && options?.cwd === '/work/one/nested' && name === 'custom' ? { ...skill, content: 'Scoped custom procedure' } : undefined,
  }
  const inventory = createRegistryInventory({ global: () => undefined, views: () => [{ key: 'live', scope, cwd: '/work/one/nested', registry: scoped }] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 1)
  assert.equal(await inventory.detail('/custom/custom/SKILL.md'), 'Scoped custom procedure')
})

test('retains available summaries and reports an unavailable view without claiming inactive preset coverage', async () => {
  const broken: RegistryInventoryReader = { list: async () => { throw new Error('unavailable registry') }, get: async () => undefined }
  const inventory = createRegistryInventory({ global: () => reader([summary('badge')]), views: () => [{ key: 'broken', cwd: '/work/one', registry: broken }] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 1)
  assert.ok(result.statuses.some(status => status.state === 'unavailable'))
  assert.ok(result.statuses.some(status => /inactive/i.test(status.message ?? '') && /not/.test(status.message ?? '')))
  await assert.rejects(inventory.detail('missing'), /unknown registry skill/)
})

test('disambiguates different providers that describe the same instruction file', async () => {
  const first = summary('review', { provider: 'first', path: '/shared/SKILL.md' })
  const second = summary('review', { provider: 'second', path: '/shared/SKILL.md' })
  const inventory = createRegistryInventory({ global: () => reader([first], 'First provider'), views: () => [{ key: 'live', registry: reader([second], 'Second provider') }] })
  const result = await inventory.list([])
  assert.equal(result.entries.length, 2)
  await assert.rejects(inventory.detail('/shared/SKILL.md'), /ambiguous registry skill/)
  assert.equal(await inventory.detail('/shared/SKILL.md', 'first'), 'First provider')
  assert.equal(await inventory.detail('/shared/SKILL.md', 'second'), 'Second provider')
})

test('shows a shared pathless packaged skill once across global and live views', async () => {
  const skill = summary('office-docx', { provider: 'dsh-office', resourceBase: { kind: 'directory', path: '/bundled/office-docx' } })
  const packaged = reader([skill])
  const inventory = createRegistryInventory({ global: () => packaged, views: () => [
    { key: 'session-one', cwd: '/work/one', registry: packaged },
    { key: 'session-two', cwd: '/work/two', registry: packaged },
  ] })
  const result = await inventory.list(projects)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0]!.name, 'office-docx')
  assert.equal(await inventory.detail(result.entries[0]!.path, 'dsh-office'), 'Selected instructions')
})

test('keeps separately packaged resource roots distinct even when their names match', async () => {
  const first = summary('office-docx', { provider: 'dsh-office', resourceBase: { kind: 'directory', path: '/bundled/one/office-docx' } })
  const second = summary('office-docx', { provider: 'dsh-office', resourceBase: { kind: 'directory', path: '/bundled/two/office-docx' } })
  const inventory = createRegistryInventory({ global: () => reader([first], 'First package'), views: () => [{ key: 'second-preset', registry: reader([second], 'Second package') }] })
  const result = await inventory.list([])
  assert.equal(result.entries.length, 2)
  assert.equal(await inventory.detail(result.entries[0]!.path), 'First package')
  assert.equal(await inventory.detail(result.entries[1]!.path), 'Second package')
})
