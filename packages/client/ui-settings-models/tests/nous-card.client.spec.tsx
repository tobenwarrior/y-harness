// @vitest-environment jsdom
/** User-visible native device connection and explicit account-model persistence. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NousConnectionView, NousModelView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { NousCard } from '../src/client/NousCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { countCopy } from '../src/client/nous-models.ts'
import { en } from '../src/client/locales.ts'
import { resolveProfiles } from '../../../llm/llm-pi-ai/src/config.ts'
import type { PiAiProviderProfile } from '../../../llm/llm-pi-ai/src/config.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const namespace: SettingsNamespaceView = { ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, revision: 3, autoGenerate: true, applies: 'live', secrets: [] }
const catalog: NousModelView[] = [
  { id: 'nous-a', name: 'Nous A', contextWindow: 32768, maxTokens: 8192, inputModalities: ['text'], reasoning: true, reasoningEfforts: { low: 'low', high: 'high' }, reasoningMandatory: true },
  { id: 'nous-b', name: 'Nous B', reasoning: false },
]
function fixture(view: NousConnectionView = { configured: true, connected: false, busy: false }) {
  const nous = {
    getState: vi.fn(async () => view),
    start: vi.fn(async () => ({ url: 'https://portal.nousresearch.com/device', code: 'ABCD', expiresAt: Date.now() + 60_000 })),
    finish: vi.fn(async (_signal: AbortSignal) => ({ configured: true, connected: true, busy: false })),
    models: vi.fn(async () => catalog),
    cancel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => { view = { configured: true, connected: false, busy: false } }),
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view: namespace }))
  const operations: ModelsOperations = { nous,
    describeCredential: vi.fn(async () => undefined), storeCredential: vi.fn(async () => undefined),
    removeCredential: vi.fn(async () => undefined),
    writeSettings,
    discoverModels: vi.fn(async () => ({ kind: 'found' as const, models: [] })),
  }
  const onSaved = vi.fn()
  return { nous, operations, onSaved, writeSettings }
}
/** Open the account picker whose rows carry the model checkboxes. */
function openPicker(): void {
  fireEvent.click(screen.getByRole('button', { name: en.nousManageModels }))
}
/** The picker's search field, a plain input labelled by its placeholder. */
function searchBox(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>(en.nousModelsSearch)
}

it('keeps Nous sign-in dormant until the user consents to local token storage', async () => {
  const f = fixture()
  render(<NousCard {...f} namespace={namespace} t={t} />)
  await screen.findByText(en.statusSignedOut)
  expect(screen.queryByText(en.nousHermesDisclosure)).toBeNull()
  fireEvent.click(screen.getByText(en.nousAbout))
  expect(screen.getByText(en.nousHermesDisclosure)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.nousManageModels })).toBeNull()
  expect(screen.getByRole('button', { name: en.nousContinue }).hasAttribute('disabled')).toBe(true)
  expect(f.nous.start).not.toHaveBeenCalled()
  expect(f.nous.models).not.toHaveBeenCalled()
  expect(f.writeSettings).not.toHaveBeenCalled()
})

it('loads a connected account catalogue on mount and restores its saved selection', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const saved = { ...namespace, value: { providers: { nous: { api: 'openai-completions', models: [{ id: 'nous-b' }] } } } }
  render(<NousCard {...f} namespace={saved} t={t} />)
  await screen.findByText(en.statusConnected)
  expect(await screen.findByText(countCopy(en.nousModelsSummary, { enabled: 1, total: 2 }))).toBeTruthy()
  expect(f.nous.models).toHaveBeenCalledOnce()
  openPicker()
  expect(screen.getByLabelText<HTMLInputElement>('Nous B').checked).toBe(true)
  expect(screen.getByLabelText<HTMLInputElement>('Nous A').checked).toBe(false)
})

it('publishes a starter set once when nothing is saved yet', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  render(<NousCard {...f} namespace={namespace} t={t} />)
  await screen.findByText(en.nousAdded)
  expect(f.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'nous'], value: {
    displayName: 'Nous Portal', api: 'openai-completions', models: [
      { id: 'nous-a', name: 'Nous A', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { low: 'low', high: 'high' } },
      { id: 'nous-b', name: 'Nous B', reasoningEfforts: false },
    ],
  } }], 3)
})

it('requires local-storage consent and shows browser instructions while authorization is pending', async () => {
  const f = fixture()
  const completed = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => completed.promise)
  render(<NousCard {...f} namespace={namespace} t={t} />)
  const button = screen.getByRole('button', { name: en.nousContinue })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByLabelText(en.nousStorage))
  await waitFor(() => { expect(button.hasAttribute('disabled')).toBe(false) })
  fireEvent.click(button)
  expect(await screen.findByText('ABCD')).toBeTruthy()
  expect(screen.getByRole('link', { name: en.nousOpenBrowser }).getAttribute('href')).toBe('https://portal.nousresearch.com/device')
  expect(f.nous.start).toHaveBeenCalledWith(true)
  completed.resolve({ configured: true, connected: true, busy: false })
  // Connecting publishes the starter set; no separate save click is needed.
  await screen.findByText(en.nousAdded)
  expect(f.writeSettings).toHaveBeenCalledOnce()
})

it('saves only the picked account models with advertised metadata and a fenced write', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const saved = { ...namespace, value: { providers: { nous: { api: 'openai-completions', models: [{ id: 'nous-b' }] } } } }
  f.writeSettings.mockImplementation(async (_ns, ops) => {
    const first = ops[0]
    if (first?.op !== 'set') throw new Error('Expected a selected profile')
    expect(resolveProfiles({ nous: first.value as PiAiProviderProfile }, 'strict', 'approved-test-client').get('nous')?.piProvider?.getModels()[0]?.id).toBe('nous-a')
    return { kind: 'written', view: namespace }
  })
  render(<NousCard {...f} namespace={saved} t={t} />)
  await screen.findByText(en.statusConnected)
  openPicker()
  fireEvent.click(screen.getByLabelText('Nous A'))
  fireEvent.click(screen.getByLabelText('Nous B'))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.nousReady)
  expect(f.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'nous'], value: {
    displayName: 'Nous Portal', api: 'openai-completions', models: [{ id: 'nous-a', name: 'Nous A', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { low: 'low', high: 'high' } }],
  } }], 3)
  expect(f.onSaved).toHaveBeenCalledOnce()
})

it('filters the picker by search and by the enabled-only view', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const saved = { ...namespace, value: { providers: { nous: { models: [{ id: 'nous-b' }] } } } }
  render(<NousCard {...f} namespace={saved} t={t} />)
  await screen.findByText(en.statusConnected)
  openPicker()
  expect(screen.getByText(en.nousOtherVendor)).toBeTruthy()
  fireEvent.change(searchBox(), { target: { value: 'Nous A' } })
  expect(screen.queryByLabelText('Nous B')).toBeNull()
  fireEvent.change(searchBox(), { target: { value: 'nothing here' } })
  expect(screen.getByText(en.nousModelsNone)).toBeTruthy()
  fireEvent.change(searchBox(), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: `${en.nousModelsSelected} 1` }))
  expect(screen.queryByLabelText('Nous A')).toBeNull()
  expect(screen.getByLabelText('Nous B')).toBeTruthy()
  // A vendor group selects and clears as a unit.
  fireEvent.click(screen.getByRole('button', { name: `${en.nousModelsAll} 2` }))
  fireEvent.click(screen.getByRole('button', { name: en.nousModelsSelectAll }))
  expect(screen.getByLabelText<HTMLInputElement>('Nous A').checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.nousModelsClear }))
  expect(screen.getByLabelText<HTMLInputElement>('Nous A').checked).toBe(false)
})

it('demotes the saved Nous route after clearing the local grant', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const profiles: Record<string, PiAiProviderProfile> = { nous: { api: 'openai-completions', models: [{ id: 'nous-a' }] } }
  expect(resolveProfiles(profiles, 'strict', 'approved-test-client').has('nous')).toBe(true)
  f.writeSettings.mockImplementation(async (_ns, ops) => {
    if (ops[0]?.op === 'unset') delete profiles['nous']
    expect(resolveProfiles(profiles, 'strict', 'approved-test-client').has('nous')).toBe(false)
    return { kind: 'written', view: namespace }
  })
  const saved = { ...namespace, value: { providers: { nous: { api: 'openai-completions', models: [{ id: 'nous-a' }] } } } }
  render(<NousCard {...f} namespace={saved} t={t} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: en.nousDisconnect }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.nousDisconnect }))
  await screen.findByText(en.nousDisconnected)
  expect(f.nous.disconnect).toHaveBeenCalledOnce()
  expect(f.writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'nous'] }], 3)
  expect(f.nous.disconnect.mock.invocationCallOrder[0]).toBeLessThan(f.writeSettings.mock.invocationCallOrder[0]!)
})

it('keeps a rejected picker save reviewable and leaves the draft in place', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const saved = { ...namespace, value: { providers: { nous: { models: [{ id: 'nous-b' }] } } } }
  f.writeSettings.mockResolvedValue({ kind: 'conflict', message: 'Settings moved. Reload and try again.' })
  render(<NousCard {...f} namespace={saved} t={t} />)
  await screen.findByText(en.statusConnected)
  openPicker()
  fireEvent.click(screen.getByLabelText('Nous A'))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText('Settings moved. Reload and try again.')
  expect(f.onSaved).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>('Nous A').checked).toBe(true)
})

it('settles owned sign-in on unmount without later settings writes', async () => {
  const f = fixture()
  const completed = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => completed.promise)
  const mounted = render(<NousCard {...f} namespace={namespace} t={t} />)
  fireEvent.click(screen.getByLabelText(en.nousStorage))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.nousContinue }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.nousContinue }))
  await screen.findByText('ABCD')
  mounted.unmount()
  await waitFor(() => { expect(f.nous.cancel).toHaveBeenCalledOnce() })
  completed.resolve({ configured: true, connected: true, busy: false })
  await Promise.resolve()
  expect(f.nous.models).not.toHaveBeenCalled()
  expect(f.writeSettings).not.toHaveBeenCalled()
})

it('preserves valid route options while retaining off only for explicitly optional reasoning', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  f.nous.models.mockResolvedValue([
    { id: 'unknown', name: 'Unknown requirement', reasoning: true, reasoningEfforts: { off: 'none', high: 'high' } },
    { id: 'mandatory', name: 'Required reasoning', reasoning: true, reasoningMandatory: true, reasoningEfforts: { off: 'none', high: 'high' } },
    { id: 'optional', name: 'Optional reasoning', reasoning: true, reasoningMandatory: false, reasoningEfforts: { off: 'none', high: 'high' } },
  ])
  const saved = { ...namespace, value: { providers: { nous: { api: 'openai-completions', streamIdleTimeoutMs: 20000, timeoutMs: 45000, models: [{ id: 'old' }] } } } }
  render(<NousCard {...f} namespace={saved} t={t} />)
  await screen.findByText(en.statusConnected)
  openPicker()
  for (const name of ['Unknown requirement', 'Required reasoning', 'Optional reasoning']) fireEvent.click(await screen.findByLabelText(name))
  fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await screen.findByText(en.nousReady)
  const first = f.writeSettings.mock.calls[0]?.[1][0]
  if (first?.op !== 'set') throw new Error('Expected saved Nous settings')
  expect(first.value).toMatchObject({ streamIdleTimeoutMs: 20000, timeoutMs: 45000, models: [
    { id: 'unknown', reasoningEfforts: { high: 'high' } },
    { id: 'mandatory', reasoningEfforts: { high: 'high' } },
    { id: 'optional', reasoningEfforts: { off: 'none', high: 'high' } },
  ] })
  const profile = first.value as PiAiProviderProfile
  expect(profile.models?.[0]?.reasoningEfforts).not.toHaveProperty('off')
  expect(profile.models?.[1]?.reasoningEfforts).not.toHaveProperty('off')
  expect(() => resolveProfiles({ nous: profile }, 'strict', 'approved-test-client')).not.toThrow()
})

it('keeps disconnect retry available if local clear succeeded but settings removal conflicted', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  const saved = { ...namespace, value: { providers: { nous: { models: [{ id: 'nous-a' }] } } } }
  f.writeSettings.mockResolvedValueOnce({ kind: 'conflict', message: 'Settings moved.' })
  render(<NousCard {...f} namespace={saved} t={t} />)
  await waitFor(() => { expect(screen.getByRole('button', { name: en.nousDisconnect }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.nousDisconnect }))
  await screen.findByText(`${en.nousRemovalPending} Settings moved.`)
  expect(screen.getByRole('button', { name: en.nousDisconnect }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.nousDisconnect }))
  await screen.findByText(en.nousDisconnected)
  expect(f.nous.disconnect).toHaveBeenCalledTimes(2)
})

it('accepts a saved authorization when cancel arrived after durable commit admission', async () => {
  const f = fixture()
  const completed = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => completed.promise)
  f.nous.cancel.mockImplementationOnce(async () => {
    const saved = { configured: true, connected: true, busy: false }
    f.nous.getState.mockResolvedValue(saved)
    completed.resolve(saved)
  })
  render(<NousCard {...f} namespace={namespace} t={t} />)
  fireEvent.click(screen.getByLabelText(en.nousStorage))
  await waitFor(() => { expect(screen.getByRole('button', { name: en.nousContinue }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: en.nousContinue }))
  await screen.findByText('ABCD')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  await screen.findByText(en.statusConnected)
  expect(f.nous.models).toHaveBeenCalledOnce()
})
