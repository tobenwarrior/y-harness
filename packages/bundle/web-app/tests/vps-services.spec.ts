import type { Agent } from '@yharness/agent'
import { Context } from '@yharness/cordis'
import { ToolCallId } from '@yharness/llm'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerVpsServiceTools, VpsServices, type VpsServiceAccess } from '../src/vps-services.ts'

interface SystemctlExecOptions {
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly maxBuffer?: number
  readonly env?: NodeJS.ProcessEnv
}

interface SystemctlExecCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SystemctlExecOptions
}

const systemctlExec = vi.hoisted(() => {
  const calls: SystemctlExecCall[] = []
  const execFileMock = vi.fn()
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: (command: string, args: readonly string[], options: SystemctlExecOptions): Promise<{ stdout: string; stderr: string }> => {
      calls.push({ command, args: [...args], options })
      return Promise.resolve({
        stdout: [
          'Id=example-user.service',
          'ActiveState=active',
        ].join('\n'),
        stderr: '',
      })
    },
  })
  return {
    calls,
    execFileMock,
    reset(): void { calls.length = 0 },
  }
})

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: systemctlExec.execFileMock,
}))

const access = [{ unit: 'example-worker.service', scope: 'system' as const, bots: ['bot-worker'], restart: true }]
const signal = new AbortController().signal

afterEach(() => { systemctlExec.reset() })

describe('VPS service access', () => {
  it('lists only the calling Bot grants and preserves the configured scope', () => {
    const botIds = ['bot-worker']
    const services = new VpsServices([
      { unit: 'example-worker.service', scope: 'system', bots: botIds, restart: true },
      { unit: 'example-user.service', scope: 'user', bots: ['bot-worker', 'bot-other'] },
    ], vi.fn())

    botIds.push('bot-other')

    expect(services.list('bot-worker')).toEqual([
      { unit: 'example-worker.service', restart: true },
      { unit: 'example-user.service', restart: false },
    ])
    expect(services.list('bot-other')).toEqual([{ unit: 'example-user.service', restart: false }])
    expect(services.list('bot-unknown')).toEqual([])
  })

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

  it('uses the fixed systemctl command, deadline, and scrubbed environment for default execution', async () => {
    const bot = 'bot-systemctl'
    const controller = new AbortController()
    vi.stubEnv('VPS_GRANT_VISIBLE', 'visible')
    vi.stubEnv('VPS_GRANT_TOKEN', 'secret')
    try {
      const services = new VpsServices([
        { unit: 'example-user.service', scope: 'user', bots: [bot] },
      ])

      await expect(services.status(bot, 'example-user.service', controller.signal)).resolves.toMatchObject({
        unit: 'example-user.service', active: 'active',
      })
      expect(systemctlExec.calls).toHaveLength(1)
      const call = systemctlExec.calls[0]!
      expect(call.command).toBe('/usr/bin/systemctl')
      expect(call.args).toEqual([
        '--user', '--no-pager', '--no-ask-password', 'show',
        '--property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts',
        '--', 'example-user.service',
      ])
      expect(call.options.signal).toBe(controller.signal)
      expect(call.options.timeout).toBe(15_000)
      expect(call.options.maxBuffer).toBe(16_384)
      expect(call.options.env).toMatchObject({
        VPS_GRANT_VISIBLE: 'visible',
        LC_ALL: 'C',
        SYSTEMD_PAGER: '',
        SYSTEMD_COLORS: '0',
      })
      expect(call.options.env).not.toHaveProperty('VPS_GRANT_TOKEN')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('normalizes malformed state and counter fields instead of exposing them', async () => {
    const run = vi.fn().mockResolvedValue([
      'ignored line without a separator',
      'Id=example-worker.service',
      'LoadState=not a state',
      'ActiveState=active',
      'SubState=',
      'Result=exit-code',
      'ExecMainCode=-1',
      'ExecMainStatus=not-a-number',
      'NRestarts=99999999999',
    ].join('\n'))
    const services = new VpsServices(access, run)

    await expect(services.status('bot-worker', 'example-worker.service', signal)).resolves.toEqual({
      unit: 'example-worker.service', load: null, active: 'active', sub: null,
      result: 'exit-code', mainCode: null, mainStatus: null, restarts: null,
    })
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

  it('rejects restart requests without a restart grant and uses the user manager for user-scoped grants', async () => {
    const run = vi.fn().mockResolvedValue('')
    const services = new VpsServices([
      { unit: 'example-user.service', scope: 'user', bots: ['bot-worker'] },
      { unit: 'example-worker.service', scope: 'user', bots: ['bot-worker'], restart: true },
    ], run)
    const ask = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)

    await expect(services.restart('bot-worker', 'example-user.service', ask, signal)).rejects.toThrow('not authorized')
    expect(ask).not.toHaveBeenCalled()
    await services.restart('bot-worker', 'example-worker.service', ask, signal)
    expect(run).toHaveBeenCalledExactlyOnceWith([
      '--user', '--no-pager', '--no-ask-password', 'restart', '--', 'example-worker.service',
    ], signal)
  })

  it('maps systemctl failures to a safe error and checks cancellation before dispatch', async () => {
    const run = vi.fn().mockRejectedValue(new Error('permission denied: PRIVATE_TOKEN'))
    const services = new VpsServices(access, run)

    await expect(services.status('bot-worker', 'example-worker.service', signal)).rejects.toThrow('unavailable under')
    const controller = new AbortController()
    controller.abort()
    await expect(services.status('bot-worker', 'example-worker.service', controller.signal)).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid, duplicate, templated, and empty service grants', () => {
    const run = vi.fn()
    const invalidGrants: readonly (readonly VpsServiceAccess[])[] = [
      [{ ...access[0]!, unit: 'example@.service' }],
      [{ ...access[0]!, bots: [] }],
      [{ ...access[0]!, bots: [' '] }],
      [access[0]!, access[0]!],
    ]

    for (const grants of invalidGrants) {
      expect(() => new VpsServices(grants, run)).toThrow('Invalid or duplicate')
    }
  })
})

describe('VPS service tools', () => {
  it('registers only for a granted Bot and removes both tools on context teardown', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const tools = ctx.tools
    ctx.provide('approval', { request: async () => 'allowed-once' } as never)
    const run = vi.fn().mockResolvedValue([
      'Id=example-worker.service', 'ActiveState=active',
    ].join('\n'))
    const services = new VpsServices(access, run)
    try {
      registerVpsServiceTools(ctx, 'bot-other', services)
      expect(ctx.tools.get('vps_service_status')).toBeUndefined()

      registerVpsServiceTools(ctx, 'bot-worker', services)
      expect(ctx.tools.get('vps_service_status')).toBeDefined()
      expect(ctx.tools.get('vps_service_restart')).toBeDefined()
      const listed = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('service-list'),
        name: 'vps_service_status',
        arguments: {},
      })
      expect(listed.isError).toBe(false)
      expect(listed.content).toContainEqual({
        type: 'text', text: JSON.stringify([{ unit: 'example-worker.service', restart: true }]),
      })
      const status = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('service-status'),
        name: 'vps_service_status',
        arguments: { unit: 'example-worker.service' },
      })
      expect(status.isError).toBe(false)
      expect(status.content).toContainEqual({
        type: 'text', text: JSON.stringify({
          unit: 'example-worker.service', load: null, active: 'active', sub: null,
          result: null, mainCode: null, mainStatus: null, restarts: null,
        }),
      })
    } finally {
      await ctx.fiber.dispose()
    }
    expect(tools.get('vps_service_status')).toBeUndefined()
  })

  it('omits restart registration without approval or a restart grant', async () => {
    const noApproval = new Context()
    const noRestartGrant = new Context()
    await noApproval.plugin(SystemPrompt)
    await noApproval.plugin(ToolRuntime)
    await noRestartGrant.plugin(SystemPrompt)
    await noRestartGrant.plugin(ToolRuntime)
    noRestartGrant.provide('approval', { request: async () => 'allowed-once' } as never)
    try {
      registerVpsServiceTools(noApproval, 'bot-worker', new VpsServices(access, vi.fn()))
      expect(noApproval.tools.get('vps_service_status')).toBeDefined()
      expect(noApproval.tools.get('vps_service_restart')).toBeUndefined()

      registerVpsServiceTools(noRestartGrant, 'bot-worker', new VpsServices([
        { unit: 'example-worker.service', scope: 'system', bots: ['bot-worker'] },
      ], vi.fn()))
      expect(noRestartGrant.tools.get('vps_service_status')).toBeDefined()
      expect(noRestartGrant.tools.get('vps_service_restart')).toBeUndefined()
    } finally {
      await Promise.all([noApproval.fiber.dispose(), noRestartGrant.fiber.dispose()])
    }
  })

  it('requires an owner decision before restarting and reports approval failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const approval = { request: vi.fn<() => Promise<'allowed-once' | 'rejected'>>().mockResolvedValue('rejected') }
    ctx.provide('approval', approval as never)
    const run = vi.fn().mockResolvedValue('')
    const services = new VpsServices(access, run)
    registerVpsServiceTools(ctx, 'bot-worker', services)
    const execute = (agent?: Agent) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('service-restart'),
      name: 'vps_service_restart',
      arguments: { unit: 'example-worker.service' },
      ...(agent === undefined ? {} : { agent }),
    })
    try {
      const missingOwner = await execute()
      expect(missingOwner.isError).toBe(true)
      expect(missingOwner.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('owner Bot Session') as string,
      }))
      expect(approval.request).not.toHaveBeenCalled()

      const owner = { id: 'bot-session', ctx } as Agent
      const rejected = await execute(owner)
      expect(rejected.isError).toBe(true)
      expect(rejected.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('owner approval') as string,
      }))
      expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({
        agent: owner, toolName: 'vps_service_restart', callId: ToolCallId('service-restart'),
        reason: 'Restart VPS service example-worker.service',
      }))
      expect(run).not.toHaveBeenCalled()

      approval.request.mockResolvedValue('allowed-once')
      const completed = await execute(owner)
      expect(completed.isError).toBe(false)
      expect(completed.content).toContainEqual({
        type: 'text', text: 'Restart completed for example-worker.service.',
      })
      expect(run).toHaveBeenCalledExactlyOnceWith([
        '--no-pager', '--no-ask-password', 'restart', '--', 'example-worker.service',
      ], expect.any(AbortSignal))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
