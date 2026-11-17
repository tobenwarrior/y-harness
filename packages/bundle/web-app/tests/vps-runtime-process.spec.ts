import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { VpsRuntime } from '../src/vps-runtime.ts'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<() => Child>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn,
}))

class Child extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn<(signal: NodeJS.Signals) => boolean>().mockReturnValue(true)

  close(): void {
    this.stdout.destroy()
    this.stderr.destroy()
    this.emit('close', null)
  }
}

const session = 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('VPS provisioning processes', () => {
  it('closes the running child before releasing a retired configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-vps-process-'))
    const runtime = new VpsRuntime(root, 'localhost/fixture')
    const child = new Child()
    const spawned = Promise.withResolvers<undefined>()
    spawn.mockImplementationOnce(() => {
      spawned.resolve(undefined)
      return child
    })
    const preparing = runtime.ensure(session)
    const refused = expect(preparing).rejects.toThrow('VPS Bot Computer scope is closed')
    try {
      await spawned.promise
      let finished = false
      const closing = runtime.dispose().then(() => { finished = true })
      await Promise.resolve()
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(finished).toBe(false)
      child.close()
      await refused
      await closing
      expect(spawn).toHaveBeenCalledOnce()
    } finally {
      child.close()
      await runtime.dispose()
      spawn.mockReset()
      await rm(root, { recursive: true, force: true })
    }
  })
})
