import type { Agent } from '@yharness/agent'
import { Context } from '@yharness/cordis'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { ToolCallId } from '@yharness/llm'
import { describe, expect, it, vi } from 'vitest'

type ExecFileCallback = (error: Error | null, result: { readonly stdout: string; readonly stderr: string }) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: {
    readonly signal: AbortSignal
    readonly timeout: number
    readonly maxBuffer: number
    readonly env: NodeJS.ProcessEnv
  },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { registerVpsServiceTools, VpsServices } from '../src/vps-services.ts'

const access = [{ unit: 'example-worker.service', scope: 'system' as const, bots: ['bot-worker'], restart: true }]
const signal = new AbortController().signal

describe('VPS service access', () => {
  it('returns bounded service state without passing through journal or environment data', async () => {
    const run = vi.fn().mockResolvedValue([
      'Id=example-worker.service',
      'LoadState=loaded',
      'ActiveState=failed',
      'SubState=failed',
      'Result=exit-code',
      'ExecMainCode=1',
      'ExecMainStatus=23',
      'NRestarts=2',
      'Environment=PRIVATE_TOKEN=redacted',
    ].join('\n'))
    const services = new VpsServices(access, run)

    await expect(services.status('bot-worker', 'example-worker.service', signal)).resolves.toEqual({
      unit: 'example-worker.service', load: 'loaded', active: 'failed', sub: 'failed',
      result: 'exit-code', mainCode: 1, mainStatus: 23, restarts: 2,
    })
    expect(run).toHaveBeenCalledWith([
      '--no-pager', '--no-ask-password', 'show',
      '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts',
      '--', 'example-worker.service',
    ], signal)
  })

  it('uses the scrubbed default systemctl runner for user-scoped services', async () => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'Id=user-worker.service\nActiveState=active\n', stderr: '' })
    })
    const requestSignal = new AbortController().signal
    const services = new VpsServices([{
      unit: 'user-worker.service', scope: 'user', bots: ['bot-worker'],
    }])

    await expect(services.status('bot-worker', 'user-worker.service', requestSignal)).resolves.toEqual({
      unit: 'user-worker.service', load: null, active: 'active', sub: null,
      result: null, mainCode: null, mainStatus: null, restarts: null,
    })
    const call = execFileMock.mock.calls[0]
    if (call === undefined) throw new Error('default systemctl runner was not called')
    expect(call[0]).toBe('/usr/bin/systemctl')
    expect(call[1]).toEqual([
      '--user', '--no-pager', '--no-ask-password', 'show',
      '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts',
      '--', 'user-worker.service',
    ])
    expect(call[2].signal).toBe(requestSignal)
    expect(call[2].timeout).toBe(15_000)
    expect(call[2].maxBuffer).toBe(16_384)
    expect(call[2].env.LC_ALL).toBe('C')
    expect(call[2].env.SYSTEMD_PAGER).toBe('')
    expect(call[2].env.SYSTEMD_COLORS).toBe('0')
  })

  it('denies unrelated bots, wildcard units, and unexpected unit replies', async () => {
    const run = vi.fn().mockResolvedValue('Id=unrelated.service\nActiveState=active\n')
    const services = new VpsServices(access, run)
    await expect(services.status('bot-other', 'example-worker.service', signal)).rejects.toThrow('authorized')
    await expect(services.status('bot-worker', '*.service', signal)).rejects.toThrow('authorized')
    expect(run).not.toHaveBeenCalled()
    await expect(services.status('bot-worker', 'example-worker.service', signal)).rejects.toThrow('unavailable')
    expect(() => new VpsServices([{ ...access[0]!, unit: '*.service' }], run)).toThrow('Invalid')
  })

  it('restarts only an explicitly enabled unit after one owner approval', async () => {
    const run = vi.fn().mockResolvedValue('')
    const services = new VpsServices(access, run)
    const ask = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(services.restart('bot-other', 'example-worker.service', ask, signal)).rejects.toThrow('authorized')
    expect(ask).not.toHaveBeenCalled()
    await expect(services.restart('bot-worker', 'example-worker.service', ask, signal)).rejects.toThrow('approval')
    expect(run).not.toHaveBeenCalled()
    await services.restart('bot-worker', 'example-worker.service', ask, signal)
    expect(run).toHaveBeenCalledExactlyOnceWith([
      '--no-pager', '--no-ask-password', 'restart', '--', 'example-worker.service',
    ], signal)
  })

  it('rejects disabled restarts and maps a runner failure to a safe error', async () => {
    const run = vi.fn<(args: readonly string[], signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(new Error('permission denied'))
    const services = new VpsServices([{
      unit: 'example-worker.service', scope: 'system', bots: ['bot-worker'],
    }], run)
    const approve = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)

    await expect(services.restart('bot-worker', 'example-worker.service', approve, signal))
      .rejects.toThrow('restart is not authorized')
    expect(approve).not.toHaveBeenCalled()
    await expect(services.status('bot-worker', 'example-worker.service', signal))
      .rejects.toThrow('unavailable under the server’s Linux permissions')
  })

  it('propagates cancellation while a service command is still running', async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const run = vi.fn(async (_args: readonly string[], runSignal: AbortSignal) => {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        runSignal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      runSignal.throwIfAborted()
      return ''
    })
    const services = new VpsServices(access, run)
    const pending = services.status('bot-worker', 'example-worker.service', controller.signal)
    await entered.promise
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it('withdraws a pending restart when the turn is cancelled', async () => {
    const run = vi.fn().mockResolvedValue('')
    const controller = new AbortController()
    const services = new VpsServices(access, run)
    const ask = async () => { controller.abort(); return true }
    await expect(services.restart('bot-worker', 'example-worker.service', ask, controller.signal)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('VPS service tools', () => {
  it('checks the exact owning Agent and cancels an approval when its Web mount ends', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const entered = Promise.withResolvers<AbortSignal>()
    const request = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      entered.resolve(signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return 'allowed-once'
    })
    ctx.provide('approval', { request } as never)
    const run = vi.fn<(args: readonly string[], signal: AbortSignal) => Promise<string>>()
      .mockResolvedValue('Id=example-worker.service\nActiveState=active\n')
    const owner = { id: 'owner-session', ctx } as Agent
    const other = { id: owner.id, ctx } as Agent
    const lifetime = new AbortController()
    registerVpsServiceTools(ctx, 'bot-worker', new VpsServices(access, run), owner, lifetime.signal)
    const execute = (name: 'vps_service_status' | 'vps_service_restart', agent?: Agent) => ctx.tools.execute({
      signal,
      callId: ToolCallId('vps-service-owner-test'),
      name,
      arguments: { unit: 'example-worker.service' },
      ...(agent === undefined ? {} : { agent }),
    })
    try {
      await expect(execute('vps_service_status')).resolves.toMatchObject({ isError: true })
      await expect(execute('vps_service_status', other)).resolves.toMatchObject({ isError: true })
      await expect(execute('vps_service_restart', other)).resolves.toMatchObject({ isError: true })
      expect(request).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()

      const listed = await ctx.tools.execute({
        signal,
        callId: ToolCallId('vps-service-list-test'),
        name: 'vps_service_status',
        arguments: {},
        agent: owner,
      })
      expect(listed.isError).toBe(false)
      expect(listed.content).toContainEqual({
        type: 'text', text: JSON.stringify([{ unit: 'example-worker.service', restart: true }]),
      })
      await expect(execute('vps_service_status', owner)).resolves.toMatchObject({ isError: false })
      expect(run).toHaveBeenCalledOnce()
      const restart = execute('vps_service_restart', owner)
      const requestSignal = await entered.promise
      lifetime.abort()
      expect(requestSignal.aborted).toBe(true)
      await expect(restart).resolves.toMatchObject({ isError: true })
      await expect(execute('vps_service_status', owner)).resolves.toMatchObject({ isError: true })
      expect(run).toHaveBeenCalledOnce()
    } finally {
      lifetime.abort()
      await ctx.fiber.dispose()
    }
  })

  it('offers status without restart when approval is unavailable or restart is omitted', async () => {
    const noApprovalContext = new Context()
    const approvalContext = new Context()
    const lifetime = new AbortController()
    const owner = { id: 'owner-session', ctx: noApprovalContext } as Agent
    const noRestart = new VpsServices([{
      unit: 'example-worker.service', scope: 'system', bots: ['bot-worker'],
    }], vi.fn<(args: readonly string[], signal: AbortSignal) => Promise<string>>().mockResolvedValue(''))
    try {
      await noApprovalContext.plugin(SystemPrompt)
      await noApprovalContext.plugin(ToolRuntime)
      registerVpsServiceTools(noApprovalContext, 'bot-worker', new VpsServices([{
        unit: 'other-worker.service', scope: 'system', bots: ['other-bot'],
      }]), owner, lifetime.signal)
      expect(noApprovalContext.tools.get('vps_service_status')).toBeUndefined()
      registerVpsServiceTools(noApprovalContext, 'bot-worker', noRestart, owner, lifetime.signal)
      expect(noApprovalContext.tools.get('vps_service_status')).toBeDefined()
      expect(noApprovalContext.tools.get('vps_service_restart')).toBeUndefined()

      await approvalContext.plugin(SystemPrompt)
      await approvalContext.plugin(ToolRuntime)
      approvalContext.provide('approval', { request: vi.fn() } as never)
      const approvalOwner = { id: owner.id, ctx: approvalContext } as Agent
      registerVpsServiceTools(approvalContext, 'bot-worker', noRestart, approvalOwner, lifetime.signal)
      expect(approvalContext.tools.get('vps_service_status')).toBeDefined()
      expect(approvalContext.tools.get('vps_service_restart')).toBeUndefined()
    } finally {
      await noApprovalContext.fiber.dispose()
      await approvalContext.fiber.dispose()
    }
  })

  it('rejects stale approval and completes an allowed owner restart', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const request = vi.fn<() => Promise<'allowed-always' | 'allowed-once'>>()
      .mockResolvedValueOnce('allowed-always')
      .mockResolvedValueOnce('allowed-once')
    ctx.provide('approval', { request } as never)
    const run = vi.fn<(args: readonly string[], signal: AbortSignal) => Promise<string>>()
      .mockResolvedValue('')
    const owner = { id: 'owner-session', ctx } as Agent
    registerVpsServiceTools(ctx, 'bot-worker', new VpsServices(access, run), owner, new AbortController().signal)
    const execute = () => ctx.tools.execute({
      signal,
      callId: ToolCallId('vps-service-approval-test'),
      name: 'vps_service_restart',
      arguments: { unit: 'example-worker.service' },
      agent: owner,
    })
    try {
      const stale = await execute()
      expect(stale.isError).toBe(true)
      expect(stale.content.some(block => block.type === 'text' && block.text.includes('owner approval'))).toBe(true)
      expect(run).not.toHaveBeenCalled()

      const completed = await execute()
      expect(completed.isError).toBe(false)
      expect(completed.content).toContainEqual({ type: 'text', text: 'Restart completed for example-worker.service.' })
      expect(run).toHaveBeenCalledTimes(1)
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
