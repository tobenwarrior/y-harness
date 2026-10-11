/** Retained evidence cannot reuse an API generation capability after adapter removal. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Llm, { LlmAdapter, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { expect, it, onTestFinished, vi } from 'vitest'
import { installSkillLearningRuntime } from '../src/learning-runtime.ts'
import type { SkillLearningRuntimeController } from '../src/learning-runtime.ts'
import type { SkillLearningEvidence, SkillLearningGenerator } from '../src/types.ts'

class RegistrationAdapter extends LlmAdapter {
  calls = 0
  override providerInfo(provider: string) { return { id: provider, name: 'Fixture API', auxiliaryGeneration: 'api' as const } }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    throw new Error('Fixture generation must never be dispatched')
  }
}

it('refuses a retained generator after its captured API adapter registration is removed', async () => {
  const context = new Context()
  await context.plugin(Sessions); await context.plugin(Llm)
  const registry = new WorkspaceRegistry(context)
  const workspace: Workspace = {
    id: brandString<Workspace['id']>('fixture-project'), path: '/inactive/fixture-project', title: 'Fixture',
    createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', sessionIds: [],
    setTitle: async () => undefined, attachSession: async () => undefined, insertSessionBefore: async () => undefined,
    detachSession: async () => undefined, status: async () => 'ok',
  }
  const discovery = vi.spyOn(registry, 'list').mockReturnValue([workspace])
  const adapter = new RegistrationAdapter()
  const registration = context.llm.registerAdapter(['fixture-api'], adapter)
  const evidence: SkillLearningEvidence[] = []
  const generators = new Map<string, SkillLearningGenerator>()
  const availability = vi.fn<SkillLearningRuntimeController['setLearningAvailability']>()
  const controller: SkillLearningRuntimeController = {
    registerLearningGenerator: (generator) => {
      generators.set(generator.id, generator)
      return () => { generators.delete(generator.id) }
    },
    recordLearningEvidence: async (observation) => {
      const retained = { ...observation, id: brandString<SkillLearningEvidence['id']>('retained-task'),
        createdAt: '2026-10-11T00:00:00Z' }
      evidence.push(retained); return retained
    },
    proposeLearning: async () => undefined,
    setLearningAvailability: availability,
  }
  const stopFlush = context.on('session/flush', () => undefined)
  const dispose = installSkillLearningRuntime(context, controller)
  onTestFinished(async () => { await dispose(); stopFlush(); discovery.mockRestore(); await context.fiber.dispose() })
  const session = context.sessions.create(SessionId('retained-root'), { meta: { cwd: workspace.path } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'Inspect this fixture workflow.' }] }), { surfaceOp: 'append' })
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture-api', model: 'fixture-model' } } })
  for (let index = 0; index < 2; index++) {
    const callId = ToolCallId(`fixture-inspection-${index}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'inspect', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false,
      content: [{ type: 'text', text: 'Fixture result must not enter evidence.' }] }) }, { surfaceOp: 'append' })
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await vi.waitFor(() => { expect(evidence).toHaveLength(1) })
  const generator = generators.get('harness-api')
  if (generator === undefined) throw new Error('Fixture API generation was not registered')
  registration()
  expect(generators.has('harness-api')).toBe(false)
  await expect(generator.generate({ projectId: workspace.id, operation: 'learn', evidence, catalog: [], sources: [],
    bodyBudgetBytes: 1500 }, new AbortController().signal)).rejects.toThrow('skill-learning: project API route unavailable')
  expect(adapter.calls).toBe(0)
  expect(session.snapshotEvents().filter(event => event.type === 'skill/learning-request')).toEqual([])
  expect(availability).toHaveBeenLastCalledWith(workspace.id,
    { state: 'unavailable', reason: 'The latest task route does not support API skill generation.' })
  expect(JSON.stringify(evidence)).not.toContain('Fixture result must not enter evidence.')
})
