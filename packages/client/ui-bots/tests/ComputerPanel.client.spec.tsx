// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerApiError, type ComputerClient, type ComputerFrame } from '../src/client/computer-client.ts'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

const watchingFrame: ComputerFrame = {
  jpeg: 'managed-screen', width: 100, height: 50, mode: 'watching', botActive: false,
}

function makeComputer(overrides: Partial<ComputerClient> = {}): ComputerClient {
  return {
    status: vi.fn<ComputerClient['status']>().mockResolvedValue({
      available: true,
      kind: 'vps',
      computer: { id: 'managed-bot', location: 'vps', permissionScope: 'bot' },
    }),
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValue(watchingFrame),
    takeControl: vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' }),
    releaseControl: vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' }),
    input: vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' }),
    ...overrides,
  }
}

function untilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ComputerPanel managed Bot behavior', () => {
  it('renders the selected Bot frame and permission scope, forwarding its Session', async () => {
    const status = vi.fn<ComputerClient['status']>().mockResolvedValue({
      available: true,
      kind: 'vps',
      computer: { id: 'managed-bot', location: 'vps', permissionScope: 'bot' },
    })
    const frame = vi.fn<ComputerClient['frame']>().mockResolvedValue(watchingFrame)
    const computer = makeComputer({ status, frame })
    render(<ComputerPanel computer={computer} sessionId="bot-session" close={vi.fn()} t={t} />)

    const image = await screen.findByRole('img', { name: 'Live computer screen' })
    expect(image.getAttribute('src')).toBe('data:image/jpeg;base64,managed-screen')
    expect(screen.getByRole('status').textContent).toContain('Watching')
    expect(screen.getByRole('status').textContent).toContain('Display and input are dedicated to this Bot')
    expect(status).toHaveBeenCalledWith(expect.any(AbortSignal), 'bot-session')
    expect(frame).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal), 'bot-session')
  })

  it('takes and releases the selected Bot lease with the active Session', async () => {
    const takeControl = vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' })
    const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
    const frame = vi.fn<ComputerClient['frame']>()
      .mockResolvedValueOnce(watchingFrame)
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
    const computer = makeComputer({ frame, takeControl, releaseControl })
    render(<ComputerPanel computer={computer} sessionId="bot-session" close={vi.fn()} t={t} />)

    await screen.findByRole('img', { name: 'Live computer screen' })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Hand back' })).toBeTruthy() })
    expect(takeControl).toHaveBeenCalledWith(expect.any(String), undefined, 'bot-session')

    fireEvent.click(screen.getByRole('button', { name: 'Hand back' }))
    await waitFor(() => { expect(releaseControl).toHaveBeenCalledWith(expect.any(String), undefined, 'bot-session') })
    expect(screen.getByRole('button', { name: 'Take control' })).toBeTruthy()
  })

  it('releases a selected Bot lease when the Session changes', async () => {
    const takeControl = vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' })
    const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
    const status = vi.fn<ComputerClient['status']>().mockResolvedValue({
      available: true, kind: 'vps', computer: { location: 'vps', permissionScope: 'bot' },
    })
    const frame = vi.fn<ComputerClient['frame']>()
      .mockResolvedValueOnce(watchingFrame)
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
    const computer = makeComputer({ status, frame, takeControl, releaseControl })
    const view = render(<ComputerPanel computer={computer} sessionId="bot-first" close={vi.fn()} t={t} />)

    await screen.findByRole('img', { name: 'Live computer screen' })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await screen.findByRole('button', { name: 'Hand back' })
    view.rerender(<ComputerPanel computer={computer} sessionId="bot-second" close={vi.fn()} t={t} />)

    await waitFor(() => {
      expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, 'bot-first')
      expect(status).toHaveBeenCalledWith(expect.any(AbortSignal), 'bot-second')
      expect(frame).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal), 'bot-second')
    })
    expect(screen.getByRole('button', { name: 'Take control' })).toBeTruthy()
  })

  it('hands back a control lease that arrives after the panel closes', async () => {
    const grant = Promise.withResolvers<Awaited<ReturnType<ComputerClient['takeControl']>>>()
    const takeControl = vi.fn<ComputerClient['takeControl']>().mockReturnValue(grant.promise)
    const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
    const computer = makeComputer({ takeControl, releaseControl })
    const panel = render(<ComputerPanel computer={computer} sessionId="bot-session" close={vi.fn()} t={t} />)

    await screen.findByRole('img', { name: 'Live computer screen' })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    expect(takeControl).toHaveBeenCalledWith(expect.any(String), undefined, 'bot-session')
    panel.unmount()
    expect(releaseControl).not.toHaveBeenCalled()

    grant.resolve({ mode: 'controlling' })
    await waitFor(() => {
      expect(releaseControl).toHaveBeenCalledOnce()
      expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, 'bot-session')
    })
  })

  it('releases an active lease with keepalive during teardown', async () => {
    const takeControl = vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' })
    const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
    const frame = vi.fn<ComputerClient['frame']>()
      .mockResolvedValueOnce(watchingFrame)
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
    const computer = makeComputer({ frame, takeControl, releaseControl })
    const view = render(<ComputerPanel computer={computer} sessionId="bot-session" close={vi.fn()} t={t} />)

    await screen.findByRole('img', { name: 'Live computer screen' })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await screen.findByRole('button', { name: 'Hand back' })
    view.unmount()

    expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, 'bot-session')
  })

  it('sends bounded pointer, keyboard, and scroll input through the selected Session', async () => {
    const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
    const frame = vi.fn<ComputerClient['frame']>()
      .mockResolvedValueOnce(watchingFrame)
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
    const computer = makeComputer({ frame, input })
    render(<ComputerPanel computer={computer} sessionId="bot-session" close={vi.fn()} t={t} />)

    const image = await screen.findByRole('img', { name: 'Live computer screen' })
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120,
      x: 10, y: 20, toJSON: () => ({}),
    })
    Object.defineProperty(image, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(image, 'hasPointerCapture', { configurable: true, value: vi.fn(() => true) })
    Object.defineProperty(image, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await screen.findByRole('button', { name: 'Hand back' })

    fireEvent.pointerDown(image, { pointerId: 7, button: 0, clientX: 110, clientY: 70 })
    fireEvent.pointerUp(image, { pointerId: 7, button: 0, clientX: 110, clientY: 70 })
    fireEvent.keyDown(image, { key: 'ArrowUp', ctrlKey: true })
    fireEvent.wheel(image, { clientX: 110, clientY: 70, deltaY: 200 })

    await waitFor(() => { expect(input).toHaveBeenCalledTimes(3) })
    expect(input).toHaveBeenNthCalledWith(1, expect.any(String), { kind: 'click', x: 50, y: 25, button: 1 }, undefined, 'bot-session')
    expect(input).toHaveBeenNthCalledWith(2, expect.any(String), { kind: 'key', key: 'Ctrl+Up' }, undefined, 'bot-session')
    expect(input).toHaveBeenNthCalledWith(3, expect.any(String), { kind: 'scroll', x: 50, y: 25, delta: 2 }, undefined, 'bot-session')
  })

  it('shows a disconnected or unavailable phase and checks local sharing after a frame error', async () => {
    const checkSharing = vi.fn()
    const frame = vi.fn<ComputerClient['frame']>().mockRejectedValue(new ComputerApiError(404, 'missing'))
    const computer = makeComputer({ frame })
    render(<ComputerPanel computer={computer} close={vi.fn()} local={{ checkSharing }} t={t} />)

    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer control is unavailable') })
    expect(checkSharing).toHaveBeenCalledOnce()
  })
})
