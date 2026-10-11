// @vitest-environment jsdom
/** Retained outcome notices render through the real shell contribution after Settings unmounts. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyHost } from '../src/index.ts'
import { apply, inject } from '../src/client/index.ts'
import { CodingSessionsSection } from '../src/client/CodingSessionsSection.tsx'
import type { CodingSessionsSectionProps } from '../src/client/CodingSessionsSection.tsx'
import { CodingSessionsToast } from '../src/client/CodingSessionsToast.tsx'
import type { CodingSessionsFace } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { fixtureApi, mirror } from './fixtures.client.ts'

const contexts: Context[] = []
afterEach(async () => { cleanup(); vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const dictionary = { ...commonEn, ...en }
const t: CodingSessionsSectionProps['t'] = key => dictionary[key]
type OverlayFace = Pick<CodingSessionsFace, 'hooks' | 'dismissNotice'>
function useSource(face: OverlayFace): CodingSessionsSectionProps['useSessions'] {
  return selector => useSyncExternalStore(listener => face.hooks.sessions.subscribe(listener),
    () => selector(face.hooks.sessions.getSnapshot()))
}
function Root({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) {
  return <>{renderSlot('settings.section', { close: () => undefined })}{renderSlot('shell.overlay', {})}</>
}
async function boot(failed = false) {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin({ apply: applyHost }).await()
  expect(ctx.get('codingSessions')).toBeUndefined()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const api = fixtureApi()
  if (failed) api.importSession = async () => { throw new Error('Synthetic source transport failed') }
  new TestRemote(ctx, { codingSessions: api })
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
  } }, Root)
  const plugin = ctx.plugin({ inject, apply }); await plugin.await()
  // SlotRegistry erases feature faces at its renderer handoff.
  const settings = ctx.slots.entries('settings.section')[0]!.inject!() as CodingSessionsFace & Record<string, unknown>
  const overlay = ctx.slots.entries('shell.overlay')[0]!.inject!() as OverlayFace & Record<string, unknown>
  expect(overlay.hooks.sessions).toBe(settings.hooks.sessions)
  return { ctx, plugin, settings, overlay, api }
}

it('keeps a success outcome after Settings closes and dismisses it at the shell toast deadline', async () => {
  const { settings, overlay, api } = await boot()
  const importSession = vi.spyOn(api, 'importSession')
  const empty = render(<CodingSessionsToast {...overlay} useSessions={useSource(overlay)} t={t} />)
  expect(screen.queryByRole('alert')).toBeNull(); empty.unmount()
  const section = render(<CodingSessionsSection {...settings} useSessions={useSource(settings)} t={t} />)
  await screen.findByRole('button', { name: en.discover })
  fireEvent.click(screen.getByRole('button', { name: en.discover }))
  await screen.findByRole('button', { name: en.import })
  fireEvent.click(screen.getByRole('button', { name: en.import }))
  await screen.findByText('Inspect parser')
  expect(importSession).toHaveBeenCalledExactlyOnceWith(mirror.source)
  section.unmount()
  expect(overlay.hooks.sessions.getSnapshot().notice?.kind).toBe('imported')
  vi.useFakeTimers()
  render(<CodingSessionsToast {...overlay} useSessions={useSource(overlay)} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(en.imported)
  expect(screen.getByRole('alert').querySelector('svg')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(3999) })
  expect(screen.getByRole('alert').textContent).toBe(en.imported)
  act(() => { vi.advanceTimersByTime(1) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(settings.hooks.sessions.getSnapshot().notice).toBeNull()
})

it('renders a failed source outcome through the same retained overlay and retires the consumer cleanly', async () => {
  const { ctx, plugin, settings, overlay, api } = await boot(true)
  const importSession = vi.spyOn(api, 'importSession')
  settings.ensure(); await vi.waitFor(() => { expect(settings.hooks.sessions.getSnapshot().status).toBe('ready') })
  settings.importSession(mirror.source)
  await vi.waitFor(() => { expect(overlay.hooks.sessions.getSnapshot().notice?.kind).toBe('failed') })
  expect(importSession).toHaveBeenCalledExactlyOnceWith(mirror.source)
  expect(settings.hooks.sessions.getSnapshot().selected).toBeNull()
  vi.useFakeTimers()
  const toast = render(<CodingSessionsToast {...overlay} useSessions={useSource(overlay)} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(en.failed)
  expect(screen.getByRole('alert').querySelector('svg')).not.toBeNull()
  act(() => { vi.advanceTimersByTime(4000) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(overlay.hooks.sessions.getSnapshot().notice).toBeNull()
  toast.unmount(); await plugin.dispose()
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  settings.importSession(mirror.source); await Promise.resolve()
  expect(importSession).toHaveBeenCalledTimes(1)
})
