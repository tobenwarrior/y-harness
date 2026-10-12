/** Live Session facts and a scripted API boundary; no process or real model calls. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ServiceTierId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillNativeConnectionId, SkillCodexSessionId, SkillCodexTurnId, SkillCodexItemId, SkillLearningEvidence, SkillLearningEvidenceId, SkillLearningGenerateInput, SkillLearningGenerator, SkillLearningProposeRequest, SkillLearningSource } from '../src/learning-types.ts'
import type { SkillLibraryId, SkillLibraryItem } from '../src/types.ts'
import { installSkillLearningRuntime } from '../src/learning-runtime.ts'
import type { SkillLearningRuntimeController, SkillLearningRuntimeOptions } from '../src/learning-runtime.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const validReply = '<skill-learning-json>{"drafts":[{"kind":"create","name":"verify-release","description":"Prepare a release check","content":"Run the documented checks and review their results."}],"uncertainty":[]}</skill-learning-json>'

class ScriptedAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  defaultEffort?: GenerateOptions['reasoningEffort']
  defaultTier?: GenerateOptions['serviceTier']
  constructor(private readonly mode: 'api' | 'native' | 'unknown', readonly reply = validReply) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'Scripted', ...(this.mode === 'unknown' ? {} : { auxiliaryGeneration: this.mode }) } }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: ['ultra', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })), ...(this.defaultEffort === undefined ? {} : { defaultEffort: this.defaultEffort }) },
      serviceTiers: { tiers: ['default', 'priority'].map(id => ({ id: ServiceTierId(id), name: id })), ...(this.defaultTier === undefined ? {} : { defaultTier: this.defaultTier }) },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(options: SkillLearningRuntimeOptions = {}, mode: 'api' | 'native' | 'unknown' = 'api', reply = validReply) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SessionStore); await ctx.plugin(LlmRuntime)
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'p', path: '/test/project', title: 'Project' }] } as never)
  const adapter = new ScriptedAdapter(mode, reply)
  const registration = ctx.llm.registerAdapter(['scripted'], adapter)
  const evidence: SkillLearningEvidence[] = []; const proposals: SkillLearningProposeRequest[] = []
  const generated: Awaited<ReturnType<SkillLearningGenerator['generate']>>[] = []
  const generators = new Map<string, SkillLearningGenerator>(); const availability = new Map<string, { state: string; reason: string }>()
  const order: string[] = []
  const sources: SkillLearningSource[] = []
  const controller: SkillLearningRuntimeController = {
    registerLearningGenerator: (generator) => { generators.set(generator.id, generator); return () => { generators.delete(generator.id) } },
    setLearningAvailability: (id, value) => { availability.set(id, value) },
    recordLearningEvidence: async (observation) => {
      order.push('evidence')
      const row: SkillLearningEvidence = { ...observation, id: brandString<SkillLearningEvidenceId>(`e${evidence.length}`), createdAt: '2026-10-09T00:00:00Z' }
      evidence.push(row); return row
    },
    proposeLearning: async (request) => {
      proposals.push(request)
      const input: SkillLearningGenerateInput = {
        ...request,
        evidence: evidence.filter(row => request.evidenceIds.includes(row.id)),
        catalog: sources.map(source => source.item), sources, bodyBudgetBytes: 2000,
      }
      const generator = request.generatorId === undefined ? [...generators.values()][0]! : generators.get(request.generatorId)!
      generated.push(await generator.generate(input, new AbortController().signal)); order.push('proposal')
    },
  }
  const flush = vi.fn(() => { order.push('flush') }); const stopFlush = ctx.on('session/flush', flush)
  const dispose = installSkillLearningRuntime(ctx, controller, options)
  const session = ctx.sessions.create(SessionId('s'), { meta: { cwd: '/test/project' } })
  return {
    ctx, session, adapter, registration, evidence, proposals, generated, availability,
    generators, sources, flush, stopFlush, order, dispose,
  }
}

function turn(session: Session, reason: TurnEndReason = { kind: 'completed' }, count = 2, human = true, errors = false, claim = '', controls: Pick<GenerateOptions, 'reasoningEffort' | 'serviceTier'> = { reasoningEffort: ReasoningEffortId('ultra'), serviceTier: ServiceTierId('default') }) {
  session.append('turn/start', { turn: 1 })
  if (human) session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare a release and inspect its checks.' }] }), { surfaceOp: 'append' })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model', ...controls } } })
  for (let n = 0; n < count; n++) {
    const callId = ToolCallId(`c${n}`)
    session.append('tool/call', { turn: 1, step: 1, name: 'exec', callId, arguments: '{"secret":"must not persist"}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: errors, content: [{ type: 'text', text: 'All tests passed. Authorization: Bearer private-tool-secret' }] }) }, { surfaceOp: 'append' })
  }
  if (claim !== '') session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'scripted', model: 'model' }, content: [{ type: 'text', text: claim }] }), stream: [] }, { surfaceOp: 'append' })
  return session.append('turn/end', { turn: 1, reason })
}

describe('proposal-only skill learning runtime', () => {
  it.each(['paired', 'mismatched', 'conflicting', 'wrong-kind'] as const)(
    'handles additive native patch metadata conservatively (%s)', async (control) => {
      const f = await fixture({}, 'native')
      f.session.append('turn/start', { turn: 1 })
      f.session.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'Inspect the current project changes.' }] }), { surfaceOp: 'append' })
      f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model' } } })
      for (const [index, path] of ['src/a.ts', 'src/b.ts'].entries()) {
        const patchProcedure = { kind: 'patch' as const, changes: [{ operation: 'update' as const, path }] }
        const identity = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>('profile'),
          sessionId: brandString<SkillCodexSessionId>('native-thread'), turnId: brandString<SkillCodexTurnId>('native-turn'),
          itemId: brandString<SkillCodexItemId>(`patch-${index}`), name: 'native-file-change', patchProcedure,
          kind: control === 'wrong-kind' ? 'read' as const : 'file-change' as const,
          ...control === 'conflicting' ? { procedure: { kind: 'read' as const, path } } : {} }
        f.session.append('skill/native-item', { ...identity, phase: 'started' }, { ignorable: true })
        f.session.append('skill/native-item', { ...identity, phase: 'settled', outcome: 'reported-success',
          ...control === 'mismatched'
            ? { patchProcedure: { kind: 'patch', changes: [{ operation: 'update', path: 'src/other.ts' }] } } : {},
        }, { ignorable: true })
      }
      f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await f.dispose()
      expect(f.adapter.calls).toEqual([])
      if (control !== 'paired') {
        expect(f.evidence).toEqual([]); expect(f.proposals).toEqual([])
        return
      }
      expect(f.evidence).toHaveLength(1)
      expect(f.evidence[0]?.native?.actions.map(action => action.procedure)).toEqual([
        { kind: 'patch', changes: [{ operation: 'update', path: 'src/a.ts' }] },
        { kind: 'patch', changes: [{ operation: 'update', path: 'src/b.ts' }] },
      ])
      expect(f.evidence[0]?.checks).toEqual([])
      expect(f.generated[0]?.drafts[0]?.content).toContain('update `src/a.ts`')
      expect(f.order.indexOf('flush')).toBeLessThan(f.order.indexOf('evidence'))
    },
  )
  it('records paired native item identities after durability and uses bounded observation generation', async () => {
    const f = await fixture({}, 'native')
    f.session.append('turn/start', { turn: 1 })
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the code and run its checks.' }] }), { surfaceOp: 'append' })
    f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model' } } })
    for (const [id, kind] of [['read', 'read'], ['check', 'command']] as const) {
      const procedure = kind === 'read' ? { kind: 'read' as const, path: 'src/source.ts' } : { kind: 'check' as const, command: 'pnpm run test' }
      const identity = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>('profile-a'), sessionId: brandString<SkillCodexSessionId>('native-thread'), turnId: brandString<SkillCodexTurnId>('native-turn'), itemId: brandString<SkillCodexItemId>(id), kind, name: kind, procedure }
      f.session.append('skill/native-item', { ...identity, phase: 'started' }, { ignorable: true })
      f.session.append('skill/native-item', { ...identity, phase: 'settled', outcome: 'reported-success' }, { ignorable: true })
    }
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await f.dispose()
    expect(f.evidence).toHaveLength(1)
    expect(f.evidence[0]?.native).toMatchObject({ provider: 'codex', connectionId: brandString<SkillNativeConnectionId>('profile-a'), sessionId: brandString<SkillCodexSessionId>('native-thread'), turnId: brandString<SkillCodexTurnId>('native-turn'), actions: [{ itemId: brandString<SkillCodexItemId>('read'), kind: 'read' }, { itemId: 'check', kind: 'command' }] })
    expect(f.evidence[0]?.checks).toEqual([])
    expect(f.generated).toHaveLength(1)
    expect(f.generated[0]?.drafts[0]?.content).toContain('1. Read `src/source.ts`')
    expect(f.generated[0]?.drafts[0]?.content).toContain('2. Run `pnpm run test`')
    expect(f.adapter.calls).toEqual([])
    expect(f.order.indexOf('flush')).toBeLessThan(f.order.indexOf('evidence'))
  })
  it.each(['unknown-procedure', 'mismatch', 'interrupted', 'orphan', 'overflow', 'silent'] as const)('keeps native %s controls conservative', async (control) => {
    const f = await fixture({}, 'native')
    f.session.append('turn/start', { turn: 1 })
    f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the code and run checks.' }] }), { surfaceOp: 'append' })
    f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model' } } })
    for (const itemId of control === 'silent' ? [] : ['one', 'two']) {
      const identity = { provider: 'codex' as const, connectionId: brandString<SkillNativeConnectionId>('profile'), sessionId: brandString<SkillCodexSessionId>('native-thread'), turnId: brandString<SkillCodexTurnId>('native-turn'), itemId: brandString<SkillCodexItemId>(itemId), kind: 'command' as const, name: 'native-command',
        ...control === 'unknown-procedure' ? {} : { procedure: { kind: 'check' as const, command: 'pnpm run test' } } }
      if (control !== 'orphan') f.session.append('skill/native-item', { ...identity, phase: 'started' }, { ignorable: true })
      f.session.append('skill/native-item', { ...identity, phase: 'settled', outcome: 'reported-success',
        ...control === 'mismatch' ? { procedure: { kind: 'check', command: 'pnpm run lint' } } : {} }, { ignorable: true })
      // A duplicate settlement cannot create another action or procedure.
      f.session.append('skill/native-item', { ...identity, phase: 'settled', outcome: 'reported-success' }, { ignorable: true })
      if (control === 'overflow') f.session.append('skill/native-item', { ...identity, phase: 'invalidated' }, { ignorable: true })
    }
    f.session.append('turn/end', { turn: 1, reason: control === 'interrupted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: 'completed' } })
    await f.dispose()
    expect(f.generated).toEqual([]); expect(f.adapter.calls).toEqual([])
    expect(f.evidence).toHaveLength(control === 'unknown-procedure' ? 1 : 0)
    if (control === 'unknown-procedure') expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
  })
  it('flushes a substantial human task before evidence and one uncertain proposal, then drains registration', async () => {
    const f = await fixture(); const end = turn(f.session)
    f.ctx.emit('session/event', f.session, end)
    await f.dispose()
    expect(f.order).toEqual(['flush', 'evidence', 'flush', 'flush', 'proposal'])
    expect(f.evidence).toHaveLength(1); expect(f.proposals).toHaveLength(1)
    expect(f.evidence[0]).toMatchObject({ sessionId: 's', projectId: 'p', completed: true, substantial: true, checks: [] })
    expect(f.evidence[0]!.eventRefs).toContain(`s:${end.seq}`)
    expect(JSON.stringify(f.evidence)).not.toMatch(/private-tool-secret|must not persist|All tests passed/)
    expect(f.generated[0]!.uncertainty.join(' ')).toMatch(/review|unverified/i)
    expect(f.adapter.calls[0]).toMatchObject({ provider: 'scripted', model: 'model', purpose: 'skill-learning', tools: [], maxTokens: 1500 })
    expect(f.adapter.calls[0]).toMatchObject({ reasoningEffort: 'ultra', serviceTier: 'default' })
    expect(f.session.requestHeader()!.config).toMatchObject({ reasoningEffort: 'ultra', serviceTier: 'default' })
    expect(f.generators.size).toBe(0)
    const trace = f.session.snapshotEvents().filter(event => event.type === 'skill/learning-request' || event.type === 'skill/learning-response')
    expect(trace).toHaveLength(2); expect(trace.every(event => event.ignorable === true)).toBe(true)
    expect(f.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('untrustedSource')))).toBe(false)
  })

  it.each([
    [{ kind: 'completed' }, 1, true], [{ kind: 'completed' }, 2, false],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 2, true], [{ kind: 'error', error: { message: 'failure', code: 'X' } }, 2, true],
  ] as const)('skips trivial, injected, aborted and failed work (%j)', async (reason, count, human) => {
    const f = await fixture(); turn(f.session, reason, count, human); await f.dispose()
    expect(f.evidence).toEqual([]); expect(f.proposals).toEqual([]); expect(f.adapter.calls).toEqual([])
  })

  it('skips seed replay, fork children and subagent sessions', async () => {
    const f = await fixture()
    const seedSource = ctxDetachedTask()
    const replay = f.ctx.sessions.create(SessionId('replay'), { seed: seedSource.snapshotEvents(), meta: { cwd: '/test/project' } })
    for (const event of seedSource.snapshotEvents()) f.ctx.emit('session/event', replay, event)
    const child = f.ctx.sessions.create(SessionId('fork'), { seed: [], inheritedEventCount: SessionLogOffset(0), meta: { cwd: '/test/project', parentSession: f.session.id, isSeeded: true } }); turn(child)
    const subagent = f.ctx.sessions.create(SessionId('sub'), { meta: { cwd: '/test/project', origin: 'subagent' } }); turn(subagent)
    await f.dispose(); expect(f.evidence).toEqual([])
  })

  it('requires an actual paired result and a successful durability participant', async () => {
    const f = await fixture(); f.ctx.on('session/flush', () => { throw new Error('storage unavailable') }); turn(f.session); await f.dispose()
    expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
    const missing = await fixture(); missing.stopFlush(); turn(missing.session); await missing.dispose()
    expect(missing.evidence).toEqual([])
    const absent = await fixture(); absent.session.append('turn/start', { turn: 1 }); absent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Do substantial work.' }] }), { surfaceOp: 'append' }); for (let n = 0; n < 2; n++) absent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`a${n}`), name: 'exec', arguments: '{}' }); absent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await absent.dispose(); expect(absent.evidence).toEqual([])
    const failed = await fixture(); turn(failed.session, { kind: 'completed' }, 2, true, true); await failed.dispose(); expect(failed.evidence).toEqual([])
  })

  it.each(['native', 'unknown'] as const)('reports unavailable route without any auxiliary dispatch (%s)', async (mode) => {
    const f = await fixture({}, mode); turn(f.session); await f.dispose()
    expect(f.evidence).toHaveLength(1); expect(f.proposals).toEqual([]); expect(f.adapter.calls).toEqual([])
    expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
  })

  it.each([
    validReply.replace('"content":', '"trusted":true,"content":'), validReply.replace('"content":', '"path":"/etc/unsafe","content":'),
    validReply.replace('"uncertainty":[]', '"uncertainty":[],"checks":[{"result":"passed"}]'),
    'unframed output ' + validReply, validReply.replace('verify-release', '../escape'),
  ])('rejects hostile or unframed model fields', async (reply) => {
    const f = await fixture({}, 'api', reply); turn(f.session); await f.dispose()
    expect(f.evidence).toHaveLength(1); expect(f.generated).toEqual([])
    expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
  })

  it('bounds retained event state and output, and redacts credential-shaped task lines', async () => {
    const bounded = await fixture({ maxEventRefs: 4 }); turn(bounded.session); await bounded.dispose()
    expect(bounded.evidence).toEqual([])
    const output = await fixture({ maxOutputBytes: 100 }); turn(output.session); await output.dispose()
    expect(output.generated).toEqual([])
    const f = await fixture(); f.session.append('turn/start', { turn: 1 }); f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'api_key=private-user-secret\nPrepare a release.' }] }), { surfaceOp: 'append' }); f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model' } } }); for (let n = 0; n < 2; n++) { const callId = ToolCallId(`redact${n}`); f.session.append('tool/call', { turn: 1, step: 1, name: 'exec', callId, arguments: '{}' }); f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [] }) }, { surfaceOp: 'append' }) }; f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await f.dispose(); expect(JSON.stringify(f.evidence)).not.toContain('private-user-secret'); expect(JSON.stringify(f.adapter.calls)).not.toContain('private-user-secret')
  })

  it('retains a bounded assistant procedure only as an unverified claim with its exact event reference', async () => {
    const f = await fixture(); const end = turn(f.session, { kind: 'completed' }, 2, true, false, 'I staged the release, reviewed its diff and ran its checks. Tests passed.'); await f.dispose()
    expect(f.evidence[0]!.observations.join(' ')).toContain('Assistant completion claim (unverified): I staged')
    expect(f.evidence[0]!.eventRefs).toContain(`s:${end.seq - 1}`)
    expect(f.evidence[0]!.checks).toEqual([])
  })

  it('keeps queued completion generation on its captured route when the project switches to native', async () => {
    const f = await fixture(); const native = new ScriptedAdapter('native'); f.ctx.llm.registerAdapter(['native-alias'], native)
    turn(f.session)
    f.session.append('request/header', { reason: 'change', header: { config: { provider: 'native-alias', model: 'native' } } })
    await f.dispose()
    expect(f.adapter.calls).toHaveLength(1); expect(native.calls).toEqual([])
    expect(f.adapter.calls[0]!.provider).toBe('scripted')
  })

  it('binds response-only dispatch before logging even when its route becomes native during durability', async () => {
    const f = await fixture(); const native = new ScriptedAdapter('native')
    let replaced = false
    f.ctx.on('session/flush', () => {
      if (!replaced && f.session.snapshotEvents().some(event => event.type === 'skill/learning-request')) {
        replaced = true; f.registration(); f.ctx.llm.registerAdapter(['scripted'], native)
      }
    })
    turn(f.session); await f.dispose()
    expect(replaced).toBe(true)
    expect(native.calls).toEqual([]); expect(f.adapter.calls).toHaveLength(1)
    expect(f.adapter.calls[0]).toMatchObject({ reasoningEffort: 'ultra', serviceTier: 'default' })
    expect(f.generated).toHaveLength(1)
    const request = f.session.snapshotEvents().find(event => event.type === 'skill/learning-request')
    expect(request?.data).toMatchObject({ route: { provider: 'scripted', model: 'model', reasoningEffort: 'ultra', serviceTier: 'default' } })
  })

  it.each(['reasoningEffort', 'serviceTier'] as const)('rejects a newly configured %s default when the captured request omitted it', async (control) => {
    const f = await fixture()
    f.ctx.on('session/flush', () => {
      if (control === 'reasoningEffort') f.adapter.defaultEffort = ReasoningEffortId('high')
      else f.adapter.defaultTier = ServiceTierId('priority')
    })
    turn(f.session, { kind: 'completed' }, 2, true, false, '', {}); await f.dispose()
    expect(f.adapter.calls).toEqual([]); expect(f.generated).toEqual([])
    expect(f.evidence).toHaveLength(1)
    expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
  })

  it('keeps an evidence task route when a later live task changes effort and processing tier', async () => {
    const f = await fixture(); turn(f.session)
    await vi.waitFor(() => { expect(f.generated).toHaveLength(1) })
    f.session.append('request/header', { reason: 'change', header: { config: { provider: 'scripted', model: 'model', reasoningEffort: ReasoningEffortId('high'), serviceTier: ServiceTierId('priority') } } })
    const generator = f.generators.get('harness-api')!
    await generator.generate({ projectId: 'p', operation: 'learn', evidence: [f.evidence[0]!], catalog: [], sources: [], bodyBudgetBytes: 2000 }, new AbortController().signal)
    await f.dispose()
    expect(f.adapter.calls).toHaveLength(2)
    expect(f.adapter.calls[1]).toMatchObject({ provider: 'scripted', model: 'model', reasoningEffort: 'ultra', serviceTier: 'default' })
  })

  it('rejects unknown evidence without borrowing the latest project route', async () => {
    const f = await fixture(); turn(f.session)
    await vi.waitFor(() => { expect(f.generated).toHaveLength(1) })
    const generator = f.generators.get('harness-api')!
    const unknown = { ...f.evidence[0]!, id: brandString<SkillLearningEvidenceId>('unknown') }
    await expect(generator.generate({ projectId: 'p', operation: 'learn', evidence: [unknown], catalog: [], sources: [], bodyBudgetBytes: 2000 }, new AbortController().signal)).rejects.toThrow()
    await f.dispose(); expect(f.adapter.calls).toHaveLength(1)
    expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
  })

  it('rejects combined evidence with conflicting captured resource controls', async () => {
    const f = await fixture(); turn(f.session)
    await vi.waitFor(() => { expect(f.generated).toHaveLength(1) })
    turn(f.session, { kind: 'completed' }, 2, true, false, '', { reasoningEffort: ReasoningEffortId('high'), serviceTier: ServiceTierId('priority') })
    await vi.waitFor(() => { expect(f.generated).toHaveLength(2) })
    const generator = f.generators.get('harness-api')!
    await expect(generator.generate({ projectId: 'p', operation: 'learn', evidence: f.evidence, catalog: [], sources: [], bodyBudgetBytes: 2000 }, new AbortController().signal)).rejects.toThrow()
    await f.dispose(); expect(f.adapter.calls).toHaveLength(2)
  })

  it('preserves complete selected instructions and constraints, and refuses oversized or sensitive sources before dispatch', async () => {
    const f = await fixture(); const source = sourceFixture('Retain the complete deploy procedure.\n\n[Checklist](reference.txt)', 'You MUST request approval before deploying. ' + 'preserve '.repeat(100)); f.sources.push(source); turn(f.session); await f.dispose()
    const prompt = f.adapter.calls[0]!.messages[0]!.content.find(block => block.type === 'text')
    if (prompt?.type !== 'text') throw new Error('expected framed learning request')
    const framed: unknown = JSON.parse(prompt.text)
    expect(framed).toMatchObject({ untrustedSource: { sources: [{
      instructions: source.content, constraints: source.constraints, references: source.references, resources: source.resources,
    }] } })
    const oversized = await fixture({ maxInputBytes: 2000 }); oversized.sources.push(sourceFixture('complete '.repeat(300))); turn(oversized.session); await oversized.dispose(); expect(oversized.adapter.calls).toEqual([]); expect(oversized.generated).toEqual([])
    const sensitive = await fixture(); sensitive.sources.push(sourceFixture('api_key=source-secret\nPreserve this body exactly.')); turn(sensitive.session); await sensitive.dispose(); expect(sensitive.adapter.calls).toEqual([]); expect(JSON.stringify(sensitive.session.snapshotEvents())).not.toContain('source-secret')
  })

  it('refuses dispatch if the exact auxiliary request cannot reach durable storage', async () => {
    const f = await fixture(); f.ctx.on('session/flush', () => { if (f.session.seq > 8) throw new Error('request durability failed') }); turn(f.session); await f.dispose()
    expect(f.evidence).toHaveLength(1); expect(f.adapter.calls).toEqual([]); expect(f.generated).toEqual([])
  })

  it('times out an API stream that ignores cancellation and drains without a proposal', async () => {
    const release = Promise.withResolvers<undefined>()
    const f = await fixture({ timeoutMs: 5 }); f.adapter.stream = async function* () { await release.promise; yield { type: 'finish', reason: { kind: 'stop' } } }; turn(f.session)
    let disposed = false; const disposal = f.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' }) })
    expect(disposed).toBe(false)
    release.resolve(undefined); await disposal
    expect(f.generated).toEqual([]); expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' })
    expect(f.session.snapshotEvents().some(event => event.type === 'skill/learning-response' && event.data.state === 'unavailable')).toBe(true)
  })

  it('holds disposal and admission until a timed-out durability participant settles', async () => {
    const release = Promise.withResolvers<undefined>()
    const f = await fixture({ timeoutMs: 5, maxPendingTasks: 1 }); f.ctx.on('session/flush', () => release.promise); turn(f.session)
    await vi.waitFor(() => { expect(f.availability.get('p')).toMatchObject({ state: 'unavailable' }) })
    turn(f.session); await Promise.resolve(); expect(f.flush).toHaveBeenCalledTimes(1)
    let disposed = false; const disposal = f.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    release.resolve(undefined); await disposal
    expect(f.evidence).toEqual([]); expect(f.adapter.calls).toEqual([])
  })

  it('counts concrete nested tool actions without counting run_code as an extra action', async () => {
    for (const count of [1, 2]) {
      const f = await fixture(); f.session.append('turn/start', { turn: 1 }); f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare and inspect release changes.' }] }), { surfaceOp: 'append' }); f.session.append('request/header', { reason: 'initial', header: { config: { provider: 'scripted', model: 'model' } } }); const rootCallId = ToolCallId('program'); f.session.append('tool/call', { turn: 1, step: 1, name: 'run_code', callId: rootCallId, arguments: '{}' })
      for (let n = 0; n < count; n++) { const subCallId = ToolCallId(`program:ptc:${n}`); const data = { rootCallId, parentCallId: rootCallId, subCallId, name: 'exec', arguments: { secret: 'must not retain nested arguments' } }; f.session.append('tool/ptc-dispatch-start', data); f.session.append('tool/ptc-dispatch', { ...data, isError: false, content: [{ type: 'text', text: 'nested tool stdout must not enter evidence' }] }) }
      f.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: rootCallId, isError: false, content: [] }) }, { surfaceOp: 'append' }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await f.dispose()
      expect(f.evidence).toHaveLength(count === 2 ? 1 : 0)
      expect(JSON.stringify(f.evidence)).not.toMatch(/must not retain nested arguments|nested tool stdout/)
      if (count === 2) expect(f.evidence[0]!.checks).toEqual([])
    }
  })

  it('enforces complete request and response bounds including framing and uncertainty', async () => {
    const input = await fixture({ maxInputBytes: 1000 }); turn(input.session); await input.dispose()
    expect(input.adapter.calls).toEqual([])
    const output = await fixture({ maxOutputBytes: 300 }); turn(output.session); await output.dispose()
    expect(output.adapter.calls).toHaveLength(1); expect(output.generated).toEqual([])
  })
})

function sourceFixture(content: string, constraint = 'You MUST request approval before deploying.'): SkillLearningSource {
  const item: SkillLibraryItem = { id: brandString<SkillLibraryId>('existing'), name: 'deploy', description: 'Deploy workflow', provider: 'filesystem', source: 'project', path: '/test/project/.dsh/skills/deploy/SKILL.md', scope: 'project', projectIds: ['p'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { userInvocable: true, modelInvocable: true }, contentHash: 'hash', bodyBytes: Buffer.byteLength(content), usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
  return { item, content, resourceHash: 'resources', resources: [{ path: 'reference.txt', hash: 'reference-hash', bytes: 50 }], constraints: [constraint], references: ['reference.txt'] }
}

function ctxDetachedTask() {
  // A seed created off-store never emits live session/event notifications.
  const ctx = new Context(); const store = new SessionStore(ctx); const session = store.prepare(SessionId('seed'), { meta: { cwd: '/test/project' } }); turn(session); return session
}
