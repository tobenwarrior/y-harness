// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexBackendCard } from '../src/client/CodexBackendCard.tsx'
import type { CodexBackendModelView, CodexBackendView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
function setup(connected = false, readOnly = false, detected: Partial<CodexBackendView> = {}) {
  const models = [{ id: 'gpt-6.1-sol', name: 'Sol', description: 'Native', efforts: [{ id: 'ultra', description: 'Delegation' }], defaultEffort: 'ultra', serviceTiers: [{ id: 'fast', name: 'Fast', description: 'More usage' }], inputModalities: ['text', 'image'] }]
  const state = { connected, enabled: false, busy: false, running: 0, tiers: {} }
  const scanned = { ...state, ...detected }
  const backend = { getState: vi.fn(async () => state), models: vi.fn(async () => models), start: vi.fn(async () => ({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' })), cancel: vi.fn(), refresh: vi.fn(async () => scanned), disconnect: vi.fn(async () => state), configure: vi.fn(async () => ({ ...state, enabled: true })),
    // Publishing succeeds only for the accounts a native read finds connected.
    publish: vi.fn(async () => (detected.connected === true ? { ...scanned, enabled: true } : scanned)) }
  const onSaved = vi.fn()
  render(<CodexBackendCard operations={{ codexBackend: backend } as Pick<ModelsOperations, 'codexBackend'> as ModelsOperations} readOnly={readOnly}
    onSaved={onSaved} t={key => en[key]} />)
  return { backend, onSaved }
}
it('mounting a connected account reads cached state, publishes it, and still requires consent to sign in again', async () => {
  const { backend } = setup(true); await screen.findByRole('button', { name: en.codexProcessingModel }); expect(backend.refresh).not.toHaveBeenCalled(); expect(backend.publish).toHaveBeenCalledOnce()
  expect(backend.start).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(en.codexStorage)); expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(false)
})
it('detects a stored sign-in on mount and publishes its catalog without an explicit enable', async () => {
  const { backend } = setup(false, false, { connected: true }); await screen.findByRole('button', { name: en.codexProcessingModel })
  await waitFor(() => { expect(backend.refresh).toHaveBeenCalledOnce() })
  expect(backend.publish).toHaveBeenCalledOnce()
  expect(backend.configure).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.codexDisable })).toBeDefined()
})
it('discloses native loop, read-only policy and preserves real Ultra and Fast', async () => {
  const { backend } = setup(true); await screen.findByRole('button', { name: en.codexProcessingModel })
  expect(screen.queryByText(en.codexPolicy)).toBeNull()
  fireEvent.click(screen.getByText(en.codexDetails))
  expect(screen.getByText(en.codexPolicy)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: en.codexProcessingModel }))
  expect(screen.getByText('ultra')).toBeDefined()
  const processing = screen.getByLabelText<HTMLSelectElement>(en.codexProcessing); expect(processing.value).toBe('default')
  fireEvent.change(processing, { target: { value: 'fast' } }); fireEvent.click(screen.getByRole('button', { name: en.codexApplyProcessing }))
  await waitFor(() => { expect(backend.configure).toHaveBeenCalledWith(false, 'gpt-6.1-sol', 'fast') })
})
it('disables all mutations in read-only settings and never publishes from there', async () => {
  const { backend } = setup(true, true); await screen.findByRole('button', { name: en.codexProcessingModel }); expect(screen.getByLabelText<HTMLInputElement>(en.codexStorage).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexRefresh }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexEnable }).disabled).toBe(true)
  expect(backend.refresh).not.toHaveBeenCalled()
  expect(backend.publish).not.toHaveBeenCalled()
})
it('enables only through an explicit user action and reloads selectable models', async () => {
  const { backend, onSaved } = setup(true); await screen.findByRole('button', { name: en.codexProcessingModel }); fireEvent.click(screen.getByRole('button', { name: en.codexEnable }))
  await waitFor(() => { expect(backend.configure).toHaveBeenCalledWith(true, undefined, undefined) }); expect(onSaved).toHaveBeenCalled()
})
it('updates connected status after a slow native refresh completes sign-in', async () => {
  const { backend } = setup(true)
  const refreshed = Promise.withResolvers<Awaited<ReturnType<typeof backend.refresh>>>()
  backend.refresh.mockImplementation(() => refreshed.promise)
  backend.getState.mockResolvedValue({ enabled: false, connected: true, busy: false, running: 0, tiers: {} })
  await screen.findByRole('button', { name: en.codexProcessingModel })
  fireEvent.click(screen.getByLabelText(en.codexStorage))
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await waitFor(() => { expect(backend.refresh).toHaveBeenCalled() })
  refreshed.resolve({ enabled: false, connected: true, busy: false, running: 0, tiers: {} })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexEnable }).disabled).toBe(false) })
})

type NativeBackend = NonNullable<ModelsOperations['codexBackend']>
const nativeCopy = (key: keyof typeof en): string => en[key]
function nativeRecoverySetup(initial: CodexBackendView, readOnly = false) {
  let current = initial
  const catalog: CodexBackendModelView[] = [{
    id: 'gpt-6.1-sol', name: 'Sol', description: 'Native',
    efforts: [{ id: 'ultra', description: 'Delegation' }], defaultEffort: 'ultra',
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'More usage' }],
    inputModalities: ['text', 'image'],
  }]
  const backend = {
    getState: vi.fn<NativeBackend['getState']>(async () => current),
    models: vi.fn<NativeBackend['models']>(async () => catalog),
    start: vi.fn<NativeBackend['start']>(async () => ({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'FIRST-CODE' })),
    cancel: vi.fn<NativeBackend['cancel']>(async () => {}),
    refresh: vi.fn<NativeBackend['refresh']>(async () => current),
    publish: vi.fn<NativeBackend['publish']>(async () => current),
    disconnect: vi.fn<NativeBackend['disconnect']>(async () => current),
    configure: vi.fn<NativeBackend['configure']>(async () => current),
  }
  const operations: ModelsOperations = {
    codexBackend: backend,
    describeCredential: async () => undefined,
    storeCredential: async () => undefined,
    removeCredential: async () => undefined,
    writeSettings: async () => ({ kind: 'refused', message: 'Unexpected settings write' }),
    discoverModels: async () => ({ kind: 'found', models: [] }),
  }
  const onSaved = vi.fn()
  render(<CodexBackendCard operations={operations} readOnly={readOnly} onSaved={onSaved} t={nativeCopy} />)
  return { backend, onSaved, setState: (next: CodexBackendView): void => { current = next } }
}
const nativeSignedOut: CodexBackendView = { connected: false, enabled: false, busy: false, running: 0, tiers: {} }

it('keeps native sign-in retryable when creating a device code fails', async () => {
  const { backend, setState } = nativeRecoverySetup(nativeSignedOut)
  backend.start.mockRejectedValueOnce(new Error('Codex device login unavailable'))
  await screen.findByRole('button', { name: en.codexProcessingModel })
  fireEvent.click(screen.getByLabelText(en.codexStorage))
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await screen.findByRole('status')
  expect(screen.getByRole('status').textContent).toContain('Codex device login unavailable')
  expect(screen.queryByRole('link', { name: en.codexOpen })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(false)
  setState({ ...nativeSignedOut, busy: true })
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await screen.findByRole('link', { name: en.codexOpen })
  expect(screen.getByText('FIRST-CODE')).toBeDefined()
  expect(screen.queryByRole('status')).toBeNull()
  expect(backend.start.mock.calls).toEqual([[true], [true]])
  expect(backend.configure).not.toHaveBeenCalled()
})

it('clears an expired native code and offers a fresh sign-in attempt', async () => {
  const { backend, setState } = nativeRecoverySetup(nativeSignedOut)
  await screen.findByRole('button', { name: en.codexProcessingModel })
  fireEvent.click(screen.getByLabelText(en.codexStorage))
  setState({ ...nativeSignedOut, busy: true })
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await screen.findByText('FIRST-CODE')
  setState({ ...nativeSignedOut, error: 'Codex device code expired' })
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Codex device code expired') }, { timeout: 2_500 })
  expect(screen.queryByRole('link', { name: en.codexOpen })).toBeNull()
  expect(screen.queryByText('FIRST-CODE')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(false)
  backend.start.mockResolvedValueOnce({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'RETRY-CODE' })
  setState({ ...nativeSignedOut, busy: true })
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await screen.findByText('RETRY-CODE')
  expect(screen.queryByRole('status')).toBeNull()
  expect(backend.start.mock.calls).toEqual([[true], [true]])
  expect(backend.refresh).toHaveBeenCalledOnce()
})

it('reports native cancellation failure and allows cancellation to be retried', async () => {
  const { backend, setState } = nativeRecoverySetup(nativeSignedOut)
  backend.cancel.mockRejectedValueOnce(new Error('Codex cancellation RPC unavailable'))
  backend.cancel.mockImplementationOnce(async () => { setState(nativeSignedOut) })
  await screen.findByRole('button', { name: en.codexProcessingModel })
  fireEvent.click(screen.getByLabelText(en.codexStorage))
  setState({ ...nativeSignedOut, busy: true })
  fireEvent.click(screen.getByRole('button', { name: en.codexContinue }))
  await screen.findByText('FIRST-CODE')
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Codex cancellation RPC unavailable') })
  expect(screen.getByRole('link', { name: en.codexOpen })).toBeDefined()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  await waitFor(() => { expect(screen.queryByRole('link', { name: en.codexOpen })).toBeNull() })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: en.cancel })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(false)
  expect(backend.cancel).toHaveBeenCalledTimes(2)
  expect(backend.configure).not.toHaveBeenCalled()
})

it('preserves the connected native profile after a refused disconnect and retries cleanly', async () => {
  const { backend, onSaved } = nativeRecoverySetup({ ...nativeSignedOut, connected: true, enabled: true, label: 'Local Codex profile' })
  backend.disconnect.mockRejectedValueOnce(new Error('Codex disconnect RPC unavailable'))
  backend.disconnect.mockResolvedValueOnce(nativeSignedOut)
  await screen.findByRole('button', { name: en.codexProcessingModel })
  fireEvent.click(screen.getByRole('button', { name: en.codexDisconnect }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Codex disconnect RPC unavailable') })
  expect(screen.getByText('Local Codex profile')).toBeDefined()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexDisconnect }).disabled).toBe(false)
  expect(onSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.codexDisconnect }))
  await screen.findByText(en.codexSignedOut)
  expect(screen.queryByRole('button', { name: en.codexDisconnect })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexEnable }).disabled).toBe(true)
  expect(screen.queryByRole('status')).toBeNull()
  expect(onSaved).toHaveBeenCalledOnce()
  expect(backend.disconnect).toHaveBeenCalledTimes(2)
  expect(backend.start).not.toHaveBeenCalled()
  expect(backend.configure).not.toHaveBeenCalled()
})

it('prevents cancelling an already pending native sign-in in read-only settings', async () => {
  const { backend } = nativeRecoverySetup({ ...nativeSignedOut, busy: true }, true)
  await screen.findByRole('button', { name: en.codexProcessingModel })
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: en.cancel })
  expect(cancel.disabled).toBe(true)
  fireEvent.click(cancel)
  expect(backend.cancel).not.toHaveBeenCalled()
})
