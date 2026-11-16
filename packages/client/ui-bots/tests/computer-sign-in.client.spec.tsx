// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en } from '../src/client/locales.ts'
import { ComputerSignInCard } from '../src/client/ComputerSignInCard.tsx'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import type { ComputerClient, ComputerSignInRequest } from '../src/client/computer-client.ts'

afterEach(() => {
  cleanup()
  delete window.__YH_BOT_COMPUTER_SIGN_IN__
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const ownerSessionId = 'owner-session'
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const targetSessionId = 'handoff-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const origin = 'https://example.test'

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

    expect(await screen.findByText(origin)).toBeTruthy()
    expect(screen.getByText(en.computerSignInSharedTitle)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.computerSignInTake }))
    expect(openSignIn).toHaveBeenCalledWith(ownerSessionId, requestId, targetSessionId, origin)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(card.signIn?.cancel).toHaveBeenCalledWith(targetSessionId, requestId) })
  })

  it('keeps the owner Session selected while the panel uses the target and renders current origin', async () => {
    const status = vi.fn(async () => ({ available: true, kind: 'vps' as const,
      computer: { id: ownerSessionId, location: 'vps' as const, permissionScope: 'bot' as const, browser: true as const } }))
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
      sessionId: ownerSessionId,
      signIn: { requestId, attempt: 1, targetSessionId, origin },
      close: vi.fn(),
      t,
    } as ComponentProps<typeof ComputerPanel>} />)

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
        computer: { id: ownerSessionId, location: 'vps' as const, permissionScope: 'bot' as const, browser: true as const } }),
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
      sessionId: ownerSessionId,
      signIn: { requestId, attempt: 1, targetSessionId, origin },
      close: vi.fn(),
      t,
    } as ComponentProps<typeof ComputerPanel>} />)

    const image = await screen.findByRole('img', { name: en.computerScreenAlt })
    expect(screen.getByText(en.computerBrowserOriginUnavailable)).toBeTruthy()
    expect((screen.getByRole('button', { name: en.computerPaste }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(image, { key: 'a' })
    await Promise.resolve()
    expect(input).not.toHaveBeenCalled()
  })
})
