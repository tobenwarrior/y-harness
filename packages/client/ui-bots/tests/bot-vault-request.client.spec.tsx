// @vitest-environment jsdom

import type { SessionSnapshot } from '@yharness/api-session-controller/client'
import type { ComponentProps } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import { en } from '../src/client/locales.ts'
import {
  createBotVaultRequestPoller,
  fetchBotVaultRequest,
  isYHarnessCloudDesktop,
  parseBotVaultRequestResponse,
  type BotVaultRequest,
} from '../src/client/bot-vault-request.ts'
import { BotVaultRequestCard } from '../src/client/BotVaultRequestCard.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const REQUEST_ID = '0123456789abcdef0123456789abcdef'

function response(overrides: Partial<BotVaultRequest> = {}): { request: BotVaultRequest } {
  return {
    request: {
      id: REQUEST_ID as BotVaultRequest['id'],
      unit: 'yharness-worker.service',
      name: 'DEEPSEEK_API_KEY',
      state: 'pending',
      ...overrides,
    },
  }
}

describe('Bot Vault request response parser', () => {
  it('accepts only the exact metadata response and rejects secret-shaped or malformed values', () => {
    expect(parseBotVaultRequestResponse({ request: null })).toBeNull()
    expect(parseBotVaultRequestResponse(response())).toEqual(response().request)
    expect(parseBotVaultRequestResponse({ request: { ...response().request, id: 'ABC' } })).toBeNull()
    expect(parseBotVaultRequestResponse({ request: { ...response().request, unit: '../worker.service' } })).toBeNull()
    expect(parseBotVaultRequestResponse({ request: { ...response().request, name: 'API-KEY' } })).toBeNull()
    expect(parseBotVaultRequestResponse({ request: { ...response().request, value: 'secret' } })).toBeNull()
    expect(parseBotVaultRequestResponse({ request: { ...response().request, state: 'unknown' } })).toBeNull()
  })

  it('recognizes only the exact native Cloud Desktop user-agent token', () => {
    expect(isYHarnessCloudDesktop('Mozilla/5.0 YHarnessCloudDesktop/1')).toBe(true)
    expect(isYHarnessCloudDesktop('YHarnessCloudDesktop/10')).toBe(false)
    expect(isYHarnessCloudDesktop('NotYHarnessCloudDesktop/1')).toBe(false)
  })

  it('uses the exact same-origin session route without a cache', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }))
    await expect(fetchBotVaultRequest('owner session/one', new AbortController().signal)).resolves.toEqual(response().request)
    expect(fetcher).toHaveBeenCalledWith('/api/bot-vault-request?sessionId=owner%20session%2Fone', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }))
  })
})

describe('Bot Vault request polling', () => {
  it('aborts and ignores a result from a previous Bot after selection changes', async () => {
    let resolveFirst: ((value: BotVaultRequest | null) => void) | undefined
    const fetcher = vi.fn(async (sessionId: string, signal: AbortSignal) => {
      if (sessionId === 'first-session') {
        await new Promise<BotVaultRequest | null>((resolve) => { resolveFirst = resolve })
        if (signal.aborted) return null
        return response().request
      }
      return { ...response().request, name: 'OTHER_API_KEY' }
    })
    const results: Array<{ sessionId: string; request: BotVaultRequest | null }> = []
    const poller = createBotVaultRequestPoller({
      fetcher,
      intervalMs: 1_000,
      onResult: (sessionId, request) => { results.push({ sessionId, request }) },
    })

    poller.select('first-session', true)
    poller.select('second-session', false)
    resolveFirst?.(response().request)
    await vi.waitFor(() => { expect(results).toHaveLength(1) })

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenNthCalledWith(1, 'first-session', expect.any(AbortSignal))
    expect(fetcher).toHaveBeenNthCalledWith(2, 'second-session', expect.any(AbortSignal))
    expect(results[0]).toMatchObject({ sessionId: 'second-session', request: { name: 'OTHER_API_KEY' } })
    poller.dispose()
  })
})

type CardProps = ComponentProps<typeof BotVaultRequestCard>

function cardProps(overrides: Partial<CardProps> = {}): CardProps {
  const session = { running: false } as SessionSnapshot
  return {
    botChat: true,
    sessionId: SessionId('bot-session'),
    useSession: selector => selector(session),
    t,
    ...overrides,
  } as CardProps
}

describe('BotVaultRequestCard', () => {
  beforeEach(() => { window.__YH_BOT_VAULT_REQUESTS__ = true })
  afterEach(() => { delete window.__YH_BOT_VAULT_REQUESTS__ })

  it('does not query ordinary conversations', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }))
    render(<BotVaultRequestCard {...cardProps({ botChat: false })} />)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(screen.queryByText(en.vaultRequestTitle)).toBeNull()
  })

  it('does not query a workspace without Vault requests enabled', () => {
    delete window.__YH_BOT_VAULT_REQUESTS__
    const fetcher = vi.spyOn(globalThis, 'fetch')
    render(<BotVaultRequestCard {...cardProps()} />)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('shows a pending request without a value editor and links only to the validated native path', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('YHarnessCloudDesktop/1')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    render(<BotVaultRequestCard {...cardProps()} />)

    expect(await screen.findByText(en.vaultRequestTitle)).toBeTruthy()
    expect(screen.getByText('yharness-worker.service')).toBeTruthy()
    expect(screen.getByText('DEEPSEEK_API_KEY')).toBeTruthy()
    expect(screen.getByRole('link', { name: en.vaultRequestOpenDesktop }).getAttribute('href'))
      .toBe(`/__yharness/vault-request/${REQUEST_ID}`)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('renders the browser handoff instead of a native request link in Web', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response()), { status: 200 }))
    render(<BotVaultRequestCard {...cardProps()} />)

    expect(await screen.findByText(en.vaultRequestDesktopOnly)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders saved and cancelled statuses and clears the card when the broker returns no request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(response({ state: 'saved' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ request: null }), { status: 200 }))
    const props = cardProps()
    const view = render(<BotVaultRequestCard {...props} />)

    expect(await screen.findByText(en.vaultRequestSaved)).toBeTruthy()
    view.rerender(<BotVaultRequestCard {...props} useSession={selector => selector({ running: true } as SessionSnapshot)} />)
    await waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByText(en.vaultRequestTitle)).toBeNull() })
  })
})
