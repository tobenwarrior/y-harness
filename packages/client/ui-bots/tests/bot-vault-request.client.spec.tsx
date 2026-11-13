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
import {
  fetchBotWebsiteLoginRequest,
  isBotWebsiteLoginRequestEnabled,
  parseBotWebsiteLoginResponse,
  type BotWebsiteLoginRequest,
} from '../src/client/bot-website-login-request.ts'
import { BotWebsiteLoginRequestCard } from '../src/client/BotWebsiteLoginRequestCard.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const REQUEST_ID = '0123456789abcdef0123456789abcdef'

function websiteResponse(overrides: Partial<BotWebsiteLoginRequest> = {}): { request: BotWebsiteLoginRequest } {
  return {
    request: {
      id: REQUEST_ID as BotWebsiteLoginRequest['id'],
      origin: 'https://example.com',
      destination: 'https://example.com/sign-in',
      ...overrides,
    },
  }
}

describe('Bot website login request response', () => {
  it('accepts exact metadata and rejects secret-shaped or off-origin values', () => {
    expect(parseBotWebsiteLoginResponse({ request: null })).toBeNull()
    expect(parseBotWebsiteLoginResponse(websiteResponse())).toEqual(websiteResponse().request)
    expect(parseBotWebsiteLoginResponse({ request: { ...websiteResponse().request, destination: 'http://example.com/sign-in' } })).toBeNull()
    expect(parseBotWebsiteLoginResponse({ request: { ...websiteResponse().request, destination: 'https://other.example/sign-in' } })).toBeNull()
    expect(parseBotWebsiteLoginResponse({ request: { ...websiteResponse().request, username: 'alice', password: 'secret' } })).toBeNull()
  })

  it('uses the exact same-origin session route without a cache', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(websiteResponse()), { status: 200 }))
    await expect(fetchBotWebsiteLoginRequest('owner session/one', new AbortController().signal)).resolves.toEqual(websiteResponse().request)
    expect(fetcher).toHaveBeenCalledWith('/api/bot-website-login?sessionId=owner%20session%2Fone', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    }))
  })

  it('requires the explicit website-login feature flag', () => {
    window.__YH_BOT_WEBSITE_LOGIN__ = true
    expect(isBotWebsiteLoginRequestEnabled()).toBe(true)
    delete window.__YH_BOT_WEBSITE_LOGIN__
    expect(isBotWebsiteLoginRequestEnabled()).toBe(false)
  })
})

describe('BotWebsiteLoginRequestCard', () => {
  beforeEach(() => { window.__YH_BOT_WEBSITE_LOGIN__ = true })
  afterEach(() => { delete window.__YH_BOT_WEBSITE_LOGIN__ })

  it('shows origin and exact destination without rendering a credential editor', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('YHarnessCloudDesktop/1')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(websiteResponse()), { status: 200 }))
    render(<BotWebsiteLoginRequestCard {...cardProps() as ComponentProps<typeof BotWebsiteLoginRequestCard>} />)
    expect(await screen.findByText('https://example.com')).toBeTruthy()
    expect(screen.getByText('https://example.com/sign-in')).toBeTruthy()
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/__yharness/vault-login-use/${REQUEST_ID}`)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not query ordinary conversations or Web handoff links', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(websiteResponse()), { status: 200 }))
    render(<BotWebsiteLoginRequestCard {...cardProps({ botChat: false }) as ComponentProps<typeof BotWebsiteLoginRequestCard>} />)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    cleanup()
    render(<BotWebsiteLoginRequestCard {...cardProps() as ComponentProps<typeof BotWebsiteLoginRequestCard>} />)
    expect(await screen.findByText(en.websiteLoginDesktopOnly)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })
})

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
