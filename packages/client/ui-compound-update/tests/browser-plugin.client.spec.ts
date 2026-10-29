/** Registration of the badge, the steps panel, and the dictionary. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

const PLUGIN = { name: 'ui-compound-update', inject, apply }

/** One complete reading, as the Host route answers it. */
const RELEASED = {
  vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true,
  repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null,
}

/**
 * Mount the real slot and locale runtimes the plugin injects into.
 * @returns the context, its slot registry, and the requested route URLs.
 */
async function mount(): Promise<{ ctx: Context; slots: SlotRegistry; requested: string[] }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const requested: string[] = []
  vi.stubGlobal('fetch', (url: string) => { requested.push(url); return Promise.resolve(Response.json(RELEASED)) })
  return { ctx, slots, requested }
}

describe('compound update plugin', () => {
  it('refreshes periodically and stops after disposal', async () => {
    const { ctx, requested } = await mount()
    vi.useFakeTimers()
    try {
      const fiber = await ctx.plugin(PLUGIN).await()
      expect(requested).toEqual(['api/skill-compound.update'])
      await vi.advanceTimersByTimeAsync(60 * 1000)
      expect(requested).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(60 * 1000)
      expect(requested).toHaveLength(3)
      await fiber.dispose()
      await vi.advanceTimersByTimeAsync(60 * 1000)
      expect(requested).toHaveLength(3)
    } finally {
      await ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('registers the badge, the panel, and reads the route once', async () => {
    const { ctx, slots, requested } = await mount()
    try {
      const fiber = await ctx.plugin(PLUGIN).await()
      const badge = slots.entriesOfSlot('sidebar.footer.action').find(entry => entry.options.id === 'compound-update')
      const panel = slots.entriesOfSlot('shell.overlay').find(entry => entry.options.id === 'compound-update.steps')
      expect(badge).toBeDefined()
      expect(panel).toBeDefined()
      // The renderer calls each registration's inject face; both must hand back
      // the same controller face so the badge and the panel share one state.
      const badgeFace = badge?.inject?.() as { hooks?: unknown; show?: unknown } | undefined
      const panelFace = panel?.inject?.() as { hooks?: unknown; show?: unknown } | undefined
      expect(badgeFace?.hooks).toBeDefined()
      expect(badgeFace?.hooks).toBe(panelFace?.hooks)
      expect(typeof badgeFace?.show).toBe('function')
      await vi.waitFor(() => { expect(requested).toEqual(['api/skill-compound.update']) })
      await fiber.dispose()
      expect(slots.entriesOfSlot('sidebar.footer.action')).toHaveLength(0)
      expect(slots.entriesOfSlot('shell.overlay')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
