// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerApiError, type ComputerClient, type ComputerFrame, type ComputerIdentity, type ComputerStatus } from '../src/client/computer-client.ts'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const botId = 'bot-panel-edge'
const sessionId = 'bot-session-panel-edge'
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const targetSessionId = 'handoff-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const origin = 'https://example.test'
const frame: ComputerFrame = { jpeg: 'screen', width: 100, height: 50, mode: 'watching', botActive: false }

function untilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function makeComputer(overrides: Partial<ComputerClient> = {}): ComputerClient {
  return {
    status: vi.fn<ComputerClient['status']>().mockResolvedValue({ available: true }),
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce(frame)
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal)),
    takeControl: vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' }),
    releaseControl: vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' }),
    input: vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' }),
    ...overrides,
  }
}

function vpsIdentity(extra: Partial<ComputerIdentity> = {}): ComputerIdentity {
  return { id: botId, location: 'vps', permissionScope: 'bot', ...extra }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each(['resolved', 'rejected'] as const)('ignores a status %s after the panel unmounts', async (outcome) => {
  const statusResult = Promise.withResolvers<ComputerStatus>()
  const status = vi.fn<ComputerClient['status']>().mockReturnValue(statusResult.promise)
  const view = render(<ComputerPanel computer={makeComputer({ status })} sessionId={sessionId} close={vi.fn()} t={t} />)

  view.unmount()
  await act(async () => {
    if (outcome === 'resolved') statusResult.resolve({ available: true })
    else statusResult.reject(new Error('late status failure'))
    await statusResult.promise.catch(() => {})
  })
})

it('keeps the panel usable when status polling fails', async () => {
  const status = vi.fn<ComputerClient['status']>().mockRejectedValue(new Error('status unavailable'))
  const frameRequest = vi.fn<ComputerClient['frame']>().mockRejectedValue(new Error('frame unavailable'))
  render(<ComputerPanel computer={makeComputer({ status, frame: frameRequest })} sessionId={sessionId} close={vi.fn()} t={t} />)

  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer connection lost') })
  expect(status).toHaveBeenCalledWith(expect.any(AbortSignal), sessionId)
})

it('clears a shared handoff frame after polling and takeover errors', async () => {
  const take = vi.fn().mockRejectedValue(new ComputerApiError(500, 'takeover failed'))
  const frameRequest = vi.fn<ComputerClient['frame']>().mockRejectedValue(new ComputerApiError(500, 'frame failed'))
  const client = makeComputer({
    frame: frameRequest,
    signIn: {
      status: async () => ({ request: null }),
      take,
      complete: async () => ({ mode: 'watching' as const }),
      cancel: async () => ({ mode: 'watching' as const }),
    },
  })
  render(<ComputerPanel computer={client} sessionId={sessionId}
    signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)

  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer connection lost') })
  expect(take).toHaveBeenCalledWith(targetSessionId, requestId, expect.any(String))
  expect(screen.queryByRole('img', { name: en.computerScreenAlt })).toBeNull()
})

it('ignores a network result after the panel is replaced', async () => {
  const networkResult = Promise.withResolvers<{ readonly status: 'applied'; readonly enabled: boolean }>()
  onTestFinished(() => { networkResult.resolve({ status: 'applied', enabled: true }) })
  const network = vi.fn().mockReturnValue(networkResult.promise)
  const status = vi.fn<ComputerClient['status']>().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ terminal: true, terminalInternet: false, networkControl: true }) })
  const original = makeComputer({ status, network })
  const replacement = makeComputer({ status: vi.fn().mockResolvedValue({ available: true }) })
  const view = render(<ComputerPanel computer={original} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('switch', { name: en.computerNetworkToggle }))
  await waitFor(() => { expect(network).toHaveBeenCalledWith(sessionId, true, expect.any(AbortSignal)) })
  view.rerender(<ComputerPanel computer={replacement} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)
  networkResult.resolve({ status: 'applied', enabled: true })
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores a network rejection after the panel is replaced', async () => {
  const networkResult = Promise.withResolvers<{ readonly status: 'applied'; readonly enabled: boolean }>()
  onTestFinished(() => { networkResult.resolve({ status: 'applied', enabled: true }) })
  const network = vi.fn().mockReturnValue(networkResult.promise)
  const status = vi.fn<ComputerClient['status']>().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ terminal: true, terminalInternet: false, networkControl: true }) })
  const original = makeComputer({ status, network })
  const replacement = makeComputer({ status: vi.fn().mockResolvedValue({ available: true }) })
  const view = render(<ComputerPanel computer={original} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('switch', { name: en.computerNetworkToggle }))
  await waitFor(() => { expect(network).toHaveBeenCalled() })
  view.rerender(<ComputerPanel computer={replacement} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)
  await act(async () => { networkResult.reject(new Error('late network failure')) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolved', 'rejected'] as const)('ignores a shared-workspace %s after the panel unmounts', async (outcome) => {
  const workspaceResult = Promise.withResolvers<{ readonly status: 'applied'; readonly enabled: boolean }>()
  onTestFinished(() => { workspaceResult.resolve({ status: 'applied', enabled: true }) })
  const sharedWorkspace = vi.fn().mockReturnValue(workspaceResult.promise)
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ sharedWorkspaceControl: true }) }),
    sharedWorkspace,
  })
  const view = render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('switch', { name: en.computerSharedWorkspaceToggle }))
  await waitFor(() => { expect(sharedWorkspace).toHaveBeenCalled() })
  view.unmount()
  await act(async () => {
    if (outcome === 'resolved') workspaceResult.resolve({ status: 'applied', enabled: true })
    else workspaceResult.reject(new Error('late workspace failure'))
    await workspaceResult.promise.catch(() => {})
  })
})

it('opens and cancels the restart confirmation before a restart completes', async () => {
  const restartResult = Promise.withResolvers<{ readonly status: 'restarted' }>()
  onTestFinished(() => { restartResult.resolve({ status: 'restarted' }) })
  const restart = vi.fn().mockReturnValue(restartResult.promise)
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ restart: true }) }),
    restart,
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  const restartButton = await screen.findByRole('button', { name: en.computerRestart })
  fireEvent.click(restartButton)
  expect(screen.getByText(en.computerRestartConfirm)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(screen.queryByText(en.computerRestartConfirm)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.computerRestart }))
  fireEvent.click(screen.getByRole('button', { name: en.computerRestartAction }))
  await waitFor(() => { expect(restart).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal)) })
  restartResult.resolve({ status: 'restarted' })
  await waitFor(() => { expect(screen.queryByText(en.computerRestartConfirm)).toBeNull() })
})

it.each(['resolved', 'rejected'] as const)('ignores a restart %s after the panel unmounts', async (outcome) => {
  const restartResult = Promise.withResolvers<{ readonly status: 'restarted' }>()
  onTestFinished(() => { restartResult.resolve({ status: 'restarted' }) })
  const restart = vi.fn().mockReturnValue(restartResult.promise)
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ restart: true }) }),
    restart,
  })
  const view = render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('button', { name: en.computerRestart }))
  fireEvent.click(screen.getByRole('button', { name: en.computerRestartAction }))
  await waitFor(() => { expect(restart).toHaveBeenCalled() })
  view.unmount()
  await act(async () => {
    if (outcome === 'resolved') restartResult.resolve({ status: 'restarted' })
    else restartResult.reject(new Error('late restart failure'))
    await restartResult.promise.catch(() => {})
  })
})

it.each(['complete', 'cancel'] as const)('finishes a private sign-in with %s', async (action) => {
  const complete = vi.fn().mockResolvedValue({ mode: 'watching' as const })
  const cancel = vi.fn().mockResolvedValue({ mode: 'watching' as const })
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    frame: vi.fn().mockResolvedValue({ ...frame, mode: 'controlling', signIn: requestId }),
    signIn: {
      status: async () => ({ request: null }),
      take: vi.fn().mockResolvedValue({ mode: 'controlling' as const }),
      complete,
      cancel,
    },
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId}
    signIn={{ requestId, attempt: 1 }} close={vi.fn()} t={t} />)

  const button = await screen.findByRole('button', { name: action === 'complete' ? en.computerSignInDone : en.cancel })
  fireEvent.click(button)
  await waitFor(() => {
    expect(action === 'complete' ? complete : cancel).toHaveBeenCalledWith(sessionId, requestId, expect.any(String))
  })
})

it('offers a pending private sign-in takeover from a watching frame', async () => {
  const take = vi.fn().mockResolvedValue({ mode: 'controlling' as const })
  const client = makeComputer({
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce({ ...frame, signIn: requestId })
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal)),
    signIn: {
      status: async () => ({ request: null }),
      take,
      complete: async () => ({ mode: 'watching' as const }),
      cancel: async () => ({ mode: 'watching' as const }),
    },
  })
  render(<ComputerPanel computer={client} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('button', { name: en.computerSignInTake }))
  await waitFor(() => { expect(take).toHaveBeenCalledWith(sessionId, requestId, expect.any(String)) })
})

it('finishes a shared sign-in by closing the handoff after a successful release', async () => {
  const close = vi.fn()
  const complete = vi.fn().mockResolvedValue({ mode: 'watching' as const })
  const client = makeComputer({
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce({ ...frame, mode: 'controlling', signIn: requestId, browserOrigin: origin })
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal)),
    signIn: {
      status: async () => ({ request: null }),
      take: async () => ({ mode: 'controlling' as const }),
      complete,
      cancel: async () => ({ mode: 'watching' as const }),
    },
  })
  render(<ComputerPanel computer={client} sessionId={sessionId}
    signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={close} t={t} />)

  fireEvent.click(await screen.findByRole('button', { name: en.computerSignInDone }))
  await waitFor(() => { expect(complete).toHaveBeenCalledWith(targetSessionId, requestId, expect.any(String)) })
  expect(close).toHaveBeenCalledOnce()
})

it('marks a shared sign-in unavailable when release returns 404', async () => {
  const complete = vi.fn().mockRejectedValue(new ComputerApiError(404, 'handoff gone'))
  const client = makeComputer({
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce({ ...frame, mode: 'controlling', signIn: requestId, browserOrigin: origin })
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal)),
    signIn: {
      status: async () => ({ request: null }),
      take: async () => ({ mode: 'controlling' as const }),
      complete,
      cancel: async () => ({ mode: 'watching' as const }),
    },
  })
  render(<ComputerPanel computer={client} sessionId={sessionId}
    signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('button', { name: en.computerSignInDone }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer control is unavailable') })
  expect(screen.queryByRole('img', { name: en.computerScreenAlt })).toBeNull()
})

it('drops a queued browser navigation when its input lease is replaced', async () => {
  const delivery = Promise.withResolvers<{ readonly mode: 'controlling' }>()
  onTestFinished(() => { delivery.resolve({ mode: 'controlling' }) })
  const input = vi.fn<ComputerClient['input']>().mockReturnValue(delivery.promise)
  const navigate = vi.fn().mockResolvedValue({ mode: 'controlling' as const })
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    input,
    navigate,
  })
  const view = render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  await screen.findByRole('button', { name: en.computerHandBack })
  fireEvent.keyDown(image, { key: 'Escape' })
  const address = await screen.findByRole('textbox', { name: en.computerWebsiteAddress })
  fireEvent.change(address, { target: { value: origin } })
  const form = address.closest('form')
  if (!(form instanceof HTMLFormElement)) throw new Error('The browser address form is unavailable.')
  fireEvent.submit(form)
  view.unmount()
  await act(async () => { delivery.resolve({ mode: 'controlling' }) })
  expect(navigate).not.toHaveBeenCalled()
})

it('does not release a queued handback after its input queue is replaced', async () => {
  const delivery = Promise.withResolvers<{ readonly mode: 'controlling' }>()
  onTestFinished(() => { delivery.resolve({ mode: 'controlling' }) })
  const input = vi.fn<ComputerClient['input']>().mockReturnValue(delivery.promise)
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  const client = makeComputer({ input, releaseControl })
  const view = render(<ComputerPanel computer={client} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  const handback = await screen.findByRole('button', { name: en.computerHandBack })
  fireEvent.keyDown(image, { key: 'Escape' })
  fireEvent.click(handback)
  view.unmount()
  await act(async () => { delivery.resolve({ mode: 'controlling' }) })
  expect(releaseControl).toHaveBeenCalledOnce()
  expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, undefined)
})

it('ignores an empty browser address submitted through the form', async () => {
  const navigate = vi.fn().mockResolvedValue({ mode: 'controlling' as const })
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    navigate,
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  await screen.findByRole('button', { name: en.computerHandBack })
  const address = await screen.findByRole('textbox', { name: en.computerWebsiteAddress })
  const form = address.closest('form')
  if (!(form instanceof HTMLFormElement)) throw new Error('The browser address form is unavailable.')
  fireEvent.submit(form)
  expect(navigate).not.toHaveBeenCalled()
})

it('forwards a shifted printable key without inventing an X11 Shift modifier', async () => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const client = makeComputer({ input })
  render(<ComputerPanel computer={client} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  await screen.findByRole('button', { name: en.computerHandBack })
  fireEvent.keyDown(image, { key: 'k', shiftKey: true })
  await waitFor(() => { expect(input).toHaveBeenCalledWith(expect.any(String), { kind: 'key', key: 'k' }, undefined, undefined, undefined) })
})

it('uses browser restart copy for a VPS with both desktop and browser control', async () => {
  const restartResult = Promise.withResolvers<{ readonly status: 'restarted' }>()
  onTestFinished(() => { restartResult.resolve({ status: 'restarted' }) })
  const restart = vi.fn().mockReturnValue(restartResult.promise)
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ desktop: true, browser: true, restart: true }) }),
    restart,
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  fireEvent.click(await screen.findByRole('button', { name: en.computerRestartBrowser }))
  expect(screen.getByText(en.computerRestartBrowserConfirm)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.computerRestartAction }))
  await waitFor(() => { expect(restart).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal)) })
  expect(screen.getByRole('button', { name: en.computerRestartingBrowser })).toBeTruthy()
  restartResult.resolve({ status: 'restarted' })
})

it.each(['success', 'failure'] as const)('navigates the private browser on %s', async (outcome) => {
  const navigation = Promise.withResolvers<{ readonly mode: 'controlling' }>()
  onTestFinished(() => { navigation.resolve({ mode: 'controlling' }) })
  const navigate = vi.fn().mockReturnValue(navigation.promise)
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    navigate,
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  await screen.findByRole('button', { name: en.computerHandBack })
  const address = await screen.findByRole('textbox', { name: en.computerWebsiteAddress })
  fireEvent.change(address, { target: { value: origin } })
  fireEvent.submit(address.closest('form') as HTMLFormElement)
  await waitFor(() => { expect(navigate).toHaveBeenCalledWith(expect.any(String), origin, sessionId, expect.any(AbortSignal)) })
  if (outcome === 'success') {
    navigation.resolve({ mode: 'controlling' })
    await waitFor(() => { expect(document.activeElement).toBe(image) })
  } else {
    navigation.reject(new Error('navigation failed'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.computerNavigationFailed) })
  }
})

it.each(['resolved', 'rejected'] as const)('ignores a pending browser navigation %s after the panel unmounts', async (outcome) => {
  const navigation = Promise.withResolvers<{ readonly mode: 'controlling' }>()
  onTestFinished(() => { navigation.resolve({ mode: 'controlling' }) })
  let signal: AbortSignal | undefined
  const navigate = vi.fn((_viewerId: string, _url: string, _session: string, requestSignal?: AbortSignal) => {
    signal = requestSignal
    return navigation.promise
  })
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    navigate,
  })
  const view = render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
  await screen.findByRole('button', { name: en.computerHandBack })
  const address = await screen.findByRole('textbox', { name: en.computerWebsiteAddress })
  fireEvent.change(address, { target: { value: origin } })
  fireEvent.submit(address.closest('form') as HTMLFormElement)
  await waitFor(() => { expect(navigate).toHaveBeenCalled() })
  view.unmount()
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    if (outcome === 'resolved') navigation.resolve({ mode: 'controlling' })
    else navigation.reject(new Error('late navigation failure'))
    await navigation.promise.catch(() => {})
  })
})

it('turns a shared browser navigation 404 into an unavailable phase', async () => {
  const navigate = vi.fn().mockRejectedValue(new ComputerApiError(404, 'gone'))
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    frame: vi.fn().mockResolvedValue({ ...frame, mode: 'controlling', signIn: requestId, browserOrigin: origin }),
    signIn: {
      status: async () => ({ request: null }),
      take: vi.fn().mockResolvedValue({ mode: 'controlling' as const }),
      complete: async () => ({ mode: 'watching' as const }),
      cancel: async () => ({ mode: 'watching' as const }),
    },
    navigate,
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId}
    signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)

  const address = await screen.findByRole('textbox', { name: en.computerWebsiteAddress })
  fireEvent.change(address, { target: { value: origin } })
  fireEvent.submit(address.closest('form') as HTMLFormElement)
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer control is unavailable') })
  expect(screen.queryByRole('img', { name: en.computerScreenAlt })).toBeNull()
})

it('drops shared-handoff input errors and the current frame', async () => {
  const input = vi.fn().mockRejectedValue(new ComputerApiError(500, 'input failed'))
  const client = makeComputer({
    status: vi.fn().mockResolvedValue({ available: true, kind: 'vps', computer: vpsIdentity({ browser: true }) }),
    frame: vi.fn().mockResolvedValue({ ...frame, mode: 'controlling', signIn: requestId, browserOrigin: origin }),
    input,
    signIn: {
      status: async () => ({ request: null }),
      take: vi.fn().mockResolvedValue({ mode: 'controlling' as const }),
      complete: async () => ({ mode: 'watching' as const }),
      cancel: async () => ({ mode: 'watching' as const }),
    },
  })
  render(<ComputerPanel computer={client} botId={botId} sessionId={sessionId}
    signIn={{ requestId, attempt: 1, targetSessionId, origin }} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: en.computerScreenAlt })
  fireEvent.keyDown(image, { key: 'Escape' })
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.computerInputRejected) })
  expect(input).toHaveBeenCalledWith(expect.any(String), { kind: 'key', key: 'Escape' }, undefined, targetSessionId, origin)
  expect(screen.queryByRole('img', { name: en.computerScreenAlt })).toBeNull()
})
