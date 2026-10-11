// @vitest-environment jsdom
/** Repeated activation retains the single authorization attempt owned by the card. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NousConnectionView, NousDeviceVerification, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { NousCard } from '../src/client/NousCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const signedOut: NousConnectionView = { configured: true, connected: false, busy: false }
const namespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, revision: 3,
  autoGenerate: true, applies: 'live', secrets: [],
}
it('retains the first device attempt through same-batch repeated clicks and cancels it on closure', async () => {
  const instructions = Promise.withResolvers<NousDeviceVerification>()
  const completion = Promise.withResolvers<NousConnectionView>()
  const nous = {
    getState: vi.fn<NonNullable<ModelsOperations['nous']>['getState']>(async () => signedOut),
    // The real Host admits one attempt and refuses another until it settles.
    start: vi.fn<NonNullable<ModelsOperations['nous']>['start']>()
      .mockImplementationOnce(() => instructions.promise)
      .mockRejectedValue(new Error('A Nous sign-in is already in progress.')),
    finish: vi.fn<NonNullable<ModelsOperations['nous']>['finish']>(() => completion.promise),
    cancel: vi.fn<NonNullable<ModelsOperations['nous']>['cancel']>(async () => {}),
    models: vi.fn<NonNullable<ModelsOperations['nous']>['models']>(async () => []),
    disconnect: vi.fn<NonNullable<ModelsOperations['nous']>['disconnect']>(async () => {}),
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view: namespace }))
  const onSaved = vi.fn()
  const operations: ModelsOperations = { nous, writeSettings,
    describeCredential: async () => undefined, storeCredential: async () => undefined, removeCredential: async () => undefined,
    discoverModels: async () => ({ kind: 'found', models: [] }),
  }
  const view = render(<NousCard operations={operations} namespace={namespace} t={t} onSaved={onSaved} />)
  fireEvent.click(screen.getByLabelText(en.nousStorage))
  const signIn = screen.getByRole<HTMLButtonElement>('button', { name: en.nousContinue })
  await act(async () => { signIn.click(); signIn.click() })
  expect(nous.start).toHaveBeenCalledExactlyOnceWith(true)
  expect(nous.finish).not.toHaveBeenCalled()
  expect(signIn.disabled).toBe(true)
  expect(screen.getByRole('button', { name: en.cancel })).toBeDefined()
  await act(async () => { instructions.resolve({ url: 'https://example.test/first', code: 'FIRST-CODE', expiresAt: 1_000 }) })
  expect(screen.getByText('FIRST-CODE')).toBeDefined()
  expect(screen.queryByRole('status')).toBeNull()
  expect(signIn.disabled).toBe(true)
  expect(nous.finish).toHaveBeenCalledOnce()
  const firstSignal = nous.finish.mock.calls[0]?.[0]
  view.unmount()
  expect(firstSignal?.aborted).toBe(true)
  expect(nous.cancel).toHaveBeenCalledOnce()
  await act(async () => { completion.resolve({ ...signedOut, connected: true }) })
  expect(writeSettings).not.toHaveBeenCalled()
  expect(nous.models).not.toHaveBeenCalled()
  expect(onSaved).not.toHaveBeenCalled()
})
