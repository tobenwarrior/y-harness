/** Real Loader composition preserves native source identity across durable mirror reads and a leased fixture continuation. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as CodingSessions from '../src/index.ts'
import type { CodingSessionSnapshot } from '../src/types.ts'
let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose(); context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('coding sessions real Loader composition', () => {
  it('publishes readable source-labelled mirrors, refreshes durably and preserves original-ID native continuation under fixture exclusion', async () => {
    root = await mkdtemp(join(tmpdir(), 'y-coding-session-loader-'))
    const source: CodingSessionSnapshot['source'] = { provider: 'codex', profileId: brandString<CodingSessionSnapshot['source']['profileId']>('authorized-fixture-profile'), nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('native-original-id') }
    let history: CodingSessionSnapshot = { source, title: 'Native parser repair', cwd: '/fixture/project', writerState: 'idle', cursor: 'cursor-1', events: [{ id: brandString<CodingSessionSnapshot['events'][number]['id']>('native-user-1'), role: 'user', text: 'Inspect parser', digest: 'digest-1' }] }
    let held = false
    let resumedSource: typeof source | undefined
    const fixture = { name: 'fixture-native-reader', inject: ['codingSessions'], apply(ctx: Context) {
      ctx.effect(() => ctx.codingSessions.registerProvider({ provider: 'codex', profileId: source.profileId, label: 'Fixture Codex profile', connected: () => true,
        discover: async () => ({ items: [history] }), read: async () => structuredClone(history),
        writer: { authority: 'native-enforced-exclusion', acquire: async (selected) => {
          if (held) throw new Error('External writer is active'); held = true
          return { source: selected, read: async () => structuredClone(history), resumeOriginal: async (request) => {
            if (!held) throw new Error('Fixture writer exclusion was lost')
            resumedSource = { ...source, nativeSessionId: request.source.nativeSessionId }
            history = { ...history, cursor: 'cursor-3', events: [...history.events, { id: brandString<CodingSessionSnapshot['events'][number]['id']>('native-assistant-3'), role: 'assistant', text: request.text, digest: 'digest-3' }] }
          }, release: async () => { held = false } }
        } },
      }), 'fixture-native-reader: registration')
    } }
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([{ name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } }, { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-coding-session', config: { enableClaudeDiscovery: false } }, { name: 'fixture-native-reader' }]))
    context = new Context(); context.baseUrl = pathToFileURL(root).href + '/'; await context.plugin(Loader); context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', Domain], ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-coding-session', CodingSessions], ['fixture-native-reader', fixture]])
    const internal = context.loader.internal
    if (internal === undefined) throw new Error('Fixture needs Loader module resolution')
    context.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
      if (property === 'import') return async (specifier: string) => { if (!modules.has(specifier)) throw new Error('Unexpected fixture module'); return modules.get(specifier) }
      return Reflect.get(target, property, receiver)
    } })
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await context.loader.await()
    expect((await context.codingSessions.getState()).sources[0]).toMatchObject({ provider: 'codex', profileId: source.profileId, label: 'Fixture Codex profile' })
    const imported = await context.codingSessions.importSession(source)
    expect((await context.codingSessions.detail(imported.id)).events[0]?.text).toBe('Inspect parser')
    history = { ...history, cursor: 'cursor-2', events: [...history.events, { id: brandString<CodingSessionSnapshot['events'][number]['id']>('native-assistant-2'), role: 'assistant', text: 'Parser repaired', digest: 'digest-2' }] }
    const refreshed = await context.codingSessions.refreshMirror(imported.id)
    expect(refreshed.events.map(value => value.text)).toEqual(['Inspect parser', 'Parser repaired'])
    const continued = await context.codingSessions.continueSession(imported.id, 'Native continuation fixture', refreshed.revision)
    expect(resumedSource).toEqual(source); expect(held).toBe(false)
    expect(continued.events.map(value => value.id)).toEqual(['native-user-1', 'native-assistant-2', 'native-assistant-3'])
    const retained = await readFile(join(root, 'storage', 'coding_sessions.json'), 'utf8')
    expect(retained).toContain('authorized-fixture-profile'); expect(retained).toContain('native-original-id'); expect(retained).toContain('Native continuation fixture')
    const fixtureEntry = [...context.loader.entries()].find(entry => entry.options.name === 'fixture-native-reader')!
    await fixtureEntry.fiber!.dispose(); expect((await context.codingSessions.getState()).sources).toEqual([])
    expect((await context.codingSessions.detail(imported.id)).capabilities.continue).toBe(false)
  })
})
