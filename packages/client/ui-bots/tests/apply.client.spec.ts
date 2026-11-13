import { Context } from '@yharness/cordis'
import { BotId, type BotView } from '@yharness/bots/client'
import { LocaleRuntime } from '@yharness/client-locale/client'
import { TestRemote, TestSessions } from '@yharness/client-test-runtime'
import { SlotRegistry } from '@yharness/client-ui-renderer/client'
import { SessionId } from '@yharness/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/apply.ts'

const fibers: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  while (fibers.length > 0) await fibers.pop()!.dispose()
})

async function mount(rows: readonly BotView[] = []) {
  const ctx = new Context()
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  let generationListener: (() => void) | undefined
  ctx.provide('connection', {
    rpc: {},
    generation: { subscribe: (listener: () => void) => {
      generationListener = listener
      return () => { generationListener = undefined }
    } },
  } as never)
  const registerSource = vi.fn(() => () => {})
  ctx.provide('inputTriggers', { registerSource } as never)
  const list = vi.fn(async () => ({ ok: true as const, value: { bots: rows } }))
  new TestRemote(ctx, { bots: { list } })
  for (const row of rows) await sessions.add({ id: row.sessionId })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.bots': { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  fibers.push(fiber)
  await fiber.await()
  return { ctx, sessions, fiber, list, registerSource, notifyGeneration: () => { generationListener?.() } }
}

describe('ui-bots apply', () => {
  it('declares its services and registers the Computer source and panel seats', async () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.bots', 'sessions', 'connection'])
    const mounted = await mount()
    const { ctx, fiber } = mounted

    expect(ctx.slots.entries('main')).toHaveLength(1)
    expect(ctx.slots.entries('main')[0]?.options.key).toBe('bots')
    expect(ctx.slots.entries('bots.conversation')).toHaveLength(1)
    expect(ctx.slots.entries('sidebar.bots')).toHaveLength(1)
    expect(mounted.registerSource).toHaveBeenCalledWith(expect.objectContaining({
      trigger: '@', name: 'computer',
    }))

    await fiber.dispose()
    fibers.splice(fibers.indexOf(fiber), 1)
    expect(ctx.slots.entries('main')).toHaveLength(0)
    expect(ctx.slots.entries('bots.conversation')).toHaveLength(0)
    expect(ctx.slots.entries('sidebar.bots')).toHaveLength(0)
  })

  it('refreshes Computer availability for the selected Bot and connection generation', async () => {
    const row: BotView = {
      id: BotId('research'),
      sessionId: SessionId('session-research'),
      name: 'Research partner', identity: 'agent', accent: 'violet', cwd: '/workspace', state: 'active',
      createdAt: 1, updatedAt: 1, availability: 'idle', pinned: false, hidden: false,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ available: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const mounted = await mount([row])

    await vi.waitFor(() => { expect(mounted.list).toHaveBeenCalled() })
    mounted.notifyGeneration()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('api/computer/status', expect.objectContaining({
        body: JSON.stringify({ sessionId: 'session-research' }),
      }))
    })
  })
})
