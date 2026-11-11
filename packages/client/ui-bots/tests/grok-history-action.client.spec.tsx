// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotGrokHistoryArchive } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { GrokHistoryAction } from '../src/client/GrokHistoryAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const versionOneArchive = {
  source: 'grok-bot',
  version: 1,
  firstCachedSequence: 1,
  messages: [
    { sourceSequence: 1, role: 'user', text: 'Question from the first export', timestampMs: 1_700_000_000_000 },
    { sourceSequence: 2, role: 'assistant', text: 'Answer from the first export', timestampMs: 1_700_000_001_000 },
  ],
} as const satisfies BotGrokHistoryArchive

const versionTwoArchive = {
  source: 'grok-bot',
  version: 2,
  firstCachedSequence: 1,
  messages: [
    { sourceSequence: 1, role: 'user', text: 'Primary question', timestampMs: 1_700_000_000_000 },
    { sourceSequence: 2, role: 'assistant', text: 'Primary answer', timestampMs: null },
    { sourceSequence: 3, role: 'tool', text: '', timestampMs: null, incomplete: true },
    { sourceSequence: 4, role: 'assistant', text: 'Author-labelled answer', timestampMs: 1_700_000_002_000, author: 'Operator' },
    { sourceSequence: 5, role: 'assistant', text: 'Bot-attributed answer', timestampMs: 1_700_000_003_000, author: 'Operator', fromBot: 'Grok' },
    { sourceSequence: 6, role: 'user', text: 'Matching attribution', timestampMs: 1_700_000_004_000, author: 'Grok', fromBot: 'Grok' },
  ],
  sources: [
    {
      id: 'partial',
      label: 'Partial source',
      firstCachedSequence: 1,
      complete: false,
      messages: [{ sourceSequence: 1, role: 'user', text: 'Partial source question', timestampMs: null }],
    },
    {
      id: 'gap',
      label: 'Gap source',
      firstCachedSequence: 2,
      messages: [{ sourceSequence: 2, role: 'assistant', text: 'Gap source answer', timestampMs: 1_700_000_005_000 }],
    },
  ],
} as const satisfies BotGrokHistoryArchive

describe('GrokHistoryAction', () => {
  it('loads and displays a valid version-one archive, then closes and reopens it', async () => {
    const read = vi.fn<(id: string) => Promise<BotGrokHistoryArchive>>().mockResolvedValue(versionOneArchive)
    render(<GrokHistoryAction botId="bot-one" botName="Grok" read={read} t={t} />)

    expect(screen.queryByRole('button', { name: en.grokHistory })).toBeNull()
    const action = await screen.findByRole('button', { name: en.grokHistory })
    expect(read).toHaveBeenCalledWith('bot-one')

    fireEvent.click(action)
    expect(screen.getByRole('dialog', { name: en.grokHistory })).toBeTruthy()
    expect(screen.getByText(en.grokHistoryRecovered)).toBeTruthy()
    expect(screen.getByText(en.grokHistoryYou)).toBeTruthy()
    expect(screen.getAllByText('Grok')).not.toHaveLength(0)
    expect(screen.getByText('Question from the first export')).toBeTruthy()
    expect(screen.getByText('Answer from the first export')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByRole('listitem')[0]?.querySelectorAll('time')).toHaveLength(1)

    fireEvent.click(screen.getAllByRole('button', { name: en.close })[0]!)
    expect(screen.queryByRole('dialog', { name: en.grokHistory })).toBeNull()
    fireEvent.click(action)
    expect(screen.getByRole('dialog', { name: en.grokHistory })).toBeTruthy()
  })

  it('switches between complete and partial version-two sources and resets to primary', async () => {
    const read = vi.fn<(id: string) => Promise<BotGrokHistoryArchive>>().mockResolvedValue(versionTwoArchive)
    render(<GrokHistoryAction botId="bot-two" botName="Grok" read={read} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.grokHistory }))
    expect(screen.getByText(en.grokHistoryRecovered)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.grokHistorySource })).toBeTruthy()
    expect(screen.getByRole('option', { name: en.grokHistoryPrimary })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Partial source' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Gap source' })).toBeTruthy()
    expect(screen.getByText(en.grokHistoryYou)).toBeTruthy()
    expect(screen.getAllByText('Grok')).not.toHaveLength(0)
    expect(screen.getByText('tool')).toBeTruthy()
    expect(screen.getByText('Operator')).toBeTruthy()
    expect(screen.getByText('Author Operator')).toBeTruthy()
    expect(screen.getAllByText(en.grokHistoryUnknownTimestamp)).toHaveLength(2)
    expect(screen.getByText(en.grokHistoryIncomplete)).toBeTruthy()
    const emptyMessage = screen.getByText('tool').closest('li')
    expect(emptyMessage).not.toBeNull()
    expect((emptyMessage as HTMLElement).querySelector('p')).toBeNull()

    const source = screen.getByRole('combobox', { name: en.grokHistorySource })
    fireEvent.change(source, { target: { value: 'partial' } })
    expect(screen.getByText(en.grokHistoryPartial)).toBeTruthy()
    expect(screen.getByText('Partial source question')).toBeTruthy()
    expect(screen.queryByText('Primary question')).toBeNull()

    fireEvent.change(source, { target: { value: 'gap' } })
    expect(screen.getByText(en.grokHistoryPartial)).toBeTruthy()
    expect(screen.getByText('Gap source answer')).toBeTruthy()
    expect(screen.queryByText('Partial source question')).toBeNull()

    fireEvent.change(source, { target: { value: 'primary' } })
    expect(screen.getByText(en.grokHistoryRecovered)).toBeTruthy()
    expect(screen.getByText('Primary question')).toBeTruthy()

    fireEvent.change(source, { target: { value: 'gap' } })
    fireEvent.click(screen.getAllByRole('button', { name: en.close })[0]!)
    expect(screen.queryByRole('dialog', { name: en.grokHistory })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.grokHistory }))
    expect(screen.getByRole('combobox', { name: en.grokHistorySource })).toHaveProperty('value', 'primary')
    expect(screen.getByText(en.grokHistoryRecovered)).toBeTruthy()
    expect(screen.getByText('Primary question')).toBeTruthy()
  })

  it('stays unavailable when the archive is absent or the reader fails', async () => {
    const unavailable = vi.fn<(id: string) => Promise<BotGrokHistoryArchive | null>>().mockResolvedValue(null)
    const unavailableView = render(<GrokHistoryAction botId="missing" botName="Grok" read={unavailable} t={t} />)
    await waitFor(() => { expect(unavailable).toHaveBeenCalledWith('missing') })
    expect(screen.queryByRole('button', { name: en.grokHistory })).toBeNull()
    unavailableView.unmount()

    const failed = vi.fn<(id: string) => Promise<BotGrokHistoryArchive | null>>().mockRejectedValue(new Error('read failed'))
    render(<GrokHistoryAction botId="failed" botName="Grok" read={failed} t={t} />)
    await act(async () => { await Promise.resolve() })
    expect(failed).toHaveBeenCalledWith('failed')
    expect(screen.queryByRole('button', { name: en.grokHistory })).toBeNull()
  })

  it('ignores fulfilled and rejected reads that settle after unmount', async () => {
    const fulfilled = Promise.withResolvers<BotGrokHistoryArchive | null>()
    const staleSuccess = vi.fn<(id: string) => Promise<BotGrokHistoryArchive | null>>().mockReturnValue(fulfilled.promise)
    const successView = render(<GrokHistoryAction botId="stale-success" botName="Grok" read={staleSuccess} t={t} />)
    successView.unmount()
    await act(async () => {
      fulfilled.resolve(versionOneArchive)
      await fulfilled.promise
    })
    expect(screen.queryByRole('button', { name: en.grokHistory })).toBeNull()

    const rejected = Promise.withResolvers<BotGrokHistoryArchive | null>()
    const staleFailure = vi.fn<(id: string) => Promise<BotGrokHistoryArchive | null>>().mockReturnValue(rejected.promise)
    const failureView = render(<GrokHistoryAction botId="stale-failure" botName="Grok" read={staleFailure} t={t} />)
    failureView.unmount()
    await act(async () => {
      rejected.reject(new Error('late read failure'))
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: en.grokHistory })).toBeNull()
  })
})
