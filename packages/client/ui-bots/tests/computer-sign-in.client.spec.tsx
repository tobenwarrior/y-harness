// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en } from '../src/client/locales.ts'
import { ComputerSignInCard } from '../src/client/ComputerSignInCard.tsx'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import { ComputerApiError, type ComputerClient, type ComputerSignInRequest } from '../src/client/computer-client.ts'

afterEach(() => {
  cleanup()
  delete window.__YH_BOT_COMPUTER_SIGN_IN__
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const ownerBotId = 'bot-id-owner'
const ownerSessionId = 'bot-session-owner'
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const targetSessionId = 'handoff-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const origin = 'https://example.test'
const networkLabel = en.computerNetworkToggle
const restartLabel = en.computerRestart

type NetworkOperation = (sessionId: string, enabled: boolean, signal?: AbortSignal) => Promise<{
  readonly status: 'applied'
  readonly enabled: boolean
}>

type RestartOperation = (sessionId: string, signal?: AbortSignal) => Promise<{
  readonly status: 'restarted'
}>

function computer(): ComputerClient {
  const request: ComputerSignInRequest = { id: requestId, canCancel: true, targetSessionId, origin }
  return {
    status: async () => ({ available: true }),
    frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching', botActive: false }),
    takeControl: async () => ({ mode: 'watching' }),
    releaseControl: async () => ({ mode: 'watching' }),
    input: async () => ({ mode: 'watching' }),
    signIn: {
      status: vi.fn(async () => ({ request })),
      take: vi.fn(async () => ({ mode: 'controlling' as const })),
      complete: vi.fn(async () => ({ mode: 'watching' as const })),
      cancel: vi.fn(async () => ({ mode: 'watching' as const })),
    },
  }
}

type Props = ComponentProps<typeof ComputerSignInCard>

function props(overrides: Partial<Props> = {}): Props {
  const session = { running: false }
  return {
    botChat: true,
    sessionId: ownerSessionId,
    computer: computer(),
    openSignIn: vi.fn(),
    useSession: selector => selector(session as never),
    t,
    ...overrides,
  } as Props
}

describe('ComputerSignInCard shared handoff', () => {
  beforeEach(() => { window.__YH_BOT_COMPUTER_SIGN_IN__ = true })

  it('shows the shared title and origin, then opens only the opaque target', async () => {
    const card = computer()
    const openSignIn = vi.fn()
    render(<ComputerSignInCard {...props({ computer: card, openSignIn })} />)
    const signIn = card.signIn
    if (signIn === undefined) throw new Error('Computer sign-in client is unavailable')
    const cancel = vi.spyOn(signIn, 'cancel')

    expect(await screen.findByText(origin)).toBeTruthy()
    expect(screen.getByText(en.computerSignInSharedTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.computerSignInTake }))
    expect(openSignIn).toHaveBeenCalledWith(ownerSessionId, requestId, targetSessionId, origin)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(cancel).toHaveBeenCalledWith(targetSessionId, requestId) })
  })

  it('keeps the owner Session selected while the panel uses the target and renders current origin', async () => {
    const status = vi.fn(async () => ({ available: true, kind: 'vps' as const,
      computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, browser: true as const } }))
    const frame = vi.fn(async (_viewerId: string, _signal: AbortSignal | undefined, sessionId?: string) => {
      expect(sessionId).toBe(targetSessionId)
      return { jpeg: 'frame', width: 1280, height: 800, mode: 'controlling' as const, botActive: false, browserOrigin: origin }
    })
    const take = vi.fn(async () => ({ mode: 'controlling' as const }))
    const input = vi.fn<ComputerClient['input']>(async () => ({ mode: 'controlling' as const }))
    const client: ComputerClient = {
      status,
      frame,
      takeControl: async () => ({ mode: 'watching' }),
      releaseControl: async () => ({ mode: 'watching' }),
      input,
      signIn: {
        status: async () => ({ request: null }),
        take,
        complete: async () => ({ mode: 'watching' }),
        cancel: async () => ({ mode: 'watching' }),
      },
    }
    render(<ComputerPanel {...{
      computer: client,
      botId: ownerBotId,
      sessionId: ownerSessionId,
      signIn: { requestId, attempt: 1, targetSessionId, origin },
      close: vi.fn(),
      t,
    }} />)

    expect(await screen.findByText(origin)).toBeTruthy()
    expect(screen.getByText(origin)).toBeTruthy()
    await waitFor(() => { expect(take).toHaveBeenCalledWith(targetSessionId, requestId, expect.any(String)) })
    expect(status).toHaveBeenCalledWith(expect.any(AbortSignal), ownerSessionId)
    fireEvent.keyDown(screen.getByRole('img', { name: en.computerScreenAlt }), { key: 'a' })
    await waitFor(() => { expect(input).toHaveBeenCalled() })
    expect(input.mock.calls[0]?.[3]).toBe(targetSessionId)
    expect(input.mock.calls[0]?.[4]).toBe(origin)
  })

  it('does not enable shared handoff input without a confirmed frame origin', async () => {
    const input = vi.fn(async () => ({ mode: 'controlling' as const }))
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, browser: true as const } }),
      frame: async () => ({ jpeg: 'frame', width: 1280, height: 800, mode: 'controlling' as const, botActive: false, browserOrigin: null }),
      takeControl: async () => ({ mode: 'watching' }),
      releaseControl: async () => ({ mode: 'watching' }),
      input,
      signIn: {
        status: async () => ({ request: null }),
        take: async () => ({ mode: 'controlling' }),
        complete: async () => ({ mode: 'watching' }),
        cancel: async () => ({ mode: 'watching' }),
      },
    }
    render(<ComputerPanel {...{
      computer: client,
      botId: ownerBotId,
      sessionId: ownerSessionId,
      signIn: { requestId, attempt: 1, targetSessionId, origin },
      close: vi.fn(),
      t,
    }} />)

    const image = await screen.findByRole('img', { name: en.computerScreenAlt })
    expect(screen.getByText(en.computerBrowserOriginUnavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.computerPaste }).getAttribute('disabled')).not.toBeNull()
    fireEvent.keyDown(image, { key: 'a' })
    await Promise.resolve()
    expect(input).not.toHaveBeenCalled()
  })

  it('shows the private Bot Internet switch, updates it, and refreshes selected availability', async () => {
    const status = vi.fn(async () => ({ available: true, kind: 'vps' as const,
      computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const,
        terminal: true as const, terminalInternet: false, networkControl: true as const } }))
    const network = vi.fn<NetworkOperation>(async (_sessionId, enabled) => ({ status: 'applied', enabled }))
    const refreshAvailability = vi.fn()
    const client = {
      status,
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      network,
    } as ComputerClient & { readonly network: NetworkOperation }
    const props = {
      computer: client, botId: ownerBotId, sessionId: ownerSessionId, close: vi.fn(), t, refreshAvailability,
    } as ComponentProps<typeof ComputerPanel> & { readonly refreshAvailability: (sessionId?: string) => void }
    render(<ComputerPanel {...props} />)

    const toggle = await screen.findByRole('switch', { name: networkLabel })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => { expect(network).toHaveBeenCalledWith(ownerSessionId, true, expect.any(AbortSignal)) })
    await waitFor(() => { expect(toggle.getAttribute('aria-checked')).toBe('true') })
    expect(refreshAvailability).toHaveBeenCalledWith(ownerSessionId)
  })

  it('aborts an Internet write when the Computer panel is unmounted', async () => {
    let requestSignal: AbortSignal | undefined
    const network = vi.fn<NetworkOperation>((_sessionId, _enabled, signal) => {
      requestSignal = signal
      return new Promise(() => {})
    })
    const client = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const,
          terminal: true as const, terminalInternet: false, networkControl: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      network,
    } as ComputerClient & { readonly network: NetworkOperation }
    const view = render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    fireEvent.click(await screen.findByRole('switch', { name: networkLabel }))
    await waitFor(() => { expect(network).toHaveBeenCalled() })
    view.unmount()
    expect(requestSignal?.aborted).toBe(true)
  })

  it.each([
    ['workspace computer', { id: ownerBotId, location: 'vps' as const, permissionScope: 'workspace' as const,
      terminal: true as const, terminalInternet: false, networkControl: true as const }],
    ['stale status Bot', { id: 'other-bot', location: 'vps' as const, permissionScope: 'bot' as const,
      terminal: true as const, terminalInternet: false, networkControl: true as const }],
    ['legacy computer status', { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const,
      terminal: true as const, terminalInternet: false }],
  ])('hides the Internet switch for %s', async (_name, identity) => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const, computer: identity }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('switch', { name: networkLabel })).toBeNull() })
  })

  it('confirms a private Bot restart, pauses frames, and refreshes the same target', async () => {
    let resolveRestart: ((value: { readonly status: 'restarted' }) => void) | undefined
    const restart = vi.fn<RestartOperation>((_sessionId, _signal) => new Promise((resolve) => { resolveRestart = resolve }))
    const frame = vi.fn(async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }))
    const client = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame,
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart,
    } as ComputerClient & { readonly restart: RestartOperation }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: restartLabel }))
    expect(screen.getByText(en.computerRestartConfirm)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.computerRestartAction }))
    await waitFor(() => { expect(restart).toHaveBeenCalledWith(ownerSessionId, expect.any(AbortSignal)) })
    const frameCallsDuringRestart = frame.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(frame.mock.calls.length).toBe(frameCallsDuringRestart)

    resolveRestart?.({ status: 'restarted' })
    await waitFor(() => { expect(frame.mock.calls.length).toBeGreaterThan(frameCallsDuringRestart) })
    expect(screen.queryByText(en.computerRestartConfirm)).toBeNull()
  })

  it.each([
    ['legacy status', { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const }],
    ['different Bot', { id: 'other-bot', location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const }],
    ['workspace computer', { id: ownerBotId, location: 'vps' as const, permissionScope: 'workspace' as const, restart: true as const }],
    ['Mac computer', { id: ownerBotId, location: 'mac' as const, permissionScope: 'workspace' as const, restart: true as const }],
  ])('hides restart for %s', async (_name, identity) => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: identity.location, computer: identity }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('button', { name: restartLabel })).toBeNull() })
  })

  it('disables restart while the Bot is controlling the Computer', async () => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'controlling' as const, botActive: true }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart: vi.fn<RestartOperation>(async () => ({ status: 'restarted' })),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    const restart = await screen.findByRole('button', { name: restartLabel })
    expect((restart as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps restart available after a disconnected frame', async () => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => { throw new ComputerApiError(500, 'disconnected') },
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart: vi.fn<RestartOperation>(async () => ({ status: 'restarted' })),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    expect(await screen.findByRole('button', { name: restartLabel })).toBeTruthy()
  })

  it('hides restart for a shared handoff target', async () => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart: vi.fn<RestartOperation>(async () => ({ status: 'restarted' })),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId}
      signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('button', { name: restartLabel })).toBeNull() })
  })

  it('hides restart when the Computer status is unavailable', async () => {
    const client: ComputerClient = {
      status: async () => ({ available: false, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart: vi.fn<RestartOperation>(async () => ({ status: 'restarted' })),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('button', { name: restartLabel })).toBeNull() })
  })

  it('hides restart while a private sign-in request is confirmed', async () => {
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart: vi.fn<RestartOperation>(async () => ({ status: 'restarted' })),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId}
      signIn={{ requestId, attempt: 1 }} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('button', { name: restartLabel })).toBeNull() })
  })

  it.each([
    [409, en.computerRestartBusy],
    [500, en.computerRestartError],
  ] as const)('surfaces restart failure %s without changing the target', async (status, message) => {
    const restart = vi.fn<RestartOperation>(async () => { throw new ComputerApiError(status, 'failed') })
    const client: ComputerClient = {
      status: async () => ({ available: true, kind: 'vps' as const,
        computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const, restart: true as const } }),
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      restart,
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: restartLabel }))
    fireEvent.click(screen.getByRole('button', { name: en.computerRestartAction }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(message) })
    expect(screen.getByRole('region', { name: en.computerTitle })).toBeTruthy()
  })

  it('hides the Internet switch for shared handoff viewers', async () => {
    const status = vi.fn(async () => ({ available: true, kind: 'vps' as const,
      computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const,
        terminal: true as const, terminalInternet: false, networkControl: true as const } }))
    const client: ComputerClient & { readonly network: NetworkOperation } = {
      status,
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      network: vi.fn(async () => { throw new ComputerApiError(409, 'busy') }),
    }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId}
      signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByRole('switch', { name: networkLabel })).toBeNull() })
  })

  it.each([
    [409, en.computerNetworkBusy],
    [500, en.computerNetworkError],
  ] as const)('keeps the Internet selection when the write fails with HTTP %s', async (status, message) => {
    const statusOf = vi.fn(async () => ({ available: true, kind: 'vps' as const,
      computer: { id: ownerBotId, location: 'vps' as const, permissionScope: 'bot' as const,
        terminal: true as const, terminalInternet: false, networkControl: true as const } }))
    const network = vi.fn<NetworkOperation>(async () => { throw new ComputerApiError(status, 'failed') })
    const client = {
      status: statusOf,
      frame: async () => ({ jpeg: '', width: 1280, height: 800, mode: 'watching' as const, botActive: false }),
      takeControl: async () => ({ mode: 'watching' as const }),
      releaseControl: async () => ({ mode: 'watching' as const }),
      input: async () => ({ mode: 'watching' as const }),
      network,
    } as ComputerClient & { readonly network: NetworkOperation }
    render(<ComputerPanel computer={client} botId={ownerBotId} sessionId={ownerSessionId} close={vi.fn()} t={t} />)
    const toggle = await screen.findByRole('switch', { name: networkLabel })
    fireEvent.click(toggle)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(message) })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
})
