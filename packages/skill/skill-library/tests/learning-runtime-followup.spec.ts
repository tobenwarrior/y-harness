/** Scripted provider and real SessionStore lifecycle; no external process or live model. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import LlmRuntime, { LlmAdapter, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { installSkillLearningRuntime } from '../src/learning-runtime.ts'
import type { SkillLearningRuntimeController, SkillLearningRuntimeOptions } from '../src/learning-runtime.ts'
import type { SkillCodexItemId, SkillCodexSessionId, SkillCodexTurnId, SkillLearningEvidence,
  SkillLearningEvidenceId, SkillLearningGenerator, SkillNativeConnectionId } from '../src/types.ts'

const contexts: Context[] = []
const runtimeDisposers: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    const runtime = await Promise.allSettled(runtimeDisposers.splice(0).map(async (dispose) => { await dispose() }))
    const context = await Promise.allSettled(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
    const failures = [...runtime, ...context].filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Fixture teardown failed.')
  } finally { vi.restoreAllMocks() }
})
const reply = '<skill-learning-json>{"drafts":[{"kind":"create","name":"synthetic-review","description":"Review synthetic steps","content":"Inspect the synthetic report."}],"uncertainty":[]}</skill-learning-json>'
class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  beforeReply = () => {}
  override providerInfo(provider: string) { return { id: provider, name: 'Synthetic boundary', auxiliaryGeneration: 'api' as const } }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options); this.beforeReply()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function workspace(index: number): Workspace {
  return { id: brandString<Workspace['id']>(`p${index}`), path: `/inactive/project-${index}`, title: `Inactive ${index}`,
    createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', sessionIds: [],
    setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok' }
}
async function fixture(options: SkillLearningRuntimeOptions = {}, projectCount = 1) {
  const ctx = new Context(); contexts.push(ctx)
  const sessionFiber = await ctx.plugin(SessionStore); await ctx.plugin(LlmRuntime)
  const registry = new WorkspaceRegistry(ctx)
  vi.spyOn(registry, 'list').mockReturnValue(Array.from({ length: projectCount }, (_, index) => workspace(index)))
  const adapter = new ScriptedAdapter(); ctx.llm.registerAdapter(['synthetic'], adapter)
  const evidence: SkillLearningEvidence[] = []; const generators = new Map<string, SkillLearningGenerator>()
  const availability = new Map<string, { state: string; reason: string }>()
  const generated: Awaited<ReturnType<SkillLearningGenerator['generate']>>[] = []
  const controller: SkillLearningRuntimeController = {
    registerLearningGenerator: (generator) => { generators.set(generator.id, generator); return () => { generators.delete(generator.id) } },
    setLearningAvailability: (id, value) => { availability.set(id, value) },
    recordLearningEvidence: async (observation) => {
      const row = { ...observation, id: brandString<SkillLearningEvidenceId>(`e${evidence.length}`), createdAt: '2026-10-11T00:00:00Z' }
      evidence.push(row); return row
    },
    proposeLearning: async (request) => {
      const generator = generators.get(request.generatorId ?? '')
      if (generator === undefined) throw new Error('fixture generator unavailable')
      generated.push(await generator.generate({ ...request, evidence: evidence.filter(row => request.evidenceIds.includes(row.id)),
        catalog: [], sources: [], bodyBudgetBytes: 2000 }, new AbortController().signal))
    },
  }
  const stopFlush = ctx.on('session/flush', () => {})
  const dispose = installSkillLearningRuntime(ctx, controller, options)
  runtimeDisposers.push(dispose)
  const session = ctx.sessions.create(SessionId('s'), { meta: { cwd: '/inactive/project-0' } })
  return { ctx, sessionFiber, session, adapter, controller, evidence, generators, availability, generated, stopFlush, dispose }
}
function start(session: Session, hidden = false) {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    ...(hidden ? [{ type: 'reasoning' as const, text: 'Private synthetic reasoning is not task text.' }] : []),
    { type: 'text', text: 'Inspect the release procedure.' },
  ] }), { surfaceOp: 'append' })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'synthetic', model: 'model' } } })
}
function tools(session: Session, count = 2) {
  for (let index = 0; index < count; index++) {
    const callId = ToolCallId(`call-${index}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'inspect', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
      content: [{ type: 'text', text: 'Fixture body excluded from evidence.' }] }) }, { surfaceOp: 'append' })
  }
}
function end(session: Session) { session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }) }
function native(session: Session, outcome: 'reported-success' | undefined, index: number) {
  const identity = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>('inactive-profile'),
    sessionId: brandString<SkillCodexSessionId>('inactive-native'), turnId: brandString<SkillCodexTurnId>('inactive-turn'),
    itemId: brandString<SkillCodexItemId>(`native-${index}`), kind: 'read' as const, name: 'read',
    procedure: { kind: 'read' as const, path: `src/fixture-${index}.ts` } }
  session.append('skill/native-item', { ...identity, phase: 'started' }, { ignorable: true })
  session.append('skill/native-item', { ...identity, phase: 'settled', ...(outcome === undefined ? {} : { outcome }) }, { ignorable: true })
}

describe('learning runtime lifecycle followup', () => {
  it('installs and disposes native registration before any workspace owner is present', async () => {
    const ctx = new Context(); contexts.push(ctx); const registrations = new Map<string, SkillLearningGenerator>()
    const availability = vi.fn()
    const controller: SkillLearningRuntimeController = {
      registerLearningGenerator: (generator) => {
        registrations.set(generator.id, generator); return () => { registrations.delete(generator.id) }
      },
      recordLearningEvidence: async () => { throw new Error('No live session') },
      proposeLearning: async () => { throw new Error('No live session') }, setLearningAvailability: availability,
    }
    const dispose = installSkillLearningRuntime(ctx, controller)
    runtimeDisposers.push(dispose)
    expect([...registrations.keys()]).toEqual(['native-observation']); expect(availability).not.toHaveBeenCalled()
    await dispose(); expect(registrations.size).toBe(0)
  })
  it('ignores non-text user blocks when retaining concrete task text', async () => {
    const f = await fixture(); start(f.session, true); tools(f.session); end(f.session); await f.dispose()
    expect(f.evidence).toHaveLength(1); expect(f.evidence[0]?.task).toBe('Inspect the release procedure.')
    expect(JSON.stringify(f.evidence)).not.toContain('Private synthetic reasoning')
  })
  it.each(['request', 'response'] as const)('refuses auxiliary %s after its durable participant disappears', async (phase) => {
    const f = await fixture()
    if (phase === 'request') {
      const record = f.controller.recordLearningEvidence.bind(f.controller)
      vi.spyOn(f.controller, 'recordLearningEvidence').mockImplementation(async (observation) => { const row = await record(observation); f.stopFlush(); return row })
    } else f.adapter.beforeReply = f.stopFlush
    start(f.session); tools(f.session); end(f.session); await f.dispose()
    expect(f.evidence).toHaveLength(1); expect(f.generated).toEqual([])
    expect(f.adapter.calls).toHaveLength(phase === 'request' ? 0 : 1)
    expect(f.availability.get('p0')).toMatchObject({ state: 'unavailable' })
    expect(f.session.snapshotEvents().filter(event => event.type === 'skill/learning-response').at(-1)?.data).toMatchObject({ state: 'unavailable' })
  })
  it('refuses queued task durability when the real session owner unloads', async () => {
    const f = await fixture(); start(f.session); tools(f.session); end(f.session)
    await f.sessionFiber.dispose(); await f.dispose()
    expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
    expect(f.availability.get('p0')).toMatchObject({ state: 'unavailable' })
  })
  it('evicts actual project routes independently of root-session capture keys', async () => {
    const f = await fixture({ maxSessions: 1 }, 3)
    for (let index = 0; index < 3; index++) {
      const session = f.ctx.sessions.create(SessionId(`session-${index}`), { meta: { cwd: `/inactive/project-${index}` } })
      start(session)
    }
    expect(f.generators.has('harness-api')).toBe(true)
    await f.dispose(); expect(f.generators.size).toBe(0)
    expect(f.adapter.calls).toEqual([]); expect(f.evidence).toEqual([])
  })
  it('bounds root tool-call state before retaining an overflow task', async () => {
    const f = await fixture({ maxEventRefs: 2 }); start(f.session); tools(f.session, 3); end(f.session); await f.dispose()
    expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
  })
  it.each(['calls', 'transports'] as const)('bounds nested PTC %s before retaining an overflow task', async (control) => {
    const f = await fixture({ maxEventRefs: 2 }); start(f.session)
    const roots = control === 'transports' ? Array.from({ length: 4 }, (_, index) => ToolCallId(`root-${index}`)) : [ToolCallId('root')]
    for (const rootCallId of roots) {
      f.session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' })
      for (let index = 0; index < (control === 'transports' ? 1 : 4); index++) {
        const subCallId = ToolCallId(`${rootCallId}:ptc:${index + 1}`)
        f.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId,
          name: 'inspect', arguments: {} }, { ignorable: true })
      }
    }
    end(f.session); await f.dispose(); expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
  })
  it('records mixed nested PTC results neutrally without copying output bodies', async () => {
    const f = await fixture(); start(f.session); const rootCallId = ToolCallId('root')
    f.session.append('tool/call', { turn: 1, step: 1, callId: rootCallId, name: 'run_code', arguments: '{}' })
    for (let index = 0; index < 2; index++) {
      const data = { rootCallId, parentCallId: rootCallId, subCallId: ToolCallId(`sub-${index}`), name: 'inspect', arguments: {} }
      f.session.append('tool/ptc-dispatch-start', data, { ignorable: true })
      f.session.append('tool/ptc-dispatch', { ...data, isError: index === 0,
        content: [{ type: 'text', text: 'Synthetic output is not retained.' }] }, { ignorable: true })
    }
    end(f.session); await f.dispose(); expect(f.evidence).toHaveLength(1)
    expect(f.evidence[0]?.observations.join('\n')).toMatch(/reported error: yes/)
    expect(f.evidence[0]?.checks).toEqual([]); expect(JSON.stringify(f.evidence)).not.toContain('Synthetic output is not retained.')
  })
  it('keeps an omitted native outcome unknown alongside a separately reported result', async () => {
    const f = await fixture(); start(f.session); native(f.session, undefined, 0); native(f.session, 'reported-success', 1)
    end(f.session); await f.dispose()
    expect(f.evidence[0]?.native?.actions.map(action => action.outcome)).toEqual(['unknown', 'reported-success'])
    expect(f.evidence[0]?.checks).toEqual([]); expect(f.adapter.calls).toEqual([])
  })
  it('requires every native start to have a paired settlement', async () => {
    const f = await fixture(); start(f.session); native(f.session, 'reported-success', 0); native(f.session, 'reported-success', 1)
    f.session.append('skill/native-item', { provider: 'codex', connectionId: brandString<SkillNativeConnectionId>('inactive-profile'),
      sessionId: brandString<SkillCodexSessionId>('inactive-native'), turnId: brandString<SkillCodexTurnId>('inactive-turn'),
      itemId: brandString<SkillCodexItemId>('unsettled'), kind: 'read', name: 'read', phase: 'started',
      procedure: { kind: 'read', path: 'src/unsettled.ts' } }, { ignorable: true })
    end(f.session); await f.dispose(); expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
  })
  it('reports native automatic-owner failure without falling back to an API model', async () => {
    const f = await fixture(); const autoLearn = vi.fn(async () => { throw new Error('Synthetic policy refusal') })
    f.controller.autoLearnEvidence = autoLearn
    start(f.session); native(f.session, 'reported-success', 0); native(f.session, 'reported-success', 1); end(f.session); await f.dispose()
    expect(autoLearn).toHaveBeenCalledOnce(); expect(f.generated).toEqual([]); expect(f.adapter.calls).toEqual([])
    expect(f.availability.get('p0')?.state).toBe('unavailable')
    expect(f.availability.get('p0')?.reason).toContain('Native observation learning')
  })
  it('accepts reasoning alongside framed text without retaining reasoning as generated instructions', async () => {
    const f = await fixture(); const stream = f.adapter.stream.bind(f.adapter)
    vi.spyOn(f.adapter, 'stream').mockImplementation(async function* (options) {
      yield { type: 'block-start', index: 9, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 9, text: 'Synthetic private reasoning.' }
      yield { type: 'block-end', index: 9, block: { type: 'reasoning', text: 'Synthetic private reasoning.' } }
      yield* stream(options)
    })
    start(f.session); tools(f.session); end(f.session); await f.dispose()
    expect(f.generated).toHaveLength(1)
    expect(f.generated[0]?.drafts[0]?.content).toBe('Inspect the synthetic report.')
    expect(JSON.stringify(f.generated)).not.toContain('Synthetic private reasoning.')
    expect(f.session.snapshotEvents().filter(event => event.type === 'skill/learning-response').at(-1)?.data).toMatchObject({ state: 'drafted' })
  })
})
