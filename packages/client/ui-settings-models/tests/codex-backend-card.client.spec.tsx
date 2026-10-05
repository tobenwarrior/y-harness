// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexBackendCard } from '../src/client/CodexBackendCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
function setup(connected = false, readOnly = false) {
  const models = [{ id: 'gpt-6.1-sol', name: 'Sol', description: 'Native', efforts: [{ id: 'ultra', description: 'Delegation' }], defaultEffort: 'ultra', serviceTiers: [{ id: 'fast', name: 'Fast', description: 'More usage' }] }]
  const state = { connected, enabled: false, busy: false, running: 0, tiers: {} }
  const backend = { getState: vi.fn(async () => state), models: vi.fn(async () => models), start: vi.fn(async () => ({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' })), cancel: vi.fn(), refresh: vi.fn(async () => state), disconnect: vi.fn(async () => state), configure: vi.fn(async () => ({ ...state, enabled: true })) }
  const onSaved = vi.fn()
  render(<CodexBackendCard operations={{ codexBackend: backend } as ModelsOperations} readOnly={readOnly} onSaved={onSaved} t={key => en[key]} />)
  return { backend, onSaved }
}
it('mounting reads cached state without starting Codex, sign-in requires consent', async () => {
 const { backend } = setup(); await screen.findByText('Sol'); expect(backend.refresh).not.toHaveBeenCalled(); expect(backend.start).not.toHaveBeenCalled()
 expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(true)
 fireEvent.click(screen.getByLabelText(en.codexStorage)); expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexContinue }).disabled).toBe(false)
})
it('discloses native loop, read-only policy and preserves real Ultra and Fast', async () => {
 const { backend } = setup(true); await screen.findByText('Sol'); expect(screen.getByText(en.codexPolicy)).toBeDefined(); expect(screen.getByText('ultra')).toBeDefined()
 const processing = screen.getByLabelText<HTMLSelectElement>(en.chatGPTProcessing); expect(processing.value).toBe('default')
 fireEvent.change(processing, { target: { value: 'fast' } }); fireEvent.click(screen.getByRole('button', { name: en.chatGPTApplyProcessing }))
 await waitFor(() => { expect(backend.configure).toHaveBeenCalledWith(false, 'gpt-6.1-sol', 'fast') })
})
it('disables all mutations in read-only settings', async () => {
 setup(true, true); await screen.findByText('Sol'); expect(screen.getByLabelText<HTMLInputElement>(en.codexStorage).disabled).toBe(true)
 expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexRefresh }).disabled).toBe(true)
 expect(screen.getByRole<HTMLButtonElement>('button', { name: en.codexEnable }).disabled).toBe(true)
})
it('enables only through an explicit user action and reloads selectable models', async () => {
 const { backend, onSaved } = setup(true); await screen.findByText('Sol'); fireEvent.click(screen.getByRole('button', { name: en.codexEnable }))
 await waitFor(() => { expect(backend.configure).toHaveBeenCalledWith(true, undefined, undefined) }); expect(onSaved).toHaveBeenCalled()
})
