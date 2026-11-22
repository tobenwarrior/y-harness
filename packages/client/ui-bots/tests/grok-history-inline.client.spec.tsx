// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotGrokHistoryView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { GrokHistoryInline, type GrokHistoryInlineProps } from '../src/client/GrokHistoryInline.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const archive = {
  source: 'grok-bot',
  version: 2,
  firstCachedSequence: 1,
  messages: [
    { sourceSequence: 1, role: 'user', text: 'Recovered question', timestampMs: 1_700_000_000_000 },
    { sourceSequence: 2, role: 'assistant', text: 'Recovered answer', timestampMs: 1_700_000_001_000 },
  ],
  sources: [{
    id: 'partial',
    label: 'Partial recovery',
    firstCachedSequence: 1,
    complete: false,
    messages: [{ sourceSequence: 3, role: 'user', text: 'Partial question', timestampMs: null }],
  }],
} as const satisfies BotGrokHistoryView

function renderInline(botId: string, read: GrokHistoryInlineProps['read']) {
  return render(<GrokHistoryInline botId={botId} botName="Gammagod" read={read} t={t} />)
}

describe('Inline imported Bot chat', () => {
  it('does not read until opened and switches recovered sources in the live scroll', async () => {
    const read = vi.fn<GrokHistoryInlineProps['read']>().mockResolvedValue(archive)
    renderInline('bot-one', read)

    expect(read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineShow }))
    expect(read).toHaveBeenCalledWith('bot-one', expect.any(AbortSignal))
    expect(await screen.findByText('Recovered question')).toBeTruthy()
    expect(screen.getByText(en.grokHistoryRecovered)).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: en.grokHistorySource }), { target: { value: 'partial' } })
    expect(screen.getByText('Partial question')).toBeTruthy()
    expect(screen.getByText(en.grokHistoryPartial)).toBeTruthy()
    expect(screen.queryByText('Recovered question')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineHide }))
    expect(screen.queryByText('Partial question')).toBeNull()
  })

  it('aborts a stale read when the selected Bot changes and keeps the newer result', async () => {
    const first = Promise.withResolvers<BotGrokHistoryView | null>()
    const second = Promise.withResolvers<BotGrokHistoryView | null>()
    const signals: AbortSignal[] = []
    const read = vi.fn<GrokHistoryInlineProps['read']>((botId, signal) => {
      signals.push(signal!)
      return botId === 'bot-one' ? first.promise : second.promise
    })
    const view = renderInline('bot-one', read)
    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineShow }))
    expect(read).toHaveBeenCalledTimes(1)

    view.rerender(<GrokHistoryInline botId="bot-two" botName="Gammagod" read={read} t={t} />)
    expect(read).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)

    first.resolve({ ...archive, messages: [{ ...archive.messages[0], text: 'Stale answer' }] })
    second.resolve(archive)
    expect(await screen.findByText('Recovered answer')).toBeTruthy()
    expect(screen.queryByText('Stale answer')).toBeNull()
  })

  it('ignores a rejected read after the selected Bot changes', async () => {
    const first = Promise.withResolvers<BotGrokHistoryView | null>()
    const second = Promise.withResolvers<BotGrokHistoryView | null>()
    const read = vi.fn<GrokHistoryInlineProps['read']>(botId => botId === 'bot-one' ? first.promise : second.promise)
    const view = renderInline('bot-one', read)
    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineShow }))

    view.rerender(<GrokHistoryInline botId="bot-two" botName="Gammagod" read={read} t={t} />)
    first.reject(new Error('stale archive'))
    second.resolve(archive)

    expect(await screen.findByText('Recovered answer')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the empty state when the selected Bot has no imported chat', async () => {
    const read = vi.fn<GrokHistoryInlineProps['read']>().mockResolvedValue(null)
    renderInline('bot-empty', read)

    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineShow }))
    expect(await screen.findByText(en.grokHistoryEmpty)).toBeTruthy()
  })

  it('offers a retry after a failed read and renders the recovered result', async () => {
    const read = vi.fn<GrokHistoryInlineProps['read']>()
      .mockRejectedValueOnce(new Error('archive unavailable'))
      .mockResolvedValueOnce(archive)
    renderInline('bot-retry', read)

    fireEvent.click(screen.getByRole('button', { name: en.grokHistoryInlineShow }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByText('Recovered answer')).toBeTruthy()
    expect(read).toHaveBeenCalledTimes(2)
  })
})
