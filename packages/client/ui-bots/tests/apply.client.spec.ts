import { Context } from '@yharness/cordis'
import { BotId, type BotView } from '@yharness/bots/client'
import { LocaleRuntime } from '@yharness/client-locale/client'
import { TestRemote, TestSessions } from '@yharness/client-test-runtime'
import { SlotRegistry } from '@yharness/client-ui-renderer/client'
import { SessionId } from '@yharness/session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/apply.ts'
import type { ComputerAvailability } from '../src/client/computer-availability.ts'
import type { BotWorkspaceFace } from '../src/client/controller.ts'

const fibers: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  try {
    while (fibers.length > 0) await fibers.pop()!.dispose()
  } finally {
    vi.unstubAllGlobals()
  }
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
  const list = async () => ({ ok: true as const, value: { bots: rows } })
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
  return { ctx, fiber, registerSource, notifyGeneration: () => { generationListener?.() } }
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

  it('publishes the selected Bot’s Computer scope and refreshes it on reconnect', async () => {
    const row: BotView = {
      id: BotId('research'),
      sessionId: SessionId('session-research'),
      name: 'Research partner', identity: 'agent', accent: 'violet', cwd: '/workspace', state: 'active',
      createdAt: 1, updatedAt: 1, availability: 'idle', pinned: false, hidden: false,
    }
    const legacyBot = { ...row, id: BotId('legacy'), sessionId: SessionId('session-legacy'), name: 'Legacy Bot' }
    const managedComputer = { id: 'research-computer', location: 'vps', permissionScope: 'bot' } as const
    const workspaceComputer = { location: 'vps', permissionScope: 'workspace' } as const
    const managedBody = JSON.stringify({ sessionId: row.sessionId })
    const legacyBody = JSON.stringify({ sessionId: legacyBot.sessionId })
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url !== 'api/computer/status') throw new Error(`Unexpected request: ${url}`)
      const computer = options.body === managedBody ? managedComputer : workspaceComputer
      return Response.json({ available: true, kind: 'vps', computer })
    })
    vi.stubGlobal('fetch', fetchMock)
    const mounted = await mount([row, legacyBot])
    const panel = mounted.ctx.slots.entries('main')[0]?.inject?.() as Partial<Pick<BotWorkspaceFace, 'select'>> & {
      hooks?: BotWorkspaceFace['hooks'] & { computerIdentity?: ComputerAvailability['identity'] }
    } | undefined
    const identity = panel?.hooks?.computerIdentity
    if (panel?.select === undefined || identity === undefined) throw new Error('The Bot panel did not publish its Computer scope')

    await vi.waitFor(() => { expect(panel.hooks?.workspace.getSnapshot().bots).toHaveLength(2) })
    panel.select(row.id)
    await vi.waitFor(() => { expect(identity.getSnapshot()).toEqual(managedComputer) })
    const priorCalls = fetchMock.mock.calls.length
    mounted.notifyGeneration()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(priorCalls + 1)
      expect(fetchMock.mock.lastCall?.[1].body).toBe(managedBody)
      expect(identity.getSnapshot()).toEqual(managedComputer)
    })
    panel.select(legacyBot.id)
    await vi.waitFor(() => {
      expect(fetchMock.mock.lastCall?.[1].body).toBe(legacyBody)
      expect(identity.getSnapshot()).toEqual(workspaceComputer)
    })
  })
})
