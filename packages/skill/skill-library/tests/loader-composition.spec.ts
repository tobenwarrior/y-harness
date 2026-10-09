/** Real Loader composition exposes metadata and persists deliberate adoption without an app or model. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Session from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Library from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose(); context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('skill library real Loader composition', () => {
  it('publishes adoption and a reviewed semantic proposal durably through Loader services', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-library-loader-'))
    const project = join(root, 'project'); const home = join(root, 'home')
    const bundle = join(project, '.dsh', 'skills', 'deploy')
    await mkdir(join(project, '.git'), { recursive: true }); await mkdir(bundle, { recursive: true })
    await writeFile(join(bundle, 'SKILL.md'), '---\nname: deploy\ndescription: Release workflow\n---\n\nRun the documented release checks.\n')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      { name: '@deepseek-ai/dsh-storage' },
      { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
      { name: '@deepseek-ai/dsh-session' },
      { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: '@deepseek-ai/dsh-workspace' },
      { name: '@deepseek-ai/dsh-typert-registry' },
      { name: '@deepseek-ai/dsh-skill-library', config: { dshHome: home, agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 } },
    ]))
    context = new Context(); context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader); context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', Domain],
      ['@deepseek-ai/dsh-session', Session], ['@deepseek-ai/dsh-session-persistence-jsonl', Jsonl], ['@deepseek-ai/dsh-workspace', Workspace],
      ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-skill-library', Library],
    ])
    const internal = context.loader.internal
    if (internal === undefined) throw new Error('fixture requires an internal module loader')
    context.loader.internal = new Proxy(internal, {
      get(target, property, receiver) {
        if (property === 'import') return async (specifier: string) => {
          if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
          return modules.get(specifier)
        }
        const value: unknown = Reflect.get(target, property, receiver)
        return value
      },
    })
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await context.loader.await()
    await context.workspaceRegistry.create(project)
    const item = (await context.skillLibrary.list({})).items.find(item => item.name === 'deploy')!
    expect(item).toMatchObject({ ownership: 'protected', automaticCleanup: false, usage: { coverage: 'unknown', loadCount: 0 } })
    await context.skillLibrary.adopt({ id: item.id, expectedHash: item.contentHash })
    const durable: unknown = JSON.parse(await readFile(join(root, 'storage', 'skill_library.json'), 'utf8'))
    expect(JSON.stringify(durable)).toContain(item.contentHash)
    expect((await context.skillLibrary.detail({ id: item.id })).content).toBe('Run the documented release checks.')
    const unregister = context.skillLibrary.registerLearningGenerator({ id: 'fixture-generator', generate: async input => ({ drafts: [{ kind: 'compress', id: input.sources[0]!.item.id, name: 'deploy', description: 'Release workflow', content: 'Run release checks.' }], uncertainty: ['Review this fixture suggestion.'] }) })
    const evidence = await context.skillLibrary.recordLearningEvidence({ projectId: item.projectIds[0]!, sessionId: 'fixture-session', task: 'Release the project using the documented checks', completed: true, substantial: true, eventRefs: ['fixture-session:1', 'fixture-session:2'], observations: ['Release preparation and check steps were recorded.'], checks: [] })
    const proposal = await context.skillLibrary.proposeLearning({ projectId: item.projectIds[0]!, operation: 'compress', targetIds: [item.id], evidenceIds: [evidence.id] })
    expect(proposal).toMatchObject({ state: 'review', changes: [{ before: 'Run the documented release checks.', after: 'Run release checks.' }] })
    expect(proposal.uncertainty.join(' ')).toContain('unverified')
    await context.skillLibrary.applyProposal({ proposalId: proposal.id, mode: 'reviewed' })
    expect((await context.skillLibrary.detail({ id: item.id })).revisions[0]!.reason).toBe('learning')
    const retained = await readFile(join(root, 'storage', 'skill_learning.json'), 'utf8')
    expect(retained).toContain('Run the documented release checks.'); expect(retained).toContain('fixture-session:2'); expect(retained).toContain('applied')
    unregister(); expect(context.skillLibrary.learningStatus({}).generators).toHaveLength(0)
    const entry = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-skill-library')!
    await entry.fiber!.dispose()
    expect(context.get('skillLibrary')).toBeUndefined()
  })
})
