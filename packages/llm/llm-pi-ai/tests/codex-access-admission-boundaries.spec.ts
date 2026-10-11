import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import Questions from '@deepseek-ai/dsh-user-questions'
import { resolveCodexAccess } from '../src/codex-backend-access.ts'

async function fixture(options: { sandbox?: boolean; approval?: boolean; questions?: boolean } = {}) {
  const ctx = new Context(); onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  if (options.sandbox !== false) await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: process.cwd() })
  if (options.approval !== false) await ctx.plugin(Approval, { policy: 'ask' })
  if (options.questions !== false) await ctx.plugin(Questions)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('fixture-native-admission'))
  agent.session.append('turn/start', { turn: 1 })
  const access = (signal?: AbortSignal) => ctx.agents.withInitiator(agent, () => resolveCodexAccess(ctx, {
    sessionId: agent.session.id, ...(signal === undefined ? {} : { signal }),
  }))
  return { ctx, agent, access }
}

describe('native Codex action admission services', () => {
  it.each([{ sandbox: false }, { approval: false }])('requires both Harness policy services before native admission: %j', async (options) => {
    const f = await fixture(options)
    expect(() => f.access()).toThrow('sandbox and approval services')
  })

  it('uses the Harness workspace when the exact live session has no working directory', async () => {
    expect((await fixture()).access().cwd).toBe(process.cwd())
  })

  it('declines already cancelled native approvals without asking the human', async () => {
    const f = await fixture(); const ask = vi.fn(async () => 'allowed-once' as const)
    f.ctx.on('approval/request', ask)
    expect(await f.access(AbortSignal.abort()).request('item/fileChange/requestApproval', {})).toEqual({ decision: 'decline' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('requires the questions service after native input schema admission', async () => {
    const f = await fixture({ questions: false })
    await expect(f.access().request('item/tool/requestUserInput', { questions: [{ id: 'fixture', header: '', question: 'Which path?' }] })).rejects.toThrow('Harness user-questions service')
  })

  it('forwards open native questions without synthetic choices or custom answers', async () => {
    const f = await fixture(); const received: import('@deepseek-ai/dsh-user-questions').AskUserQuestionRequest[] = []
    f.ctx.on('user-questions/request', async (request) => {
      received.push(request); return { answers: [{ id: 'fixture', selected: ['fixture-answer'] }] }
    })
    expect(await f.access().request('item/tool/requestUserInput', { questions: [{ id: 'fixture', header: '', question: 'Which path?', options: null }] })).toEqual({ answers: { fixture: { answers: ['fixture-answer'] } } })
    expect(received[0]?.questions).toEqual([{ id: 'fixture', header: '', question: 'Which path?' }])
    expect(received[0]).not.toHaveProperty('signal')
  })

  it('adjudicates an uncancelled command through the current session without requiring a signal', async () => {
    const f = await fixture(); const received: import('@deepseek-ai/dsh-user-approval').ApprovalRequest[] = []
    f.ctx.on('approval/request', async (request) => { received.push(request); return 'allowed-once' })
    expect(await f.access().request('item/commandExecution/requestApproval', { command: 'fixture operation' })).toEqual({ decision: 'accept' })
    expect(received[0]?.agent).toBe(f.agent); expect(received[0]).not.toHaveProperty('signal')
  })
})
