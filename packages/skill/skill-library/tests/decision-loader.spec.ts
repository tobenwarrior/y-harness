/** Real Loader consumer exercises scoped retrieval against a scripted response-only adapter. */
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
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Session from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Library from '../src/index.ts'

let root: string | undefined; let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose(); ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})
describe('Decision real Loader consumer', () => {
  it('keeps passive browsing deterministic and durably advises only explicit scoped retrieval', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-decision-loader-'))
    const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
    for (const name of ['release-alpha', 'release-beta']) { const bundle = join(project, '.dsh', 'skills', name); await mkdir(bundle, { recursive: true }); await writeFile(join(bundle, 'SKILL.md'), `---\nname: ${name}\ndescription: Release checklist\n---\n\nRun release checks.\n`) }
    let reply = ''; const calls: GenerateOptions[] = []
    class FixtureAdapter extends LlmAdapter {
      override providerInfo(provider: string) { return { id: provider, name: 'Fixture only', auxiliaryGeneration: 'api' as const } }
      override listModels(provider: string) { return Promise.resolve([{ provider, id: 'small', name: 'Small fixture' }]) }
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { calls.push(options); yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
    const api = { name: 'fixture-decision-api', inject: ['llm'], apply(context: Context) { context.llm.registerAdapter(['fixture'], new FixtureAdapter()) } }
    const config = join(root, 'cordis.yml'); await writeFile(config, JSON.stringify([
      { name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-workspace' }, { name: '@deepseek-ai/dsh-typert-registry' },
      { name: '@deepseek-ai/dsh-session' }, { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: '@deepseek-ai/dsh-llm' }, { name: 'fixture-decision-api' }, { name: '@deepseek-ai/dsh-skill-library', config: { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 } },
    ]))
    ctx = new Context(); ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', Domain], ['@deepseek-ai/dsh-workspace', Workspace], ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-session', Session], ['@deepseek-ai/dsh-session-persistence-jsonl', Jsonl], ['@deepseek-ai/dsh-llm', Llm], ['fixture-decision-api', api], ['@deepseek-ai/dsh-skill-library', Library]])
    const internal = ctx.loader.internal; if (internal === undefined) throw new Error('Loader fixture requires its internal importer')
    ctx.loader.internal = new Proxy(internal, {
      get(target, property, receiver): unknown {
        if (property === 'import') return async (specifier: string) => {
          if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
          return modules.get(specifier)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
    await ctx.workspaceRegistry.create(project)
    const inventory = await ctx.skillLibrary.list({}); const projectId = inventory.projects[0]!.id
    expect(calls).toHaveLength(0); expect((await ctx.skillLibrary.decisionStatus()).configuration.enabled).toBe(false)
    const baseline = await ctx.skillLibrary.retrieve({ projectId, query: 'release' }); expect(calls).toHaveLength(0)
    reply = JSON.stringify({ state: 'selected', ids: [baseline[1]!.id] })
    await ctx.skillLibrary.configureDecision({ expectedRevision: 0, enabled: true, route: { provider: 'fixture', model: 'small' } })
    await ctx.skillLibrary.list({}); expect(calls).toHaveLength(0)
    const selected = await ctx.skillLibrary.retrieve({ projectId, query: 'release' })
    expect(selected.map(row => row.id)).toEqual([baseline[1]!.id, baseline[0]!.id]); expect(calls).toHaveLength(1)
    const durable = await readFile(join(root, 'storage', 'skill_decision.json'), 'utf8')
    expect(durable).toContain('selected'); expect(durable).toContain('skill-decision'); expect(durable).toContain(baseline[1]!.id)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'fixture-decision-api')!
    await entry.fiber!.dispose()
    expect(await ctx.skillLibrary.retrieve({ projectId, query: 'release' })).toEqual(baseline)
    expect(calls).toHaveLength(1)
  })
})
