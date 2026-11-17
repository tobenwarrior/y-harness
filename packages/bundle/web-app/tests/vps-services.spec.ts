import type { Agent } from '@yharness/agent'
import { Context } from '@yharness/cordis'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { ToolCallId } from '@yharness/llm'
import { describe, expect, it, vi } from 'vitest'
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
})
