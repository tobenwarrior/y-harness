import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import Questions from '@deepseek-ai/dsh-user-questions'
import { resolveCodexAccess } from '../src/codex-backend-access.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(Questions)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('native-access'), {}, { cwd: process.cwd() })
  agent.session.append('turn/start', { turn: 1 })
  const signal = new AbortController()
  const resolve = () => ctx.agents.withInitiator(agent, () => resolveCodexAccess(ctx, {
    provider: 'codex-backend', model: 'native', sessionId: agent.session.id, messages: [], signal: signal.signal,
  }))
  return { ctx, agent, resolve, signal }
}

describe('native Codex session authority', () => {
  it('uses session cwd, shared writable roots, networking and the latest permission switches', async () => {
    const { ctx, agent, resolve } = await fixture()
    const roots = writableRoots(ctx.sandboxPolicy.resolve({ session: agent.session }))
    expect(resolve()).toMatchObject({ cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: roots, networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true } })
    setSandboxMode(agent.session, 'read-only')
    setApprovalPolicy(agent.session, 'never')
    expect(resolve()).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', writableRoots: [],
      sandboxPolicy: { type: 'readOnly', networkAccess: true } })
    setSandboxMode(agent.session, 'danger-full-access')
    expect(resolve().sandboxPolicy).toEqual({ type: 'dangerFullAccess' })
  })

  it('rejects missing initiators and mismatched request identities before native execution', async () => {
    const { ctx, agent } = await fixture()
    const options = { provider: 'codex-backend', model: 'native', messages: [] }
    expect(() => resolveCodexAccess(ctx, options)).toThrow('initiator')
    expect(() => ctx.agents.withInitiator(agent, () => resolveCodexAccess(ctx, {
      ...options, sessionId: SessionId('another-session'),
    }))).toThrow('initiator')
  })

  it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])('audits and grants only one %s action', async (method) => {
    const { ctx, agent, resolve } = await fixture()
    const audit: unknown[] = []
    ctx.on('session/event', (_session, event) => { audit.push(event) })
    const decide = vi.fn(async (_request: import('@deepseek-ai/dsh-user-approval').ApprovalRequest) => 'allowed-once' as const)
    ctx.on('approval/request', decide)
    const params = { command: 'touch output', cwd: process.cwd(), item: { changes: [{ path: 'output', diff: '+new' }] } }
    expect(await resolve().request(method, params)).toEqual({ decision: 'accept' })
    expect(decide.mock.calls[0]?.[0].agent).toBe(agent)
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ toolName: method, reason: JSON.stringify(params) })
    expect(audit.at(-1)).toMatchObject({ type: 'approval/decided', data: { outcome: 'allowed-once' } })
    setApprovalPolicy(agent.session, 'never')
    expect(await resolve().request(method, params)).toEqual({ decision: 'decline' })
    expect(decide).toHaveBeenCalledOnce()
  })

  it('grants exactly reviewed permissions for this turn and fails closed without an answerer', async () => {
    const { ctx, resolve } = await fixture()
    const permissions = { network: { enabled: true }, fileSystem: { write: ['/extra'] } }
    expect(await resolve().request('item/permissions/requestApproval', { permissions })).toEqual({ permissions: {}, scope: 'turn' })
    ctx.on('approval/request', async () => 'allowed-once')
    expect(await resolve().request('item/permissions/requestApproval', { permissions })).toEqual({ permissions, scope: 'turn' })
    await expect(resolve().request('item/permissions/requestApproval', { permissions: { fileSystem: { write: true } } })).rejects.toThrow()
    await expect(resolve().request('unsupported', {})).rejects.toThrow('does not support')
  })

  it('forwards structured native questions and returns selected and custom answers', async () => {
    const { ctx, agent, resolve } = await fixture()
    const answer = vi.fn(async (_request: import('@deepseek-ai/dsh-user-questions').AskUserQuestionRequest) => ({ answers: [{ id: 'choice', selected: ['first'], custom: 'detail' }] }))
    ctx.on('user-questions/request', answer)
    expect(await resolve().request('item/tool/requestUserInput', { questions: [{
      id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'first', description: 'First option' }],
    }] })).toEqual({ answers: { choice: { answers: ['first', 'detail'] } } })
    expect(answer.mock.calls[0]?.[0].agent).toBe(agent)
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ questions: [{ id: 'choice', question: 'Which?' }] })
    await expect(resolve().request('item/tool/requestUserInput', { questions: [{
      id: 'secret', header: '', question: 'Token?', isSecret: true,
    }] })).rejects.toThrow('credential flow')
  })

  it('withdraws pending approvals when the native turn is cancelled', async () => {
    const { ctx, resolve, signal } = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<'allowed-once'>()
    ctx.on('approval/request', () => { entered.resolve(undefined); return late.promise })
    const result = resolve().request('item/commandExecution/requestApproval', { command: 'touch output' })
    await entered.promise
    signal.abort()
    expect(await result).toEqual({ decision: 'cancel' })
    late.resolve('allowed-once')
    await late.promise
  })
})
