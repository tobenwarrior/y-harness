// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ILayout, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply, inject } from '../src/client/index.ts'
import { SkillLibraryPage } from '../src/client/SkillLibraryPage.tsx'
import { SkillLibraryToast } from '../src/client/SkillLibraryToast.tsx'
import type { SkillLibraryFace } from '../src/client/controller.ts'

usePinnedBrowserLanguages('en-US')

describe('skill library Loader composition', () => {
  it('waits for sidebar/main declarations, mounts localized contributions, and disposes them together', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const list = vi.fn(async () => ({ ok: true as const, value: { items: [], projects: [], providers: [], bodyBudgetBytes: 6000 } }))
    const listProposals = vi.fn(async () => ({ ok: true as const, value: [] }))
    const listLearningEvidence = vi.fn(async () => ({ ok: true as const, value: [] }))
    const learningStatus = vi.fn(async () => ({
      ok: true as const, value: { availability: [], generators: [], validators: [], policies: [], optIns: [], evidence: [] },
    }))
    new TestRemote(ctx, { skillLibrary: { list, listProposals, listLearningEvidence, learningStatus } })
    const panelInfo = createSnapshotStore<PanelInfo>({ activePanelId: null })
    const selectPanel = vi.fn<ILayout['selectPanel']>((activePanelId) => { panelInfo.set({ activePanelId }) })
    ctx.provide('layout', { panelInfo, selectPanel, beginNavigation: () => new AbortController().signal,
      toggleSidebar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn() })
    const slots = ctx.get('slots') as SlotRegistry
    const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('main')).toHaveLength(0)
    const removeRoot = slots.register({ name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' },
    } } as never, () => null)
    const entry = slots.entries('main')[0]!
    expect(entry.component).toBe(SkillLibraryPage)
    expect(entry.options).toMatchObject({ key: 'skills' })
    expect(entry.locale).toBe('skillLibrary')
    expect(slots.entries('shell.overlay')[0]?.component).toBe(SkillLibraryToast)
    const sidebar = slots.entries('sidebar.panellist')[0]!
    expect(resolveSlotLabel(sidebar.options.label)).toBe('Skills')
    locale.setLocale('zh')
    expect(resolveSlotLabel(sidebar.options.label)).toBe('技能')
    const injected: object = entry.inject!()
    const face = injected as SkillLibraryFace
    face.ensure()
    await vi.waitFor(() => { expect(face.hooks.library.getSnapshot().status).toBe('ready') })
    await vi.waitFor(() => { expect(face.hooks.library.getSnapshot().learning.status).toBe('ready') })
    expect(list).toHaveBeenLastCalledWith({})
    expect(listProposals).toHaveBeenLastCalledWith({})
    face.refresh()
    await vi.waitFor(() => { expect(list).toHaveBeenLastCalledWith({ forceReload: true }) })
    expect(selectPanel).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    removeRoot()
  })
})
