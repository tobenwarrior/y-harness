/** Native source discovery remains loadable when ordinary-Y Session capabilities are absent. */
import { Context } from '@yharness/cordis'
import { brandString } from '@yharness/brand'
import type { SessionId } from '@yharness/session'
import { describe, expect, it, vi } from 'vitest'

const attempts = vi.hoisted(() => ({ sessionLoads: 0 }))
vi.mock('@yharness/session', () => {
  attempts.sessionLoads += 1
  throw new Error('Optional Session package is absent in this fixture')
})
import { CodingSessionColdDestinations } from '../src/cold-destinations.ts'
import { codingSessionLinkSchema } from '../src/linked-import-record.ts'

describe('optional ordinary-Y Session boundary', () => {
  it('loads discovery-side journal and refuses cold writes before loading an absent Session capability', async () => {
    const ctx = new Context()
    const destinations = new CodingSessionColdDestinations(ctx, { maxEvents: 32, maxBytes: 4096, maxRecords: 8, timeoutMs: 1000 })
    let admitted = false
    try {
      expect(destinations.available()).toBe(false)
      expect(codingSessionLinkSchema.safeParse({}).success).toBe(false)
      await expect(destinations.list()).rejects.toThrow(/requires durable Session storage/)
      await expect(destinations.withDestination(brandString<SessionId>('absent-capability-destination'), () => {
        admitted = true
        return Promise.resolve()
      })).rejects.toThrow(/requires durable Session storage/)
      expect(admitted).toBe(false)
      expect(attempts.sessionLoads).toBe(0)
    } finally { await destinations.close(); await ctx.fiber.dispose() }
  })
})
