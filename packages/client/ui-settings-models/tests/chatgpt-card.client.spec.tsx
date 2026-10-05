// @vitest-environment jsdom
/** Subscription consent, account isolation, and disconnect feedback in the real card. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGPTCard } from '../src/client/ChatGPTCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
const namespace = { revision: 1 } as SettingsNamespaceView
function setup(readOnly = false) {
  const connection = { getState: vi.fn(async () => ({ accounts: [{ id: 'one', label: 'person@example.test · client01', connected: true }], activeId: 'one', busy: false })), start: vi.fn(), finish: vi.fn(), cancel: vi.fn(), select: vi.fn(), models: vi.fn(async () => []), disconnect: vi.fn(async () => false) }
  const operations = { chatGPT: connection, writeSettings: vi.fn() } as Pick<ModelsOperations, 'chatGPT' | 'writeSettings'> as ModelsOperations
  render(<ChatGPTCard operations={operations} namespace={namespace} readOnly={readOnly} onSaved={() => {}} t={key => en[key]} />)
  return connection
}
it('requires storage consent before starting sign-in', async () => {
  const connection = setup()
  await screen.findByText('person@example.test · client01')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGPTContinue }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGPTContinue }).disabled).toBe(false)
  expect(connection.start).not.toHaveBeenCalled()
})
it('disables all credential changes in read-only settings', async () => {
  setup(true)
  await screen.findByText('person@example.test · client01')
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGPTContinue }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGPTDisconnect }).disabled).toBe(true)
})
it('disconnects only the selected account and explains unconfirmed remote revocation', async () => {
  const connection = setup()
  await screen.findByText('person@example.test · client01')
  fireEvent.click(screen.getByRole('button', { name: en.chatGPTDisconnect }))
  await waitFor(() => { expect(connection.disconnect).toHaveBeenCalledWith('one') })
  expect((await screen.findByText(en.chatGPTDisconnectedManual)).textContent).toBe(en.chatGPTDisconnectedManual)
})

it('offers only advertised Fast tiers, starts on Standard and shows usage before applying', async () => {
  const model = { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', reasoningEfforts: { low: 'low', high: 'high', max: 'max' }, unavailableReasoningEfforts: ['ultra'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }
  const writeSettings = vi.fn(async () => ({ kind: 'written' as const, view: namespace }))
  const connection = { getState: vi.fn(async () => ({ accounts: [], activeId: 'one', busy: false })), models: vi.fn(async () => [model]), start: vi.fn(), finish: vi.fn(), cancel: vi.fn(), select: vi.fn(), disconnect: vi.fn() }
  const configured = { revision: 3, value: { providers: { chatgpt: { models: [model] } } } } as SettingsNamespaceView
  render(<ChatGPTCard operations={{ chatGPT: connection, writeSettings } as ModelsOperations}
    namespace={configured} onSaved={() => {}} t={key => en[key]} />)
  const processing = await screen.findByLabelText<HTMLSelectElement>(en.chatGPTProcessing)
  expect(processing.value).toBe('default')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.chatGPTApplyProcessing }).disabled).toBe(true)
  expect(screen.getByText(en.chatGPTUltraUnavailable)).toBeDefined()
  expect(screen.getByText(en.chatGPTSolUnavailable)).toBeDefined()
  fireEvent.change(processing, { target: { value: 'priority' } })
  expect(screen.getByText(/Fast increases ChatGPT plan usage/)).toBeDefined()
  expect(writeSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.chatGPTApplyProcessing }))
  await waitFor(() => {
    expect(writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'chatgpt', 'models', '0', 'serviceTier'], value: 'priority' }], 3)
  })
})
