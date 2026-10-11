/** Native admission and system-block projection use real services and a fixture-only peer. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, onTestFinished } from 'vitest'
import { resolveCodexAccess } from '../src/codex-backend-access.ts'
import { CodexBackendRuntime, declineCodexRequest } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

async function authority(cwd: string) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: process.cwd() })
  await ctx.plugin(Approval)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('final-codex-admission'), {}, { cwd })
  return { ctx, agent, resolve: () => ctx.agents.withInitiator(agent,
    () => resolveCodexAccess(ctx, { sessionId: agent.session.id })) }
}

describe('Codex final admission branches', () => {
  it('refuses a persisted relative working directory before creating an initiating session', async () => {
    await expect(authority('relative/project')).rejects.toThrow('session header cwd must be an absolute path')
  })

  it('uses ask when the public approval configuration omits its optional policy', async () => {
    const f = await authority(process.cwd())
    f.ctx.approval.config = {}
    expect(f.resolve().approvalPolicy).toBe('on-request')
  })

  it('retains system text while excluding nontext system blocks from native instructions', async () => {
    const callbacks = new Set<(method: string, params: Record<string, unknown>) => void>()
    const calls: Array<{ method: string; params: object }> = []
    const peer: CodexPeer = {
      notify() {}, close() {},
      subscribe: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } },
      request: async (method, params) => {
        calls.push({ method, params })
        if (method === 'account/read') return { account: { type: 'chatgpt' } }
        if (method === 'thread/start') return { thread: { id: 'owned-thread' } }
        if (method === 'turn/start') {
          queueMicrotask(() => {
            for (const callback of callbacks) callback('turn/completed', {
              threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'completed' },
            })
          })
          return { turn: { id: 'owned-turn' } }
        }
        return {}
      },
    }
    const runtime = new CodexBackendRuntime({
      preferences: { enabled: true, models: [{ id: 'owned-model', name: 'Owned', description: '',
        efforts: [], serviceTiers: [], inputModalities: ['text'] }], tiers: {} },
      connect: async () => peer, persist: async () => {},
      resolveAccess: () => ({ cwd: process.cwd(), sandbox: 'read-only', writableRoots: [],
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, request: declineCodexRequest }),
    })
    onTestFinished(() => { runtime.close() })
    const system = { ...createSystemMessage('Owned instruction'), content: [
      { type: 'text' as const, text: 'Owned instruction' },
      { type: 'reasoning' as const, text: 'Excluded system reasoning' },
    ] }
    const options: GenerateOptions = { provider: 'codex-backend', model: 'owned-model', messages: [system] }
    const chunks: StreamChunk[] = []
    for await (const chunk of runtime.stream(options)) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: 'Owned instruction\n\nUse your native Codex tools. Harness tool descriptions in prior context do not grant access.',
    })
    expect(JSON.stringify(calls)).not.toContain('Excluded system reasoning')
  })
})
