// @vitest-environment jsdom
/** Account catalog refresh and cancellation preserve visible state and fenced choices. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NousConnectionView, NousDeviceVerification, NousModelView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { NousCard } from '../src/client/NousCard.tsx'
import { NousModelPicker } from '../src/client/NousModelPicker.tsx'
import { countCopy } from '../src/client/nous-models.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
const t = (key: keyof typeof en): string => en[key]
const disconnected: NousConnectionView = { configured: true, connected: false, busy: false }
const namespace: SettingsNamespaceView = { ns: 'llm-pi-ai', schema: {}, value: { providers: { nous: { models: [{ id: 'sol' }] } } }, revision: 3, autoGenerate: true, applies: 'live', secrets: [] }
const sol: NousModelView = { id: 'sol', name: 'OpenAI: Sol', reasoning: false }
const emptyNamespace: SettingsNamespaceView = { ...namespace, value: { providers: {} } }
const instructions: NousDeviceVerification = { url: 'https://example.test/device', code: 'LOCAL-CODE', expiresAt: 1_000 }
const base: ModelsOperations = { describeCredential: async () => undefined, storeCredential: async () => undefined, removeCredential: async () => undefined, writeSettings: async () => ({ kind: 'written', view: namespace }), discoverModels: async () => ({ kind: 'found', models: [] }) }
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function fixture(initial: NousConnectionView = { ...disconnected, connected: true }, saved = namespace, open = true) {
  let state = initial
  let catalog = [sol]
  const nous = {
    getState: vi.fn<NonNullable<ModelsOperations['nous']>['getState']>(async () => state),
    start: vi.fn<NonNullable<ModelsOperations['nous']>['start']>(async () => instructions),
    finish: vi.fn<NonNullable<ModelsOperations['nous']>['finish']>(async () => ({ ...disconnected, connected: true })),
    models: vi.fn<NonNullable<ModelsOperations['nous']>['models']>(async () => catalog),
    cancel: vi.fn<NonNullable<ModelsOperations['nous']>['cancel']>(async () => {}),
    disconnect: vi.fn<NonNullable<ModelsOperations['nous']>['disconnect']>(async () => { state = disconnected }),
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view: namespace }))
  const operations = { ...base, nous, writeSettings }
  const onSaved = vi.fn()
  const view = render(<NousCard operations={operations} namespace={saved} t={t} onSaved={onSaved} open={open} />)
  return { ...view, nous, operations, writeSettings, onSaved,
    setState: (next: NousConnectionView): void => { state = next },
    setModels: (next: NousModelView[]): void => { catalog = next } }
}
async function ready(): Promise<void> { await screen.findByText(countCopy(en.nousModelsSummary, { enabled: 1, total: 1 })) }
function start(): void { fireEvent.click(screen.getByLabelText(en.nousStorage)); fireEvent.click(screen.getByRole('button', { name: en.nousContinue })) }

it('omits native account controls when the namespace or connection is unavailable', () => {
  const view = render(<NousCard operations={base} namespace={namespace} t={t} onSaved={() => {}} />)
  expect(view.container.textContent).toBe('')
  const nous = { getState: async () => disconnected, start: async () => instructions, finish: async () => disconnected,
    models: async () => [], cancel: async () => {}, disconnect: async () => {} }
  view.rerender(<NousCard operations={{ ...base, nous }} namespace={undefined} t={t} onSaved={() => {}} />)
  expect(view.container.textContent).toBe('')
})
it.each(['resolve', 'reject'] as const)('discards a state read after closure (%s)', async (outcome) => {
  const f = fixture(disconnected)
  const reply = Promise.withResolvers<NousConnectionView>()
  f.nous.getState.mockImplementation(() => reply.promise)
  f.rerender(<NousCard operations={{ ...f.operations, nous: { ...f.nous } }} namespace={namespace} t={t} onSaved={f.onSaved} />)
  f.unmount()
  await act(async () => { if (outcome === 'resolve') reply.resolve({ ...disconnected, connected: true }); else reply.reject(new Error('Offline')) })
  expect(f.nous.models).not.toHaveBeenCalled()
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('reports an initial native state refusal without enabling mutations implicitly', async () => {
  const f = fixture(disconnected)
  f.nous.getState.mockRejectedValueOnce(new Error('Offline'))
  f.rerender(<NousCard operations={{ ...f.operations, nous: { ...f.nous } }} namespace={namespace} t={t} onSaved={f.onSaved} />)
  expect((await screen.findByRole('status')).textContent).toBe(en.nousFailed)
  expect(f.nous.start).not.toHaveBeenCalled()
})
it('discards the catalog when an account card closes during its read', async () => {
  const f = fixture()
  const reply = Promise.withResolvers<NousModelView[]>()
  f.nous.models.mockImplementationOnce(() => reply.promise)
  await waitFor(() => { expect(f.nous.models).toHaveBeenCalledOnce() })
  f.unmount(); await act(async () => { reply.resolve([sol]) })
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('keeps an empty native catalog visible without creating a provider profile', async () => {
  const f = fixture(undefined, emptyNamespace); f.setModels([])
  expect((await screen.findByRole('status')).textContent).toBe(en.nousNoModels)
  expect(f.writeSettings).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.nousManageModels }).disabled).toBe(true)
})
it('ignores a starter-profile write reply after its card closes', async () => {
  const f = fixture(undefined, emptyNamespace)
  const reply = Promise.withResolvers<Awaited<ReturnType<ModelsOperations['writeSettings']>>>()
  f.writeSettings.mockImplementationOnce(() => reply.promise)
  await waitFor(() => { expect(f.writeSettings).toHaveBeenCalledOnce() })
  f.unmount(); await act(async () => { reply.resolve({ kind: 'written', view: namespace }) })
  expect(f.onSaved).not.toHaveBeenCalled()
})
it('reports a refused starter-profile write and does not silently retry it on reload', async () => {
  const f = fixture(undefined, emptyNamespace)
  f.writeSettings.mockResolvedValueOnce({ kind: 'conflict', message: 'Settings changed elsewhere' })
  await screen.findByText('Settings changed elsewhere')
  f.rerender(<NousCard operations={f.operations} namespace={{ ...emptyNamespace, revision: 4 }} t={t} onSaved={f.onSaved} />)
  await waitFor(() => { expect(f.nous.models).toHaveBeenCalledTimes(2) })
  expect(f.writeSettings).toHaveBeenCalledOnce()
  expect(f.onSaved).not.toHaveBeenCalled()
})
it.each([new Error('Catalog offline'), 'offline'])('renders an active catalog failure using its supported diagnostic (%s)', async (error) => {
  const f = fixture(); f.nous.models.mockRejectedValueOnce(error)
  expect((await screen.findByRole('status')).textContent).toBe(error instanceof Error ? error.message : en.nousFailed)
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('does not report a catalog failure after the card closes', async () => {
  const f = fixture(); const reply = Promise.withResolvers<NousModelView[]>()
  f.nous.models.mockImplementationOnce(() => reply.promise)
  await waitFor(() => { expect(f.nous.models).toHaveBeenCalledOnce() })
  f.unmount(); await act(async () => { reply.reject(new Error('Late catalog failure')) })
  expect(f.container.textContent).toBe('')
})
it('refreshes the account catalog and prunes withdrawn selections without writing settings', async () => {
  const f = fixture(); await ready()
  f.setModels([{ ...sol, id: 'other', name: 'Other: Model' }])
  fireEvent.click(screen.getByRole('button', { name: en.nousRefreshModels }))
  await screen.findByText(countCopy(en.nousModelsSummary, { enabled: 0, total: 1 }))
  fireEvent.click(screen.getByRole('button', { name: en.nousManageModels }))
  expect(screen.getByText('Other')).toBeDefined()
  expect(screen.getByLabelText<HTMLInputElement>('Model').checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  f.setModels([]); fireEvent.click(screen.getByRole('button', { name: en.nousRefreshModels }))
  await screen.findByText(en.nousNoModels)
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('treats malformed persisted model ids as absent while preserving valid selections', async () => {
  fixture(undefined, { ...namespace, value: { providers: { nous: { models: [{ id: 4 }, null, { id: 'sol' }] } } } })
  await ready()
  fireEvent.click(screen.getByRole('button', { name: en.nousManageModels }))
  expect(screen.getByLabelText<HTMLInputElement>('Sol').checked).toBe(true)
})
it.each([new Error('Device code refused'), 'offline'])('keeps sign-in retryable after a start refusal (%s)', async (error) => {
  const f = fixture(disconnected); f.nous.start.mockRejectedValueOnce(error)
  start()
  expect((await screen.findByRole('status')).textContent).toBe(error instanceof Error ? error.message : en.nousFailed)
  expect(screen.queryByText('LOCAL-CODE')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.nousContinue }).disabled).toBe(false)
})
it.each([{ ...disconnected, error: 'Device code expired' }, disconnected])('does not present a refused finish as a connected account (%j)', async (next) => {
  const f = fixture(disconnected); f.nous.finish.mockResolvedValueOnce(next)
  start()
  expect((await screen.findByRole('status')).textContent).toBe(next.error ?? en.nousFailed)
  expect(screen.queryByText('LOCAL-CODE')).toBeNull()
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('cancels instructions that arrive after closure and never begins finish polling', async () => {
  const f = fixture(disconnected); const reply = Promise.withResolvers<NousDeviceVerification>()
  f.nous.start.mockImplementationOnce(() => reply.promise)
  start(); await waitFor(() => { expect(f.nous.start).toHaveBeenCalledOnce() }); f.unmount()
  await act(async () => { reply.resolve(instructions) })
  expect(f.nous.cancel).toHaveBeenCalledTimes(2)
  expect(f.nous.finish).not.toHaveBeenCalled()
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('aborts pending authorization on closure even when host cancellation refuses', async () => {
  const f = fixture(disconnected); const reply = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => reply.promise); f.nous.cancel.mockRejectedValueOnce(new Error('Host disposed'))
  start(); await screen.findByText('LOCAL-CODE')
  const signal = f.nous.finish.mock.calls[0]?.[0]
  f.unmount(); await act(async () => { reply.resolve({ ...disconnected, connected: true }) })
  expect(signal?.aborted).toBe(true)
  expect(f.writeSettings).not.toHaveBeenCalled()
})
it('disconnects a newly published account whose namespace has no saved selection', async () => {
  const f = fixture(undefined, emptyNamespace); await screen.findByText(en.nousAdded)
  fireEvent.click(screen.getByRole('button', { name: en.nousDisconnect }))
  await screen.findByText(en.nousDisconnected)
  expect(f.writeSettings).toHaveBeenCalledOnce()
  expect(f.onSaved).toHaveBeenCalledOnce()
})
it('shows a native cancellation diagnostic while authorization is pending', async () => {
  const f = fixture(disconnected); const finish = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => finish.promise)
  start(); await screen.findByText('LOCAL-CODE')
  f.setState({ ...disconnected, error: 'Cancelled at host' })
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  await screen.findByText('Cancelled at host')
  await act(async () => { finish.resolve(disconnected) })
})
it('reports a cancellation RPC failure and leaves the active code available', async () => {
  const f = fixture(disconnected); const finish = Promise.withResolvers<NousConnectionView>()
  f.nous.finish.mockImplementationOnce(() => finish.promise); f.nous.cancel.mockRejectedValueOnce(new Error('Offline'))
  start(); await screen.findByText('LOCAL-CODE'); fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect((await screen.findByRole('status')).textContent).toBe(en.nousFailed)
  expect(screen.getByText('LOCAL-CODE')).toBeDefined()
  await act(async () => { finish.resolve(disconnected) })
})
it('discards a cancellation reply after the authorization owner closes', async () => {
  const f = fixture(disconnected); const finish = Promise.withResolvers<NousConnectionView>()
  const cancelled = Promise.withResolvers<undefined>()
  f.nous.finish.mockImplementationOnce(() => finish.promise); f.nous.cancel.mockImplementationOnce(() => cancelled.promise)
  start(); await screen.findByText('LOCAL-CODE'); fireEvent.click(screen.getByRole('button', { name: en.cancel })); f.unmount()
  await act(async () => { cancelled.resolve(undefined); finish.resolve(disconnected) })
  expect(f.container.textContent).toBe('')
  expect(f.onSaved).not.toHaveBeenCalled()
})
it.each([false, true])('shows connection state without opening the collapsed editor (connected=%s)', async (connected) => {
  const f = fixture({ ...disconnected, connected }, namespace, false)
  await waitFor(() => { expect(f.nous.getState).toHaveBeenCalledOnce() })
  expect(screen.getByText(connected ? en.statusConnected : en.statusSignedOut)).toBeDefined()
  expect(screen.queryByRole('button')).toBeNull()
})
it('groups advertised vendor models and saves their exact selected ids', async () => {
  const saved: string[][] = []
  render(<NousModelPicker models={[sol, { ...sol, id: 'other', name: 'Unbranded' }]} selected={[]} t={t} onSave={async (ids) => { saved.push(ids); return true }} onClose={() => {}} />)
  expect(screen.getByText('OpenAI')).toBeDefined(); expect(screen.getByText(en.nousOtherVendor)).toBeDefined()
  fireEvent.click(screen.getByLabelText('Sol')); fireEvent.click(screen.getByRole('button', { name: en.apply }))
  await waitFor(() => { expect(saved).toEqual([['sol']]) })
})
