/** Browser registrations follow locale, root-seat HMR, reconnect and owning-fiber disposal. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { CodingSessionsFace } from '../src/client/controller.ts'
import { fixtureApi } from './fixtures.client.ts'

it('recovers declared seats and removes settings, toast, locale and callbacks on disposal', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx); ctx.provide('locale', locale)
    const api = fixtureApi(); const getState = vi.spyOn(api, 'getState')
    new TestRemote(ctx, { codingSessions: api })
    const slots = ctx.slots
    // The fixture declares the app-owned root seats consumed by this feature.
    const declare = () => slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    const declaration = declare(); const plugin = ctx.plugin({ inject, apply }); await plugin.await()
    expect(slots.entries('settings.section')).toHaveLength(1); expect(slots.entries('shell.overlay')).toHaveLength(1)
    locale.setLocale('en'); expect(resolveSlotLabel(slots.entries('settings.section')[0]!.options.label)).toBe('Coding sessions')
    locale.setLocale('zh'); expect(resolveSlotLabel(slots.entries('settings.section')[0]!.options.label)).toBe('编程会话')
    const face = slots.entries('settings.section')[0]!.inject!() as CodingSessionsFace & Record<string, unknown>
    face.ensure(); await vi.waitFor(() => { expect(getState).toHaveBeenCalledTimes(1) })
    declaration(); expect(slots.entries('settings.section')).toHaveLength(0); expect(slots.entries('shell.overlay')).toHaveLength(0)
    declare(); await Promise.resolve(); expect(slots.entries('settings.section')).toHaveLength(1); expect(slots.entries('shell.overlay')).toHaveLength(1)
    ctx.emit('connection/reset'); await vi.waitFor(() => { expect(getState).toHaveBeenCalledTimes(2) })
    await plugin.dispose(); expect(slots.entries('settings.section')).toHaveLength(0); expect(slots.entries('shell.overlay')).toHaveLength(0)
    ctx.emit('connection/reset'); face.refreshState(); await Promise.resolve(); expect(getState).toHaveBeenCalledTimes(2)
    expect(() => locale.register('codingSessions', 'en', {})).not.toThrow(); expect(() => locale.register('codingSessions', 'zh', {})).not.toThrow()
  } finally { await ctx.fiber.dispose() }
})
