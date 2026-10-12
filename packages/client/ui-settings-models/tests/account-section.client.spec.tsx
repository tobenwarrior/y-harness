// @vitest-environment jsdom
/** Independently opened account cards refresh the real Models page store. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSection, providerCopy } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'
afterEach(cleanup)
const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value })
const t = (key: keyof typeof en): string => en[key]
it('opens native editors independently and reloads the page after explicit native choices', async () => {
  const namespace: SettingsNamespaceView = { ns: 'llm-pi-ai', schema: {}, value: { providers: { nous: { models: [{ id: 'sol' }] } } },
    revision: 3, autoGenerate: true, applies: 'live', secrets: [] }
  const ctx = Object.assign(new Context(), { remote: {
    llm: { listProviders: async () => ok([]), listConfigurableProviders: async () => ok([]) },
    settings: { describe: async () => ok({ writable: true, hasDocument: false, namespaces: [namespace] }),
      mutate: async () => ok(namespace) },
    credentials: { describe: async () => ok({}) },
  } })
  const native = await ctx.plugin({ apply: (provider) => {
    const state = { connected: true, enabled: true, busy: false, running: 0, tiers: {} }
    provider.provide('remote.codexBackend', {
      getState: async () => ok(state), refresh: async () => ok(state), publish: async () => ok(state),
      models: async () => ok([]), start: async () => ok({ verificationUrl: 'https://example.test/device', userCode: 'LOCAL-CODE' }),
      cancel: async () => ok(undefined), configure: async () => ok(state), disconnect: async () => ok(state),
    })
    provider.provide('remote.nous', {
      getState: async () => ok({ configured: true, connected: true, busy: false }),
      models: async () => ok([{ id: 'sol', name: 'OpenAI: Sol', reasoning: false }]),
      start: async () => ok({ url: 'https://example.test/device', code: 'LOCAL-CODE', expiresAt: 1_000 }),
      cancel: async () => ok(undefined), disconnect: async () => ok(undefined),
    })
  } }).await()
  try {
    const mirror = new SettingsDescribeMirror(ctx)
    const controller = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await controller.load()
    const renderSlot: ModelsSectionProps['renderSlot'] = () => null
    render(<ModelsSection controller={controller} useSnapshot={bindSnapshotSelector(controller.store)}
      operations={createModelsOperations(ctx)} schema={settingsSchema} t={t} renderSlot={renderSlot} />)
    const load = vi.spyOn(controller, 'load')
    const chatgpt = providerCopy(en.editProvider, { provider: en.codexTitle, displayName: en.codexTitle })
    const nous = providerCopy(en.editProvider, { provider: en.nousTitle, displayName: en.nousTitle })
    expect(screen.queryByText(en.codexHint)).toBeNull()
    expect(screen.queryByText(en.nousHint)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: chatgpt }))
    await screen.findByRole('button', { name: en.codexRefresh })
    fireEvent.click(screen.getByRole('button', { name: nous }))
    await screen.findByRole('button', { name: en.nousManageModels })
    expect(screen.getByText(en.codexHint)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.codexRefresh }))
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: en.nousManageModels }))
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getByRole('button', { name: chatgpt }))
    expect(screen.queryByText(en.codexHint)).toBeNull()
    expect(screen.getByText(en.nousHint)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: nous }))
    expect(screen.queryByText(en.nousHint)).toBeNull()
    expect(screen.getByRole('heading', { name: en.title })).toBeDefined()
  } finally {
    cleanup()
    await native.dispose()
    await ctx.fiber.dispose()
  }
})
