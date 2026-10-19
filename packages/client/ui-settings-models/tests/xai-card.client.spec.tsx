// @vitest-environment jsdom
/** User-visible xAI subscription device connection and Grok model publication. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView, XaiConnectionView, XaiModelView } from '@deepseek-ai/dsh-api-remotes/client'
import { XaiCard } from '../src/client/XaiCard.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: keyof typeof en): string => en[key]
const namespace: SettingsNamespaceView = { ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, revision: 3, autoGenerate: true, applies: 'live', secrets: [] }
const catalog: XaiModelView[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', contextWindow: 500000, maxTokens: 500000, inputModalities: ['text', 'image'], reasoning: true, reasoningEfforts: { low: 'low', high: 'high' } },
  { id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 500000, maxTokens: 500000, inputModalities: ['text', 'image'], reasoning: true, reasoningEfforts: { low: 'low', high: 'high', xhigh: 'xhigh' } },
]
function fixture(
  view: XaiConnectionView = { configured: true, connected: false, busy: false },
  withXai = true,
) {
  const xai = {
    getState: vi.fn(async () => view),
    start: vi.fn(async () => ({ url: 'https://x.ai/activate', code: 'ABCD-1234', expiresAt: Date.now() + 600_000 })),
    finish: vi.fn(async (_signal: AbortSignal) => ({ configured: true, connected: true, busy: false })),
    models: vi.fn(async () => catalog),
    cancel: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  }
  const writeSettings = vi.fn<ModelsOperations['writeSettings']>(async () => ({ kind: 'written', view: namespace }))
  const operations: ModelsOperations = { ...(withXai ? { xai } : {}),
    describeCredential: vi.fn(async () => undefined), storeCredential: vi.fn(async () => undefined),
    removeCredential: vi.fn(async () => undefined),
    writeSettings,
    discoverModels: vi.fn(async () => ({ kind: 'found' as const, models: [] })),
  }
  const onSaved = vi.fn()
  return { xai, operations, onSaved, writeSettings }
}

it('keeps xAI sign-in dormant until the user consents to local token storage', async () => {
  const f = fixture()
  render(<XaiCard {...f} namespace={namespace} t={t} />)
  await screen.findByText(en.statusSignedOut)
  expect(screen.getByRole('button', { name: en.xaiContinue }).hasAttribute('disabled')).toBe(true)
  expect(f.xai.start).not.toHaveBeenCalled()
  expect(f.xai.models).not.toHaveBeenCalled()
  expect(f.writeSettings).not.toHaveBeenCalled()
})

it('publishes the whole installed catalog as the starter selection once connected', async () => {
  const f = fixture({ configured: true, connected: true, busy: false })
  render(<XaiCard {...f} namespace={namespace} t={t} />)
  await screen.findByText(en.statusConnected)
  await screen.findByText(en.xaiAdded)
  expect(f.xai.models).toHaveBeenCalled()
  expect(f.writeSettings).toHaveBeenCalledWith('llm-pi-ai',
    [{ op: 'set', path: ['providers', 'xai'], value: expect.objectContaining({ displayName: 'xAI' }) }],
    namespace.revision)
  const written = f.writeSettings.mock.calls[0]?.[1][0]
  if (written?.op !== 'set') throw new Error('Expected saved xAI settings')
  const ids = (written.value as { models: Array<{ id: string }> }).models.map(model => model.id)
  expect(ids).toEqual(['grok-4.6', 'grok-4.7'])
})

it('returns null without the xai service or settings namespace', async () => {
  const f = fixture()
  const noService = render(<XaiCard operations={fixture(undefined, false).operations} namespace={namespace} onSaved={f.onSaved} t={t} />)
  expect(noService.container.innerHTML).toBe('')
  noService.unmount()
  const noNamespace = render(<XaiCard {...f} namespace={undefined} t={t} />)
  expect(noNamespace.container.innerHTML).toBe('')
})
