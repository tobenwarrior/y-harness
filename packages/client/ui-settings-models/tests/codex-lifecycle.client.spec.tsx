// @vitest-environment jsdom
/** Native account reads remain local and late replies cannot revive a closed card. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CodexBackendModelView, CodexBackendView } from '@deepseek-ai/dsh-api-remotes/client'
import { CodexBackendCard } from '../src/client/CodexBackendCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en): string => en[key]
const signedOut: CodexBackendView = { connected: false, enabled: false, busy: false, running: 0, tiers: {} }
const sol: CodexBackendModelView = { id: 'sol', name: 'Sol', description: '', efforts: [{ id: 'ultra', description: '' }], defaultEffort: 'ultra', serviceTiers: [{ id: 'fast', name: 'Fast', description: 'More usage' }], inputModalities: ['text'] }
const operationsBase: ModelsOperations = {
  describeCredential: async () => undefined, storeCredential: async () => undefined, removeCredential: async () => undefined,
  writeSettings: async () => ({ kind: 'refused', message: 'Unexpected settings write' }), discoverModels: async () => ({ kind: 'found', models: [] }),
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function fixture(initial: CodexBackendView = { ...signedOut, connected: true }, catalog: CodexBackendModelView[] = [sol], open = true) {
  let state = initial
  let available = catalog
  const backend = {
    getState: vi.fn<NonNullable<ModelsOperations['codexBackend']>['getState']>(async () => state),
    models: vi.fn<NonNullable<ModelsOperations['codexBackend']>['models']>(async () => available),
    refresh: vi.fn<NonNullable<ModelsOperations['codexBackend']>['refresh']>(async () => state),
    publish: vi.fn<NonNullable<ModelsOperations['codexBackend']>['publish']>(async () => state),
    start: vi.fn<NonNullable<ModelsOperations['codexBackend']>['start']>(async () => ({ verificationUrl: 'https://example.test/device', userCode: 'LOCAL-CODE' })),
    cancel: vi.fn<NonNullable<ModelsOperations['codexBackend']>['cancel']>(async () => {}),
    configure: vi.fn<NonNullable<ModelsOperations['codexBackend']>['configure']>(async (enabled) => { state = { ...state, enabled }; return state }),
    disconnect: vi.fn<NonNullable<ModelsOperations['codexBackend']>['disconnect']>(async () => signedOut),
  }
  const operations = { ...operationsBase, codexBackend: backend }
  const onSaved = vi.fn()
  const view = render(<CodexBackendCard operations={operations} onSaved={onSaved} t={t} open={open} />)
  return { ...view, operations, backend, onSaved,
    setModels: (next: CodexBackendModelView[]): void => { available = next } }
}
async function ready(): Promise<void> { await screen.findByRole('button', { name: en.codexProcessingModel }) }
function start(): void {
  fireEvent.click(screen.getByLabelText(en.codexStorage))
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
}

it('omits unavailable native controls', () => {
  const view = render(<CodexBackendCard operations={operationsBase} onSaved={() => {}} t={t} />)
  expect(view.container.textContent).toBe('')
})
it.each(['read', 'refresh', 'catalog'] as const)('discards a mount %s reply after the card closes', async (stage) => {
  const f = fixture(stage === 'refresh' ? signedOut : { ...signedOut, connected: true })
  const read = Promise.withResolvers<CodexBackendView>()
  const models = Promise.withResolvers<CodexBackendModelView[]>()
  if (stage === 'read') f.backend.getState.mockImplementation(() => read.promise)
  if (stage === 'refresh') f.backend.refresh.mockImplementation(() => read.promise)
  if (stage === 'catalog') f.backend.models.mockImplementation(() => models.promise)
  // Restart the effect with this scripted native reader before its queued read settles.
  f.rerender(<CodexBackendCard operations={{ ...f.operations, codexBackend: { ...f.backend } }} onSaved={f.onSaved} t={t} />)
  await act(async () => {})
  f.unmount()
  await act(async () => { read.resolve({ ...signedOut, connected: true }); models.resolve([sol]) })
  expect(f.container.textContent).toBe('')
  expect(f.onSaved).not.toHaveBeenCalled()
})
it.each([false, true])('reports mount failures only while mounted (closed=%s)', async (closed) => {
  const f = fixture()
  const failed = Promise.withResolvers<CodexBackendModelView[]>()
  f.backend.models.mockImplementation(() => failed.promise)
  await act(async () => {})
  if (closed) f.unmount()
  await act(async () => { failed.reject(new Error('Native catalog unavailable')) })
  if (closed) expect(f.container.textContent).toBe('')
  else expect(screen.getByRole('status').textContent).toBe(en.codexFailed)
  expect(f.onSaved).not.toHaveBeenCalled()
})
it('keeps a chosen processing model through refresh and replaces withdrawn catalog choices', async () => {
  const other = { ...sol, id: 'other', name: 'Other' }
  const f = fixture(undefined, [sol, other]); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.codexProcessingModel }))
  const model = screen.getByLabelText<HTMLSelectElement>(en.codexProcessingModel)
  fireEvent.change(model, { target: { value: 'other' } })
  fireEvent.click(screen.getByRole('button', { name: en.codexRefresh }))
  await waitFor(() => { expect(f.onSaved).toHaveBeenCalledTimes(1) })
  expect(model.value).toBe('other')
  f.setModels([sol]); fireEvent.click(screen.getByRole('button', { name: en.codexRefresh }))
  await waitFor(() => { expect(model.value).toBe('sol') })
  f.setModels([]); fireEvent.click(screen.getByRole('button', { name: en.codexRefresh }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: en.codexProcessingModel })).toBeNull() })
  expect(f.onSaved).toHaveBeenCalledTimes(3)
})
it('retains the selected model when the native reader is replaced', async () => {
  const f = fixture(); await ready()
  f.rerender(<CodexBackendCard operations={{ ...f.operations, codexBackend: { ...f.backend } }} onSaved={f.onSaved} t={t} />)
  await waitFor(() => { expect(f.backend.models).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByRole('button', { name: en.codexProcessingModel }))
  expect(screen.getByLabelText<HTMLSelectElement>(en.codexProcessingModel).value).toBe('sol')
})
it('shows a disabled status after the user disables native requests', async () => {
  const f = fixture({ ...signedOut, connected: true, enabled: true }); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.codexDisable }))
  await screen.findByText(en.codexDisabled)
  expect(screen.getByRole('button', { name: en.codexEnable })).toBeDefined()
  expect(f.backend.configure.mock.calls).toEqual([[false, undefined, undefined]])
  expect(f.onSaved).toHaveBeenCalledOnce()
})
it.each([false, true])('shows account status without editor controls when collapsed (connected=%s)', async (connected) => {
  const f = fixture({ ...signedOut, connected }, [], false)
  await waitFor(() => { expect(f.backend.models).toHaveBeenCalledOnce() })
  expect(screen.getByText(connected ? en.statusConnected : en.statusSignedOut)).toBeDefined()
  expect(screen.queryByRole('button')).toBeNull()
})
it('uses localized feedback when native refresh rejects without an Error', async () => {
  const f = fixture(); await ready()
  f.backend.refresh.mockRejectedValueOnce('offline')
  fireEvent.click(screen.getByRole('button', { name: en.codexRefresh }))
  expect((await screen.findByRole('status')).textContent).toBe(en.codexFailed)
  expect(f.onSaved).not.toHaveBeenCalled()
})
it.each([false, true])('handles a polling failure without reviving a closed card (closed=%s)', async (closed) => {
  const f = fixture(); await ready()
  const reply = Promise.withResolvers<CodexBackendView>()
  f.backend.getState.mockResolvedValueOnce({ ...signedOut, busy: true }).mockImplementationOnce(() => reply.promise)
  start(); await screen.findByText('LOCAL-CODE')
  if (closed) f.unmount()
  await act(async () => { reply.reject(new Error('Status unavailable')) })
  if (closed) expect(f.container.textContent).toBe('')
  else {
    expect(screen.getByRole('status').textContent).toBe(en.codexFailed)
    expect(screen.queryByText('LOCAL-CODE')).toBeNull()
  }
  expect(f.onSaved).not.toHaveBeenCalled()
})
it('discards a polling read that completes after closure', async () => {
  const f = fixture(); await ready()
  const reply = Promise.withResolvers<CodexBackendView>()
  f.backend.getState.mockResolvedValueOnce({ ...signedOut, busy: true }).mockImplementationOnce(() => reply.promise)
  start(); await screen.findByText('LOCAL-CODE'); f.unmount()
  await act(async () => { reply.resolve({ ...signedOut, connected: true }) })
  expect(f.backend.refresh).not.toHaveBeenCalled()
  expect(f.onSaved).not.toHaveBeenCalled()
})
it('does not publish a completed sign-in after its catalog reply arrives on a closed card', async () => {
  const f = fixture(); await ready()
  const reply = Promise.withResolvers<CodexBackendModelView[]>()
  f.backend.models.mockImplementationOnce(() => reply.promise)
  start(); await waitFor(() => { expect(f.backend.models).toHaveBeenCalledTimes(2) })
  f.unmount(); await act(async () => { reply.resolve([sol]) })
  expect(f.onSaved).not.toHaveBeenCalled()
})
it('completes sign-in even when the account has no selectable native models', async () => {
  const f = fixture(); await ready(); f.setModels([])
  start(); await waitFor(() => { expect(f.onSaved).toHaveBeenCalledOnce() })
  expect(screen.queryByText('LOCAL-CODE')).toBeNull()
  expect(screen.queryByRole('button', { name: en.codexProcessingModel })).toBeNull()
})
it('hides processing choices when the select no longer has a selected catalog entry', async () => {
  fixture(); await ready()
  fireEvent.click(screen.getByRole('button', { name: en.codexProcessingModel }))
  const model = screen.getByLabelText<HTMLSelectElement>(en.codexProcessingModel)
  model.selectedIndex = -1
  fireEvent.change(model)
  expect(screen.queryByLabelText(en.codexProcessing)).toBeNull()
  expect(screen.queryByRole('button', { name: en.codexApplyProcessing })).toBeNull()
})
