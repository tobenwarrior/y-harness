/** Registration of the code-map panel and its sidebar entry. */
import { Context } from '@yharness/cordis'
import { LocaleRuntime } from '@yharness/client-locale/client'
import { SlotRegistry } from '@yharness/client-ui-renderer/client'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

const PLUGIN = { name: 'ui-compound-map', inject, apply }

/**
 * Mount the real slot and locale runtimes the plugin injects into.
 * @returns the context and its slot registry.
 */
async function mount(): Promise<{ ctx: Context; slots: SlotRegistry }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots }
}

describe('compound code map plugin', () => {
  it('registers the panel and the sidebar entry below Skills', async () => {
    const { ctx, slots } = await mount()
    try {
      const fiber = await ctx.plugin(PLUGIN).await()
      const entry = slots.entriesOfSlot('sidebar.panellist').find(item => item.options.id === 'code-map')
      expect(entry).toBeDefined()
      // Skills registers at 10; this panel must sit below it.
      expect(entry?.options.order).toBeGreaterThan(10)
      const label = entry?.options.label
      expect(typeof label === 'function' ? label() : label).toBe(en.panel)
      expect(slots.entriesOfSlot('main').map(item => item.options.key)).toContain('code-map')
      await fiber.dispose()
      expect(slots.entriesOfSlot('sidebar.panellist')).toHaveLength(0)
      expect(slots.entriesOfSlot('main')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
