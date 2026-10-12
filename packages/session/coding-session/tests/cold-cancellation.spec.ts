/** Controlled persistence double checks cancellation admission and uncancellable owner release. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SessionStore, { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionHandleFlushOptions, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { CodingSessionColdDestinations } from '../src/cold-destinations.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
class ControlledPersistence extends SessionPersistence {
  readonly flushing = gate()
  readonly closing = gate()
  readonly releaseClose = gate()
  creates = 0
  override async create(header: SessionHeader): Promise<SessionHandle> {
    this.creates += 1
    const first = this.creates === 1
    const close = async () => { if (first) { this.closing.release(); await this.releaseClose.promise } }
    return { id: header.id, header, inheritedEventCount: SessionLogOffset(0), access: 'write',
      read: async () => ({ events: [], eventState: 'detached' }), append: async () => {},
      flush: async (options?: SessionHandleFlushOptions) => {
        if (!first) return
        const signal = options?.signal
        if (signal === undefined) throw new Error('Expected cancellation signal')
        this.flushing.release()
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(new Error(String(signal.reason)))
          else signal.addEventListener('abort', () => { reject(new Error(String(signal.reason))) }, { once: true })
        })
      }, close, [Symbol.asyncDispose]: close,
    }
  }
  override async open(): Promise<SessionHandle> { throw new Error('Not used by this controlled fixture') }
  override async flush(): Promise<void> {}
  override async stat(): Promise<SessionPersistenceSnapshot | undefined> { return undefined }
  override async list(): Promise<readonly SessionPersistenceSnapshot[]> { return [] }
}

describe('cold destination cancellation', () => {
  it('aborts admitted work, joins uncancellable owner close, refuses the old queue and permits a new request', async () => {
    const ctx = new Context(); await ctx.plugin(SessionStore)
    const persistence = new ControlledPersistence(ctx)
    const cold = new CodingSessionColdDestinations(ctx, { maxEvents: 100, maxBytes: 100000, maxRecords: 10, timeoutMs: 10000 })
    const first = cold.create('/fixture/project').then(() => undefined, (error: unknown) => error)
    await persistence.flushing.promise
    const queued = cold.create('/fixture/project').then(() => undefined, (error: unknown) => error)
    try {
      let settled = false
      const cancellation = cold.cancelPending().then(() => { settled = true })
      await persistence.closing.promise
      expect(settled).toBe(false)
      expect(persistence.creates).toBe(1)
      persistence.releaseClose.release()
      await cancellation
      expect(await first).toBeInstanceOf(Error)
      expect(await queued).toBeInstanceOf(Error)
      const next = await cold.create('/fixture/project')
      expect(next.revision.eventCount).toBe(0)
      expect(persistence.creates).toBe(2)
    } finally {
      persistence.releaseClose.release()
      await cold.close(); await ctx.fiber.dispose()
    }
  })
})
