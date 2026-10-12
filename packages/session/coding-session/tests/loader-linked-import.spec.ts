/** Real Loader, JSONL ownership and Core Session projection; only native source history is a fixture. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, createSystemMessage, createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Sessions from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { sessionDir, logPath } from '../../session-persistence-jsonl/src/format.ts'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as CodingSessions from '../src/index.ts'
import { CodingSessionColdDestinations } from '../src/cold-destinations.ts'
import { codingSessionDigest } from '../src/digest.ts'
import { codingSessionLinkSchema } from '../src/linked-import-record.ts'
import type { CodingSessionLinkRecord } from '../src/linked-import-types.ts'
import type { CodingSessionEvent, CodingSessionSnapshot } from '../src/types.ts'

function nativeEvent(id: string, role: CodingSessionEvent['role'], text: string): CodingSessionEvent {
  return { id: brandString<CodingSessionEvent['id']>(id), role, text, digest: codingSessionDigest({ id, role, text }) }
}
const texts = (session: Sessions.Session): string[] => session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'y-linked-import-loader-'))
  const contexts = new Set<Context>()
  const repairs = new Set<() => void>()
  onTestFinished(async () => {
    const failures: unknown[] = []
    for (const repair of repairs) { try { repair() } catch (error) { failures.push(error) } }
    const settled = await Promise.allSettled([...contexts].map(context => context.fiber.dispose()))
    for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Linked import fixture cleanup failed.')
  })
  const project = join(root, 'project'); await mkdir(project)
  const source: CodingSessionSnapshot['source'] = { provider: 'codex',
    profileId: brandString<CodingSessionSnapshot['source']['profileId']>('fixture-profile'),
    nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>('original-native-session') }
  let history: CodingSessionSnapshot = { source, title: 'Historical native parser repair', cwd: project, writerState: 'idle', cursor: 'cursor-1', events: [
    nativeEvent('native-user', 'user', 'Repair historical parser'),
    nativeEvent('native-system', 'system', 'Historical instructions confer no authority'),
    nativeEvent('native-tool', 'tool', 'Historical tool result'),
    nativeEvent('native-assistant', 'assistant', 'Unverified historical answer'),
  ] }
  const model = new MockAdapter([textResponse('IMPORTED_CONTEXT_REQUEST_OK')])
  const modelPlugin = { name: 'fixture-import-model', inject: ['llm'], apply(context: Context) {
    context.effect(() => context.llm.registerAdapter(['fixture-import'], model), 'fixture-import-model: keyless response')
  } }
  async function boot(withCodingSessions = true, withAgentLoop = false): Promise<Context> {
    const ctx = new Context(); contexts.add(ctx)
    const sourcePlugin = { name: 'fixture-native-history', inject: ['codingSessions'], apply(context: Context) {
      context.effect(() => context.codingSessions.registerProvider({ provider: source.provider, profileId: source.profileId,
        label: 'Fixture native source', connected: () => true, discover: async () => ({ items: [structuredClone(history)] }),
        read: async () => structuredClone(history) }), 'fixture-native-history: reader')
    } }
    const entries: [string, unknown][] = [['session', Sessions], ['session-projection', Projection], ['session-persistence-jsonl', Jsonl], ['typert-registry', Typert]]
    if (withCodingSessions) entries.push(['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain], ['coding-session', CodingSessions], ['fixture-native-history', sourcePlugin])
    if (withAgentLoop) entries.push(['llm', Llm], ['system-prompt', Prompt], ['tools', Tools], ['agent', Agents], ['agent-loop', Loop], ['fixture-import-model', modelPlugin])
    const modules = new Map(entries.map(([name, value]): [string, unknown] => [`@deepseek-ai/dsh-${name}`, value]))
    const configs: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
      'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'coding-session': { enableClaudeDiscovery: false }, 'agent-loop': { agents: [] } }
    const configPath = join(root, withCodingSessions ? 'cordis.yml' : 'persistence-only.yml')
    await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ name, config: configs[name.replace('@deepseek-ai/dsh-', '')] }))))
    ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
    const internal = ctx.loader.internal
    if (internal === undefined) throw new Error('Fixture Loader resolver absent')
    ctx.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
      if (property === 'import') return async (specifier: string) => { if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`); return modules.get(specifier) }
      return Reflect.get(target, property, receiver)
    } })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    return ctx
  }
  async function dispose(ctx: Context): Promise<void> { await ctx.fiber.dispose(); contexts.delete(ctx) }
  async function stored(ctx: Context, id: SessionId) {
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      const read = await handle.read()
      return { events: [...read.events], header: handle.header,
        session: Sessions.Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount,
          read.eventState, ctx.sessions.messageProjections) }
    } finally { await handle.close() }
  }
  async function appendHuman(ctx: Context, id: SessionId, text: string): Promise<readonly SessionEvent[]> {
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      const read = await handle.read()
      const session = Sessions.Session.fromRestore(id, read.events, handle.header, handle.inheritedEventCount,
        read.eventState, ctx.sessions.messageProjections)
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      await handle.append(session.snapshotEvents().slice(read.events.length)); await handle.flush()
      return [...(await handle.read()).events]
    } finally { await handle.close() }
  }
  function failAfterPrepare(ctx: Context, fail: () => void): {
    record: () => CodingSessionLinkRecord | undefined
    restoreWith(repair: () => void): void
  } {
    let prepared: CodingSessionLinkRecord | undefined
    const stop = ctx.on('domain/changed', (change) => {
      if (change.domain !== 'coding_session_links' || change.operation !== 'put') return
      const value = codingSessionLinkSchema.parse(change.value)
      if (value.pending === undefined || prepared !== undefined) return
      prepared = value; stop(); fail()
    })
    return { record: () => prepared, restoreWith: (repair) => { repairs.add(repair) } }
  }
  return { root, project, source, boot, dispose, stored, appendHuman, failAfterPrepare, model,
    native: () => structuredClone(history), appendNative: () => { history = { ...history, cursor: 'cursor-2', events: [...history.events, nativeEvent('native-later', 'assistant', 'Appended native result')] } },
    repair: (repair: () => void) => { repair(); repairs.delete(repair) } }
}

it('creates a durable cold ordinary Y destination that remains empty and exact-project after Loader restart', async () => {
  const f = await fixture(); const first = await f.boot()
  const mirror = await first.codingSessions.importSession(f.source)
  const created = await first.codingSessions.createImportDestination(mirror.id)
  expect(first.get('agents')).toBeUndefined(); expect(first.sessions.get(created.destinationSessionId)).toBeUndefined()
  expect(created.revision).toEqual({ eventCount: 0, digest: codingSessionDigest([]) })
  const before = await f.stored(first, created.destinationSessionId)
  expect(before.events).toEqual([]); expect(before.header).toMatchObject({ cwd: f.project, isSeeded: false })
  await f.dispose(first)
  const restarted = await f.boot()
  expect(await restarted.codingSessions.inspectImportDestination(created.destinationSessionId)).toEqual(created)
  expect((await restarted.sessionPersistence.list()).map(item => item.header.id)).toContain(created.destinationSessionId)
  expect((await restarted.codingSessions.getState()).linkedImportsAvailable).toBe(true)
})

it('persists exact native IDs and role mappings as quoted user context, with no imported executable events', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const linked = await ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })
  const retained = await f.stored(ctx, destination.destinationSessionId)
  const messages = retained.session.deriveMessages()
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ role: 'user', source: { kind: 'coding-session-import', ...f.source,
    mirrorId: mirror.id, linkId: linked.id, generation: 1, disposition: 'active' } })
  const structural = retained.events.filter(event => event.type !== 'session/end-seed' && event.type !== 'user/message')
  expect(structural.map(event => event.type)).toEqual([
    'turn/start', 'step/start', 'system/message', 'coding-session/import-initialization', 'step/end', 'turn/end',
  ])
  const head = structural[2]; const receipt = structural[3]
  if (head?.type !== 'system/message' || receipt?.type !== 'coding-session/import-initialization') {
    throw new Error('Expected a local system head and its exact log-only import initializer receipt')
  }
  expect(head).toMatchObject({ data: { turn: 1, step: 1, message: { role: 'system', content: [] } }, surfaceOp: 'append' })
  expect(receipt.data).toEqual({ source: f.source, mirrorId: mirror.id, linkId: linked.id, systemMessageId: head.data.message.id })
  expect(receipt.ignorable).toBe(true)
  expect(receipt.surfaceOp).toBeUndefined(); expect(receipt.sourceEventSeqs).toBeUndefined()
  expect(structural[5]).toMatchObject({ data: { turn: 1, reason: { kind: 'blocked' } } })
  expect(retained.session.surface.nodes[0]).toBe(head.seq)
  expect(retained.events.some(event => ['request/header', 'request/context', 'assistant/message', 'tool/call', 'skill/learning-proposal'].includes(event.type))).toBe(false)
  expect(texts(retained.session).join('\n')).toMatch(/historical observation/i)
  expect(texts(retained.session).join('\n')).toMatch(/private.*Unknown/i)
  const generation = linked.generations[0]!
  expect(generation.event).toEqual(retained.events[generation.destinationSeq])
  expect(generation.message).toEqual(generation.event.data)
  expect(generation.rawEvents).toEqual(f.native().events)
  expect(generation.mappings.map(item => [item.nativeEventId, item.nativeDigest]))
    .toEqual(f.native().events.map(item => [item.id, item.digest]))
  const text = generation.message.content[0]!
  if (text.type !== 'text') throw new Error('Imported context must be text')
  for (const mapping of generation.mappings) {
    const quoted: unknown = JSON.parse(text.text.slice(mapping.textStart, mapping.textEnd))
    expect(quoted).toMatchObject({ nativeEventId: mapping.nativeEventId, nativeDigest: mapping.nativeDigest })
  }
  const journal = await readFile(join(f.root, 'storage', 'coding_session_links.json'), 'utf8')
  expect(journal).toContain('original-native-session'); expect(journal).toContain(destination.destinationSessionId)
  await f.dispose(ctx); const restarted = await f.boot()
  expect(await restarted.codingSessions.linkedDetail(linked.id)).toEqual(linked)
  const reviewed = await restarted.codingSessions.inspectImportDestination(destination.destinationSessionId)
  const repeated = await restarted.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: reviewed.revision, expectedMirrorRevision: mirror.revision, expectedLinkRevision: linked.revision })
  expect(repeated).toEqual(linked); expect((await f.stored(restarted, destination.destinationSessionId)).events).toEqual(retained.events)
})

it('refuses stale source and destination reviews before adding any linked receipt or imported context', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  f.appendNative(); const refreshed = await ctx.codingSessions.refreshMirror(mirror.id)
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision }))
    .rejects.toThrow(/mirror.*changed|revision/i)
  const human = await f.appendHuman(ctx, destination.destinationSessionId, 'New ordinary Y input')
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: refreshed.revision }))
    .rejects.toThrow(/destination.*changed/i)
  expect((await f.stored(ctx, destination.destinationSessionId)).events).toEqual(human)
  expect((await ctx.codingSessions.getState()).links).toEqual([])
})

it('refuses both a live Y destination and a write owner in an independent real JSONL Loader', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const live = ctx.sessions.create(destination.destinationSessionId, { meta: { cwd: f.project } })
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: live.id,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision }))
    .rejects.toThrow(/live|cold|already exists/i)
  await f.dispose(ctx)
  const restarted = await f.boot(); const other = await f.boot(false)
  const owner = await other.sessionPersistence.open(destination.destinationSessionId, 'write')
  try {
    await expect(restarted.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
      expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision }))
      .rejects.toThrow(/owned|writer|ownership/i)
    expect((await f.stored(restarted, destination.destinationSessionId)).events).toEqual([])
  } finally { await owner.close() }
  const linked = await restarted.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })
  expect(linked.status).toBe('active')
})

it('compensates only imported surface nodes while retaining later Y user events and the complete original raw log', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const linked = await ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })
  const before = await f.appendHuman(ctx, destination.destinationSessionId, 'Keep this later Y message')
  const reviewed = await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)
  const rolled = await ctx.codingSessions.rollbackImport(linked.id, { expectedLinkRevision: linked.revision,
    expectedDestinationRevision: reviewed.revision })
  const after = await f.stored(ctx, destination.destinationSessionId)
  expect(rolled.status).toBe('rolled-back'); expect(after.events.slice(0, before.length)).toEqual(before)
  expect(after.events.at(-1)).toMatchObject({ type: 'user/message', surfaceOp: { op: 'replace', startSeq: linked.generations[0]!.destinationSeq,
    endSeq: linked.generations[0]!.destinationSeq }, sourceEventSeqs: [linked.generations[0]!.destinationSeq] })
  expect(texts(after.session)).toContain('Keep this later Y message'); expect(texts(after.session).join('\n')).not.toContain('Repair historical parser')
  expect(texts(after.session).join('\n')).toMatch(/withdrawn/i)
  await f.dispose(ctx); const restarted = await f.boot()
  expect((await f.stored(restarted, destination.destinationSessionId)).events).toEqual(after.events)
  expect(await restarted.codingSessions.linkedDetail(linked.id)).toEqual(rolled)
})

it('recovers the exact prepared suffix after a real destination medium refusal, then releases the JSONL owner', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const directory = sessionDir(join(f.root, 'sessions'), f.project, destination.destinationSessionId)
  const saved = `${directory}.saved`
  let swapped = false
  const repair = () => { if (!swapped) return; rmSync(directory); renameSync(saved, directory); swapped = false }
  const fault = f.failAfterPrepare(ctx, () => { renameSync(directory, saved); writeFileSync(directory, 'Fixture destination medium refusal'); swapped = true })
  fault.restoreWith(repair)
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })).rejects.toThrow()
  const prepared = fault.record(); expect(prepared?.pending?.kind).toBe('import')
  if (prepared?.pending === undefined) throw new Error('Expected a durable prepared import')
  f.repair(repair)
  expect((await f.stored(ctx, destination.destinationSessionId)).events).toEqual([])
  const exact = prepared.pending.append
  await f.dispose(ctx); const restarted = await f.boot()
  const recovered = await restarted.codingSessions.recoverImport(prepared.id)
  expect(recovered.pending).toBeUndefined(); expect(recovered.status).toBe('active')
  const after = await f.stored(restarted, destination.destinationSessionId)
  expect(after.events).toEqual(exact); expect(texts(after.session).join('\n').match(/Repair historical parser/g)).toHaveLength(1)
  const other = await f.boot(false); const owner = await other.sessionPersistence.open(destination.destinationSessionId, 'write'); await owner.close()
})

it('settles a prepared journal after durable JSONL import and a later user append without duplicating or losing history', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const path = join(f.root, 'storage', 'coding_session_links.json'); const saved = `${path}.saved`
  let swapped = false
  const repair = () => { if (!swapped) return; rmSync(path, { recursive: true }); renameSync(saved, path); swapped = false }
  const fault = f.failAfterPrepare(ctx, () => { renameSync(path, saved); mkdirSync(path); swapped = true })
  fault.restoreWith(repair)
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })).rejects.toThrow()
  const prepared = fault.record(); expect(prepared?.pending?.kind).toBe('import')
  if (prepared?.pending === undefined) throw new Error('Expected a durable prepared import')
  f.repair(repair)
  const durable = await f.stored(ctx, destination.destinationSessionId)
  expect(durable.events).toEqual(prepared.pending.append)
  const before = await f.appendHuman(ctx, destination.destinationSessionId, 'Retain post-interruption Y input')
  await f.dispose(ctx); const restarted = await f.boot()
  const recovered = await restarted.codingSessions.recoverImport(prepared.id)
  expect(recovered.pending).toBeUndefined(); expect((await f.stored(restarted, destination.destinationSessionId)).events).toEqual(before)
  expect(texts((await f.stored(restarted, destination.destinationSessionId)).session)).toContain('Retain post-interruption Y input')
  expect(texts((await f.stored(restarted, destination.destinationSessionId)).session).join('\n').match(/Repair historical parser/g)).toHaveLength(1)
  await f.dispose(restarted); const after = await f.boot(false)
  const owner = await after.sessionPersistence.open(destination.destinationSessionId, 'write'); await owner.close()
})


it('resumes an actually imported cold Y history into a later ordinary mock-model request', async () => {
  const f = await fixture(); const ctx = await f.boot(true, true)
  const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const linked = await ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })
  expect(f.model.requests).toEqual([])
  const retained = await f.stored(ctx, destination.destinationSessionId)
  const imported = retained.session.deriveMessages().find(message => message.source.kind === 'coding-session-import')
  expect(imported).toMatchObject({ role: 'user', source: { kind: 'coding-session-import', ...f.source, mirrorId: mirror.id,
    linkId: linked.id, generation: 1, disposition: 'active' } })
  const owned = await ctx.agents.resume({ resumeSessionId: destination.destinationSessionId,
    agentOptions: { provider: 'fixture-import', model: 'fixture-import' } })
  try {
    owned.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the quoted historical parser context.' }] }))
    await owned.agent.whenIdle()
    expect(f.model.requests).toHaveLength(1)
    const request = f.model.requests[0]!
    const importedMessages = request.messages.filter(message => message.source?.kind === 'coding-session-import')
    expect(importedMessages).toEqual([imported])
    expect(request.messages.filter(message => message.source?.kind === 'user'))
      .toMatchObject([{ content: [{ type: 'text', text: 'Review the quoted historical parser context.' }] }])
    expect(request.messages.filter(message => message.role === 'tool')).toEqual([])
    const quote = importedMessages[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(quote).toContain('historical observations'); expect(quote).toContain('Private native context and unexposed tool details: Unknown')
    for (const event of f.native().events) {
      expect(quote).toContain(JSON.stringify({ nativeEventId: event.id, nativeDigest: event.digest, role: event.role, text: event.text }))
    }
  } finally { await owned.dispose() }
  const after = await f.stored(ctx, destination.destinationSessionId)
  expect(after.events.slice(0, retained.events.length)).toEqual(retained.events)
  expect(after.session.deriveMessages().filter(message => message.role === 'assistant'))
    .toMatchObject([{ content: [{ type: 'text', text: 'IMPORTED_CONTEXT_REQUEST_OK' }] }])
})

it('refuses cold import into an interrupted tool turn without raw or link-journal writes until ordinary resume repairs it', async () => {
  const f = await fixture(); const ctx = await f.boot(true, true)
  const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const handle = await ctx.sessionPersistence.open(destination.destinationSessionId, 'write')
  try {
    const read = await handle.read()
    const session = Sessions.Session.fromRestore(destination.destinationSessionId, read.events, handle.header,
      handle.inheritedEventCount, read.eventState, ctx.sessions.messageProjections)
    const callId = ToolCallId('fixture-interrupted-call')
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture-import', model: 'fixture-import' }, content: [{ type: 'tool-call', id: callId, name: 'fixture_unresolved_tool', arguments: '{}' }],
    }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'fixture_unresolved_tool', arguments: '{}' })
    await handle.append(session.snapshotEvents().slice(read.events.length)); await handle.flush()
  } finally { await handle.close() }
  const path = logPath(join(f.root, 'sessions'), f.project, destination.destinationSessionId, 'none')
  const raw = await readFile(path, 'utf8')
  const before = await f.stored(ctx, destination.destinationSessionId)
  expect(Sessions.interruptedTurnClosers(before.events).map(event => event.type)).toEqual(['tool/result', 'step/end', 'turn/end'])
  const reviewed = await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)
  const links = (await ctx.codingSessions.getState()).links
  const journalWrites: unknown[] = []
  const stop = ctx.on('domain/changed', (change) => { if (change.domain === 'coding_session_links') journalWrites.push(change) })
  try {
    await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
      expectedDestinationRevision: reviewed.revision, expectedMirrorRevision: mirror.revision }))
      .rejects.toThrow(/interrupted|unfinished|resume|repair/i)
  } finally { stop() }
  expect(await readFile(path, 'utf8')).toBe(raw)
  expect((await f.stored(ctx, destination.destinationSessionId)).events).toEqual(before.events)
  expect(await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)).toEqual(reviewed)
  expect((await ctx.codingSessions.getState()).links).toEqual(links)
  expect(journalWrites).toEqual([]); expect(f.model.requests).toEqual([])
  const resumed = await ctx.agents.resume({ resumeSessionId: destination.destinationSessionId,
    agentOptions: { provider: 'fixture-import', model: 'fixture-import' } })
  await resumed.dispose()
  const repaired = await f.stored(ctx, destination.destinationSessionId)
  expect(Sessions.interruptedTurnClosers(repaired.events)).toEqual([])
  expect(repaired.events.slice(0, before.events.length)).toEqual(before.events)
  expect(repaired.events.slice(before.events.length).filter(event => event.type !== 'session/end-seed').map(event => event.type))
    .toEqual(['tool/result', 'step/end', 'turn/end'])
  const fresh = await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)
  expect(fresh.revision).not.toEqual(reviewed.revision)
  const linked = await ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: fresh.revision, expectedMirrorRevision: mirror.revision })
  expect(linked.status).toBe('active')
})


it('refuses a nonempty headless cold destination before raw or link-journal writes', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const before = await f.appendHuman(ctx, destination.destinationSessionId, 'Retain an existing headless historical user')
  const path = logPath(join(f.root, 'sessions'), f.project, destination.destinationSessionId, 'none')
  const bytes = await readFile(path); const reviewed = await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)
  const changes: unknown[] = []
  const stop = ctx.on('domain/changed', (change) => { if (change.domain === 'coding_session_links') changes.push(change) })
  try {
    await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
      expectedDestinationRevision: reviewed.revision, expectedMirrorRevision: mirror.revision }))
      .rejects.toThrow(/system.*head|headless|protected.*head/i)
  } finally { stop() }
  expect(await readFile(path)).toEqual(bytes)
  expect((await f.stored(ctx, destination.destinationSessionId)).events).toEqual(before)
  expect(await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)).toEqual(reviewed)
  expect((await ctx.codingSessions.getState()).links).toEqual([]); expect(changes).toEqual([]); expect(f.model.requests).toEqual([])
})

it.each(['turn/start', 'system/message', 'coding-session/import-initialization'] as const)(
  'recovers only the exact journal-owned partial initializer ending at %s through real JSONL after Loader restart', async (lastType) => {
    const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
    const destination = await ctx.codingSessions.createImportDestination(mirror.id)
    const directory = sessionDir(join(f.root, 'sessions'), f.project, destination.destinationSessionId)
    const saved = `${directory}.saved`; let swapped = false
    const repair = () => { if (!swapped) return; rmSync(directory); renameSync(saved, directory); swapped = false }
    const fault = f.failAfterPrepare(ctx, () => {
      renameSync(directory, saved); writeFileSync(directory, 'Fixture destination medium refusal'); swapped = true
    })
    fault.restoreWith(repair)
    await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
      expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })).rejects.toThrow()
    const prepared = fault.record(); if (prepared?.pending === undefined) throw new Error('Expected the exact durable initializer intent')
    expect(prepared.pending.append.map(event => event.type).filter(type => type !== 'session/end-seed')).toEqual([
      'turn/start', 'step/start', 'system/message', 'coding-session/import-initialization', 'step/end', 'turn/end', 'user/message',
    ])
    const ending = prepared.pending.append.findIndex(event => event.type === lastType)
    expect(ending).toBeGreaterThanOrEqual(0)
    const partial = prepared.pending.append.slice(0, ending + 1)
    f.repair(repair); await f.dispose(ctx)
    const persistence = await f.boot(false)
    const handle = await persistence.sessionPersistence.open(destination.destinationSessionId, 'write')
    try { await handle.append(partial); await handle.flush() } finally { await handle.close() }
    const interrupted = await f.stored(persistence, destination.destinationSessionId)
    expect(interrupted.events).toEqual(partial); expect(Sessions.interruptedTurnClosers(interrupted.events).length).toBeGreaterThan(0)
    await f.dispose(persistence)
    const restarted = await f.boot(); const recovered = await restarted.codingSessions.recoverImport(prepared.id)
    expect(recovered.pending).toBeUndefined(); expect(recovered.status).toBe('active')
    const retained = await f.stored(restarted, destination.destinationSessionId)
    expect(retained.events).toEqual(prepared.pending.append)
    expect(Sessions.interruptedTurnClosers(retained.events)).toEqual([])
    expect(retained.events.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(retained.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(retained.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'blocked' } } })
    expect(retained.session.deriveMessages()).toEqual([recovered.generations[0]!.message]); expect(f.model.requests).toEqual([])
  },
)


it('checks the same complete canonical frame before append and read without persisting an over-budget suffix', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const before = await f.stored(ctx, destination.destinationSessionId)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(500) }] })
  const example = before.session.append('user/message', message, { surfaceOp: 'append' })
  const examplePrefix = before.session.lifecycleMarker === undefined ? [] : [before.session.lifecycleMarker]
  const limit = Buffer.byteLength(JSON.stringify({ header: before.header, events: [...before.events, ...examplePrefix, example] }), 'utf8')
  const canonicalFrame = { header: before.header, inheritedEventCount: before.session.inheritedEventCount,
    events: [...before.events, ...examplePrefix, example] }
  expect(Buffer.byteLength(JSON.stringify(canonicalFrame), 'utf8')).toBeGreaterThan(limit)
  const path = logPath(join(f.root, 'sessions'), f.project, destination.destinationSessionId, 'none')
  const bytes = await readFile(path); const changes: unknown[] = []
  const stop = ctx.on('domain/changed', (change) => { if (change.domain === 'coding_session_links') changes.push(change) })
  const cold = new CodingSessionColdDestinations(ctx, { maxEvents: 100, maxBytes: limit, maxRecords: 10, timeoutMs: 1000 })
  try {
    await expect(cold.withDestination(destination.destinationSessionId, async (value) => {
      const event = value.session.append('user/message', message, { surfaceOp: 'append' })
      const marker = value.session.lifecycleMarker
      await value.appendRecorded(marker === undefined ? [event] : [marker, event])
      await value.flush()
    })).rejects.toThrow(/complete.*UTF-8|byte limit/i)
  } finally { await cold.close(); stop() }
  expect(await readFile(path)).toEqual(bytes)
  expect((await f.stored(ctx, destination.destinationSessionId)).events).toEqual(before.events)
  expect(await ctx.codingSessions.inspectImportDestination(destination.destinationSessionId)).toEqual(destination)
  expect(changes).toEqual([])
})

it('retains a prepared receipt when only its balanced initializer is durable with edited timestamps', async () => {
  const f = await fixture(); const ctx = await f.boot(); const mirror = await ctx.codingSessions.importSession(f.source)
  const destination = await ctx.codingSessions.createImportDestination(mirror.id)
  const directory = sessionDir(join(f.root, 'sessions'), f.project, destination.destinationSessionId)
  const saved = `${directory}.saved`; let swapped = false
  const repair = () => { if (!swapped) return; rmSync(directory); renameSync(saved, directory); swapped = false }
  const fault = f.failAfterPrepare(ctx, () => { renameSync(directory, saved); writeFileSync(directory, 'Fixture destination medium refusal'); swapped = true })
  fault.restoreWith(repair)
  await expect(ctx.codingSessions.importIntoSession(mirror.id, { destinationSessionId: destination.destinationSessionId,
    expectedDestinationRevision: destination.revision, expectedMirrorRevision: mirror.revision })).rejects.toThrow()
  const prepared = fault.record(); if (prepared?.pending === undefined) throw new Error('Expected the exact durable initializer intent')
  const ending = prepared.pending.append.findIndex(event => event.type === 'turn/end')
  expect(ending).toBeGreaterThan(0)
  const edited = prepared.pending.append.slice(0, ending + 1).map(event => ({ ...event, time: event.time + 1 }))
  f.repair(repair); await f.dispose(ctx)
  const persistence = await f.boot(false); const handle = await persistence.sessionPersistence.open(destination.destinationSessionId, 'write')
  try { await handle.append(edited); await handle.flush() } finally { await handle.close() }
  expect(Sessions.interruptedTurnClosers((await f.stored(persistence, destination.destinationSessionId)).events)).toEqual([])
  await f.dispose(persistence); const restarted = await f.boot()
  const reviewed = await restarted.codingSessions.inspectImportDestination(destination.destinationSessionId)
  const path = logPath(join(f.root, 'sessions'), f.project, destination.destinationSessionId, 'none')
  const bytes = await readFile(path); const retained = await restarted.codingSessions.linkedDetail(prepared.id)
  await expect(restarted.codingSessions.abandonImport(prepared.id, { expectedLinkRevision: retained.revision,
    expectedDestinationRevision: reviewed.revision })).rejects.toThrow(/owned|appended|initializer|recover/i)
  expect(await readFile(path)).toEqual(bytes)
  expect(await restarted.codingSessions.linkedDetail(prepared.id)).toEqual(retained)
  expect(await restarted.codingSessions.inspectImportDestination(destination.destinationSessionId)).toEqual(reviewed)
})
