import { describe, expect, it, vi } from 'vitest'
import { VpsServices } from '../src/vps-services.ts'

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
