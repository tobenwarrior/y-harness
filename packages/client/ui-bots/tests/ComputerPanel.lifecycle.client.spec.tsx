// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerApiError, type ComputerClient, type ComputerFrame } from '../src/client/computer-client.ts'
import { ComputerAction } from '../src/client/ComputerAction.tsx'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

const watchingFrame: ComputerFrame = {
  jpeg: 'managed-screen', width: 100, height: 50, mode: 'watching', botActive: false,
}

function untilAbort<T>(signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
    if (signal?.aborted === true) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

function makeComputer(overrides: Partial<ComputerClient> = {}, jpeg = watchingFrame.jpeg): ComputerClient {
  return {
    status: vi.fn<ComputerClient['status']>().mockResolvedValue({ available: true }),
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce({ ...watchingFrame, jpeg })
      .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal)),
    takeControl: vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' }),
    releaseControl: vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' }),
    input: vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' }),
    ...overrides,
  }
}

async function takeComputerControl(jpeg = watchingFrame.jpeg): Promise<HTMLElement> {
  const image = await waitFor(() => {
    const current = screen.getByRole('img', { name: 'Live computer screen' })
    expect(current.getAttribute('src')).toBe(`data:image/jpeg;base64,${jpeg}`)
    return current
  })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })
  return image
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('shows which VPS desktop the Computer button will open', () => {
  const toggle = vi.fn()
  const view = render(<ComputerAction
    t={t} expanded={false} toggle={toggle} identity={{ location: 'vps', permissionScope: 'bot' }}
  />)
  const open = screen.getByRole('button', { name: en.computerOpen })
  expect(open.getAttribute('aria-pressed')).toBe('false')
  expect(within(open).getByText(en.computerScopeBotChip)).toBeTruthy()
  fireEvent.click(open)
  expect(toggle).toHaveBeenCalledOnce()

  view.rerender(<ComputerAction
    t={t} expanded toggle={toggle} identity={{ location: 'vps', permissionScope: 'workspace' }}
  />)
  const close = screen.getByRole('button', { name: en.computerClose })
  expect(close.getAttribute('aria-pressed')).toBe('true')
  expect(within(close).getByText(en.computerScopeWorkspaceChip)).toBeTruthy()
  expect(within(close).queryByText(en.computerScopeBotChip)).toBeNull()

  view.rerender(<ComputerAction t={t} expanded={false} toggle={toggle} />)
  const withoutIdentity = screen.getByRole('button', { name: en.computerOpen })
  expect(within(withoutIdentity).queryByText(en.computerScopeBotChip)).toBeNull()
  expect(within(withoutIdentity).queryByText(en.computerScopeWorkspaceChip)).toBeNull()
})

it('sends input to a replacement Computer while the previous request is pending', async () => {
  const firstRequest = Promise.withResolvers<Awaited<ReturnType<ComputerClient['input']>>>()
  onTestFinished(() => { firstRequest.resolve({ mode: 'watching' }) })
  const firstInput = vi.fn<ComputerClient['input']>().mockReturnValueOnce(firstRequest.promise)
    .mockResolvedValue({ mode: 'controlling' })
  const secondInput = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const first = makeComputer({ input: firstInput }, 'first')
  const second = makeComputer({ input: secondInput }, 'second')
  const close = vi.fn()
  const view = render(<ComputerPanel computer={first} close={close} t={t} />)

  const firstImage = await takeComputerControl('first')
  await act(async () => { fireEvent.keyDown(firstImage, { key: 'a' }) })
  fireEvent.keyDown(firstImage, { key: 'b' })
  view.rerender(<ComputerPanel computer={second} close={close} t={t} />)
  const secondImage = await takeComputerControl('second')
  await act(async () => { fireEvent.keyDown(secondImage, { key: 'c' }) })
  expect(firstInput).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'key', key: 'a' }, undefined, undefined, undefined)
  expect(secondInput).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'key', key: 'c' }, undefined, undefined, undefined)

  await act(async () => { firstRequest.reject(new ComputerApiError(409, 'old lease expired')) })
  expect(firstInput).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toContain('You are controlling')
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolved', 'rejected'])('ignores a %s clipboard read after the Computer changes', async (outcome) => {
  const read = Promise.withResolvers<string>()
  const readText = vi.fn(() => read.promise)
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
  onTestFinished(() => {
    if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', clipboard)
    read.resolve('')
  })
  const firstInput = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const secondInput = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const first = makeComputer({ input: firstInput }, 'first')
  const second = makeComputer({ input: secondInput }, 'second')
  const close = vi.fn()
  const view = render(<ComputerPanel computer={first} close={close} t={t} />)

  await takeComputerControl('first')
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
  expect(readText).toHaveBeenCalledOnce()
  view.rerender(<ComputerPanel computer={second} close={close} t={t} />)
  await takeComputerControl('second')

  await act(async () => {
    if (outcome === 'resolved') read.resolve('old clipboard text')
    else read.reject(new Error('clipboard read denied'))
  })
  expect(firstInput).not.toHaveBeenCalled()
  expect(secondInput).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('hands back a control lease that arrives after the panel closes', async () => {
  const grant = Promise.withResolvers<Awaited<ReturnType<ComputerClient['takeControl']>>>()
  onTestFinished(() => { grant.resolve({ mode: 'watching' }) })
  const takeControl = vi.fn<ComputerClient['takeControl']>().mockReturnValue(grant.promise)
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockRejectedValue(new Error('late release'))
  const computer = makeComputer({ takeControl, releaseControl })
  const panel = render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  const take = screen.getByRole('button', { name: 'Take control' })
  fireEvent.click(take)
  expect(take).toHaveProperty('disabled', true)
  fireEvent.click(take)
  expect(takeControl).toHaveBeenCalledExactlyOnceWith(expect.any(String), undefined, undefined)
  panel.unmount()
  expect(releaseControl).not.toHaveBeenCalled()

  await act(async () => { grant.resolve({ mode: 'controlling' }) })
  expect(releaseControl).toHaveBeenCalledExactlyOnceWith(expect.any(String), { keepalive: true }, undefined)
})

it.each(['watching', 'rejected'] as const)('ignores a late %s control request after the Computer changes', async (reply) => {
  const grant = Promise.withResolvers<Awaited<ReturnType<ComputerClient['takeControl']>>>()
  onTestFinished(() => { grant.resolve({ mode: 'watching' }) })
  const takeControl = vi.fn<ComputerClient['takeControl']>().mockReturnValue(grant.promise)
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  const original = makeComputer({ takeControl, releaseControl }, 'original')
  const replacement = makeComputer({}, 'replacement')
  const close = vi.fn()
  const panel = render(<ComputerPanel computer={original} close={close} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  panel.rerender(<ComputerPanel computer={replacement} close={close} t={t} />)
  await screen.findByRole('img', { name: 'Live computer screen' })
  const take = screen.getByRole('button', { name: 'Take control' })
  expect(take).toHaveProperty('disabled', false)
  fireEvent.click(take)
  await screen.findByRole('button', { name: 'Hand back' })
  await act(async () => {
    if (reply === 'rejected') grant.reject(new ComputerApiError(409, 'stale lease'))
    else grant.resolve({ mode: 'watching' })
  })

  expect(screen.getByRole('status').textContent).toContain('You are controlling')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(releaseControl).not.toHaveBeenCalled()
})

it('returns a delayed lease to the original Bot when switching Sessions', async () => {
  const grant = Promise.withResolvers<Awaited<ReturnType<ComputerClient['takeControl']>>>()
  onTestFinished(() => { grant.resolve({ mode: 'watching' }) })
  const takeControl = vi.fn<ComputerClient['takeControl']>().mockReturnValueOnce(grant.promise)
    .mockResolvedValue({ mode: 'controlling' })
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  const frame = vi.fn<ComputerClient['frame']>().mockResolvedValueOnce({ ...watchingFrame, jpeg: 'first' })
    .mockResolvedValueOnce({ ...watchingFrame, jpeg: 'second' })
    .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
  const computer = makeComputer({ frame, takeControl, releaseControl })
  const close = vi.fn()
  const panel = render(<ComputerPanel computer={computer} close={close} sessionId="first" t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  panel.rerender(<ComputerPanel computer={computer} close={close} sessionId="second" t={t} />)
  await takeComputerControl('second')
  await act(async () => { grant.resolve({ mode: 'controlling' }) })

  const [firstViewer] = takeControl.mock.calls[0] ?? []
  const [secondViewer] = takeControl.mock.calls[1] ?? []
  expect(firstViewer).not.toBe(secondViewer)
  expect(releaseControl).toHaveBeenCalledExactlyOnceWith(firstViewer, { keepalive: true }, 'first')
  expect(screen.getByRole('status').textContent).toContain('You are controlling')
})

it('reports a failed lease release during teardown without rejecting the panel', async () => {
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockRejectedValue(new Error('teardown release'))
  const computer = makeComputer({ releaseControl })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const panel = render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  await takeComputerControl()
  panel.unmount()

  await waitFor(() => { expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, undefined) })
  await waitFor(() => { expect(warning).toHaveBeenCalledWith('Computer lease release failed:', expect.any(Error)) })
})

it('releases an active lease with keepalive during teardown', async () => {
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  const computer = makeComputer({ releaseControl })
  const view = render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  await takeComputerControl()
  view.unmount()

  expect(releaseControl).toHaveBeenCalledWith(expect.any(String), { keepalive: true }, undefined)
})

it('sends bounded pointer, keyboard, and scroll input while controlling the Computer', async () => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const computer = makeComputer({ input })
  render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

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
  expect(input).toHaveBeenNthCalledWith(1, expect.any(String), { kind: 'click', x: 50, y: 25, button: 1 }, undefined, undefined, undefined)
  expect(input).toHaveBeenNthCalledWith(2, expect.any(String), { kind: 'key', key: 'Ctrl+Up' }, undefined, undefined, undefined)
  expect(input).toHaveBeenNthCalledWith(3, expect.any(String), { kind: 'scroll', x: 50, y: 25, delta: 2 }, undefined, undefined, undefined)
})

it('shows a disconnected or unavailable phase and checks local sharing after a frame error', async () => {
  const checkSharing = vi.fn()
  const frame = vi.fn<ComputerClient['frame']>().mockRejectedValue(new ComputerApiError(404, 'missing'))
  const computer = makeComputer({ frame })
  render(<ComputerPanel computer={computer} close={vi.fn()} local={{ checkSharing }} t={t} />)

  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('Computer control is unavailable') })
  expect(checkSharing).toHaveBeenCalledOnce()
})

it('retries a disconnected stream and resumes polling after a frame arrives', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const frame = vi.fn<ComputerClient['frame']>()
    .mockRejectedValueOnce(new Error('transport closed'))
    .mockResolvedValueOnce({ ...watchingFrame, botActive: true })
    .mockResolvedValueOnce({ ...watchingFrame, mode: 'other' })
  const computer = makeComputer({ frame })
  const close = vi.fn()
  const view = render(<ComputerPanel computer={computer} close={close} t={t} />)

  await act(async () => {})
  expect(screen.getByRole('status').textContent).toContain('Computer connection lost')
  const viewport = view.container.querySelector('[data-computer-viewport]')
  if (!(viewport instanceof HTMLElement)) throw new Error('The Computer viewport is unavailable.')
  await act(async () => { fireEvent.click(within(viewport).getByRole('button', { name: 'Retry' })) })
  expect(screen.getByRole('status').textContent).toContain('Bot is using the computer')
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(screen.getByRole('status').textContent).toContain('Another controller is active')
  expect(frame).toHaveBeenCalledTimes(3)

  fireEvent.click(screen.getByRole('button', { name: 'Close computer panel' }))
  expect(close).toHaveBeenCalledOnce()
  view.unmount()
  await vi.advanceTimersByTimeAsync(300)
  expect(frame).toHaveBeenCalledTimes(3)
})

it('retains the last frame and disconnected status until a retry returns', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const resumed = Promise.withResolvers<ComputerFrame>()
  onTestFinished(() => { resumed.resolve(watchingFrame) })
  const frame = vi.fn<ComputerClient['frame']>().mockResolvedValueOnce(watchingFrame)
    .mockRejectedValueOnce(new Error('transport closed')).mockReturnValueOnce(resumed.promise)
  render(<ComputerPanel computer={makeComputer({ frame })} close={vi.fn()} t={t} />)

  await act(async () => {})
  const image = screen.getByRole('img', { name: 'Live computer screen' })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.getByRole('img', { name: 'Live computer screen' })).toBe(image)
  expect(screen.getByRole('status').textContent).toContain('Computer connection lost')

  await act(async () => { resumed.resolve(watchingFrame) })
  expect(screen.getByRole('status').textContent).toContain('Watching')
})

it.each([
  [409, 'Another controller is active', 'Control is currently held by someone else. Try again.'],
  [404, 'Computer control is unavailable', undefined],
  [500, 'Computer connection lost', undefined],
])('reports a failed control request with HTTP %s', async (code, status, alert) => {
  const takeControl = vi.fn<ComputerClient['takeControl']>().mockRejectedValue(new ComputerApiError(code, 'lease request failed'))
  const computer = makeComputer({ takeControl })
  render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Take control' })) })
  expect(screen.getByRole('status').textContent).toContain(status)
  expect(screen.queryByRole('alert')?.textContent).toBe(alert)
})

it('drops an in-flight frame captured before the human received control', async () => {
  const captured = Promise.withResolvers<ComputerFrame>()
  const frame = vi.fn<ComputerClient['frame']>().mockReturnValueOnce(captured.promise)
    .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
  const computer = makeComputer({ frame })
  render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })
  await act(async () => { captured.resolve(watchingFrame) })
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeTruthy()
  expect(screen.queryByRole('img', { name: 'Live computer screen' })).toBeNull()
  expect(frame).toHaveBeenCalledTimes(2)
})

it('keeps a lease when a stale frame request fails and retries a later connection failure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const stale = Promise.withResolvers<ComputerFrame>()
  const frame = vi.fn<ComputerClient['frame']>()
    .mockReturnValueOnce(stale.promise)
    .mockRejectedValueOnce(new Error('stream disconnected'))
    .mockResolvedValueOnce({ ...watchingFrame, mode: 'controlling' })
  render(<ComputerPanel computer={makeComputer({ frame })} close={vi.fn()} t={t} />)

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Take control' })) })
  await act(async () => { stale.reject(new Error('old request failed')) })
  expect(screen.getByRole('status').textContent).toContain('Computer connection lost')
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeTruthy()
  const retry = screen.getAllByRole('button', { name: 'Retry' })[0]
  if (retry === undefined) throw new Error('The Computer retry control is unavailable.')
  await act(async () => { fireEvent.click(retry) })
  expect(screen.getByRole('status').textContent).toContain('You are controlling')
  expect(frame).toHaveBeenCalledTimes(3)
})

it('shows the existing controller when the Host declines a lease without an HTTP error', async () => {
  const takeControl = vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'other' })
  render(<ComputerPanel computer={makeComputer({ takeControl })} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Control is currently held by someone else. Try again.')
  expect(screen.getByRole('status').textContent).toContain('Another controller is active')
  expect(screen.queryByRole('button', { name: 'Hand back' })).toBeNull()
})

it('stops frame polling quietly when the current request is cancelled', async () => {
  const frame = vi.fn<ComputerClient['frame']>().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
  render(<ComputerPanel computer={makeComputer({ frame })} close={vi.fn()} t={t} />)

  await act(async () => {})
  expect(frame).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toContain('Connecting to the computer')
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})

it('bounds pasted text and stops sending queued input after losing the lease', async () => {
  const delivery = Promise.withResolvers<Awaited<ReturnType<ComputerClient['input']>>>()
  const input = vi.fn<ComputerClient['input']>().mockReturnValue(delivery.promise)
  const computer = makeComputer({ input })
  render(<ComputerPanel computer={computer} close={vi.fn()} t={t} />)

  const image = await takeComputerControl()
  fireEvent.paste(image, { clipboardData: { getData: () => '' } })
  fireEvent.keyDown(image, { key: 'v', ctrlKey: true })
  fireEvent.paste(image, { clipboardData: { getData: () => 'x'.repeat(4097) } })
  expect(screen.getByRole('alert').textContent).toBe('Pasted text was shortened to fit the input limit.')
  fireEvent.keyDown(image, { key: 'Escape' })

  await waitFor(() => {
    expect(input).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      kind: 'text', text: 'x'.repeat(4096),
    }, undefined, undefined, undefined)
  })
  await act(async () => { delivery.reject(new ComputerApiError(409, 'lease expired')) })
  expect(screen.getByRole('alert').textContent).toBe('Control is currently held by someone else. Try again.')
  expect(input).toHaveBeenCalledTimes(1)
})

it('uses the physical keyboard and mouse while a native Mac lease is held', async () => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const computer = makeComputer({ input })
  const close = vi.fn()
  render(<ComputerPanel computer={computer} close={close} local={{ checkSharing: vi.fn() }} t={t} />)

  const image = await screen.findByRole('img', { name: 'Live computer screen' })
  expect(screen.getByText('This bot can see and control your Mac.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByText('Bot control is paused. Use your Mac directly.')
  fireEvent.keyDown(image, { key: 'Escape' })
  expect(screen.queryByRole('button', { name: 'Paste' })).toBeNull()
  expect(input).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }))
  expect(close).toHaveBeenCalledOnce()
})

it('scales a drag to the display and translates browser keys and scroll steps', async () => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  render(<ComputerPanel computer={makeComputer({ input })} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: 'Live computer screen' })
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}),
  })
  const capture = vi.fn()
  Object.defineProperty(image, 'setPointerCapture', { configurable: true, value: capture })
  Object.defineProperty(image, 'hasPointerCapture', { configurable: true, value: () => false })
  expect(fireEvent.contextMenu(image)).toBe(true)
  fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 30, clientY: 60 })
  fireEvent.pointerUp(image, { pointerId: 1, button: 0, clientX: 30, clientY: 60 })
  fireEvent.keyDown(image, { key: 'Escape' })
  fireEvent.paste(image, { clipboardData: { getData: () => 'watching' } })
  fireEvent.wheel(image, { clientX: 100, clientY: 100, deltaY: 100 })
  expect(input).not.toHaveBeenCalled()
  expect(capture).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })
  expect(fireEvent.contextMenu(image)).toBe(false)
  fireEvent.keyDown(image, { key: 'v', metaKey: true })
  fireEvent.pointerDown(image, { pointerId: 3, button: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerUp(image, { pointerId: 4, button: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerDown(image, { pointerId: 5, button: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerUp(image, { pointerId: 5, button: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerDown(image, { pointerId: 6, button: 2, clientX: 30, clientY: 40 })
  fireEvent.pointerUp(image, { pointerId: 6, button: 2, clientX: 210, clientY: 160 })
  fireEvent.keyDown(image, { key: 'Dead', code: '' })
  fireEvent.keyDown(image, { key: 'Unidentified', code: 'F12' })
  fireEvent.keyDown(image, { key: 'k', altKey: true, shiftKey: true, metaKey: true })
  fireEvent.wheel(image, { clientX: 100, clientY: 100, deltaY: 0 })
  fireEvent.wheel(image, { clientX: 100, clientY: 100, deltaY: -1 })
  fireEvent.paste(image, { clipboardData: { getData: () => 'hello' } })

  await waitFor(() => { expect(input).toHaveBeenCalledTimes(6) })
  expect(input.mock.calls.map(([, action]) => action)).toEqual([
    { kind: 'click', x: 15, y: 0, button: 2 },
    { kind: 'drag', x: 15, y: 0, toX: 99, toY: 49 },
    { kind: 'key', key: 'F12' },
    { kind: 'key', key: 'Alt+Shift+Super+k' },
    { kind: 'scroll', x: 50, y: 25, delta: -1 },
    { kind: 'text', text: 'hello' },
  ])
})

it.each([404, 409])('keeps control available for a retry when handing back returns HTTP %s', async (code) => {
  const releaseControl = vi.fn<ComputerClient['releaseControl']>()
    .mockRejectedValueOnce(new ComputerApiError(code, 'release failed'))
    .mockResolvedValue({ mode: 'watching' })
  render(<ComputerPanel computer={makeComputer({ releaseControl })} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Hand back' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(code === 404
    ? 'That input could not be sent. Try again.' : 'Control is currently held by someone else. Try again.')
  fireEvent.click(screen.getByRole('button', { name: 'Hand back' }))
  await screen.findByRole('button', { name: 'Take control' })
  expect(releaseControl).toHaveBeenCalledTimes(2)
})

it.each([404, 500])('reports a rejected input without accepting it as sent for HTTP %s', async (code) => {
  const input = vi.fn<ComputerClient['input']>().mockRejectedValue(new ComputerApiError(code, 'input failed'))
  render(<ComputerPanel computer={makeComputer({ input })} close={vi.fn()} t={t} />)

  const image = await takeComputerControl()
  await act(async () => { fireEvent.keyDown(image, { key: 'Escape' }) })
  expect(input).toHaveBeenCalledOnce()
  if (code === 404) expect(screen.getByRole('status').textContent).toContain('Computer control is unavailable')
  else expect(screen.getByRole('alert').textContent).toBe('That input could not be sent. Try again.')
})

it('reports unavailable clipboard access and sends text only after a successful read', async () => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const navigatorClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const readText = vi.fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error('permission refused')).mockResolvedValueOnce('clipboard text')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    render(<ComputerPanel computer={makeComputer({ input })} close={vi.fn()} t={t} />)
    await screen.findByRole('img', { name: 'Live computer screen' })
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    await screen.findByRole('button', { name: 'Hand back' })
    const paste = screen.getByRole('button', { name: 'Paste' })
    fireEvent.click(paste)
    expect(screen.getByRole('alert').textContent).toBe('Clipboard text could not be read.')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
    await act(async () => { fireEvent.click(paste) })
    expect(warning).toHaveBeenCalledOnce()
    expect(input).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(paste) })
    expect(input).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'text', text: 'clipboard text' }, undefined, undefined, undefined)
  } finally {
    if (navigatorClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', navigatorClipboard)
  }
})

it.each(['resolved', 'rejected'] as const)('ignores a %s clipboard read after handing back control', async (reply) => {
  const read = Promise.withResolvers<string>()
  const readText = vi.fn(() => read.promise)
  const navigatorClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } })
  onTestFinished(() => {
    if (navigatorClipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', navigatorClipboard)
    read.resolve('')
  })
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  render(<ComputerPanel computer={makeComputer({ input })} close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  const handback = await screen.findByRole('button', { name: 'Hand back' })
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
  expect(readText).toHaveBeenCalledOnce()
  fireEvent.click(handback)
  fireEvent.click(await screen.findByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })

  await act(async () => {
    if (reply === 'resolved') read.resolve('text from the previous lease')
    else read.reject(new Error('permission refused'))
  })
  expect(input).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores a handback click after a poll reports another controller', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const updated = Promise.withResolvers<ComputerFrame>()
  onTestFinished(() => { updated.resolve(watchingFrame) })
  const frame = vi.fn<ComputerClient['frame']>().mockResolvedValueOnce(watchingFrame).mockReturnValueOnce(updated.promise)
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  render(<ComputerPanel computer={makeComputer({ frame, releaseControl })} close={vi.fn()} t={t} />)
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Take control' })) })
  const handback = screen.getByRole('button', { name: 'Hand back' })
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })

  await act(async () => {
    updated.resolve({ ...watchingFrame, mode: 'other' })
    await Promise.resolve()
    fireEvent.click(handback)
  })
  expect(screen.getByRole('status').textContent).toContain('Another controller is active')
  expect(releaseControl).not.toHaveBeenCalled()
})

it.each(['accepted', 'rejected'] as const)('ignores a pending handback %s after unmount', async (reply) => {
  const handback = Promise.withResolvers<{ mode: 'watching' }>()
  const releaseControl = vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' })
  const view = render(<ComputerPanel computer={makeComputer({ releaseControl })}
    close={vi.fn()} t={t} />)

  await screen.findByRole('img', { name: 'Live computer screen' })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  const button = await screen.findByRole('button', { name: 'Hand back' })
  releaseControl.mockReturnValueOnce(handback.promise)
  await act(async () => { fireEvent.click(button) })
  expect(releaseControl).toHaveBeenCalledOnce()
  expect(button).toHaveProperty('disabled', true)
  fireEvent.click(button)
  expect(releaseControl).toHaveBeenCalledOnce()
  view.unmount()
  expect(releaseControl).toHaveBeenNthCalledWith(2, expect.any(String), { keepalive: true }, undefined)
  await act(async () => {
    if (reply === 'accepted') handback.resolve({ mode: 'watching' })
    else handback.reject(new ComputerApiError(409, 'late reply'))
  })
  expect(releaseControl).toHaveBeenCalledTimes(2)
})

it('limits queued input while the current delivery is pending', async () => {
  const delivery = Promise.withResolvers<{ mode: 'controlling' }>()
  const input = vi.fn<ComputerClient['input']>().mockReturnValueOnce(delivery.promise).mockResolvedValue({ mode: 'controlling' })
  render(<ComputerPanel computer={makeComputer({ input })} close={vi.fn()} t={t} />)

  const image = await takeComputerControl()
  try {
    await act(async () => {
      for (let index = 0; index < 65; index++) fireEvent.keyDown(image, { key: 'Escape' })
    })
    expect(input).toHaveBeenCalledOnce()
  } finally {
    await act(async () => { delivery.resolve({ mode: 'controlling' }) })
  }
  expect(input).toHaveBeenCalledTimes(64)
})

it.each(['collapsed viewport', 'invalid frame scale'] as const)('ignores pointer gestures with %s', async (geometry) => {
  const input = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const frame = vi.fn<ComputerClient['frame']>().mockResolvedValueOnce(
    geometry === 'invalid frame scale' ? { ...watchingFrame, width: 0, height: 0 } : watchingFrame,
  )
    .mockImplementation((_viewerId, signal) => untilAbort<ComputerFrame>(signal))
  render(<ComputerPanel computer={makeComputer({ frame, input })} close={vi.fn()} t={t} />)

  const image = await screen.findByRole('img', { name: 'Live computer screen' })
  const rectangle = vi.spyOn(image, 'getBoundingClientRect')
  const capture = vi.fn()
  Object.defineProperty(image, 'setPointerCapture', { configurable: true, value: capture })
  Object.defineProperty(image, 'hasPointerCapture', { configurable: true, value: () => false })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })
  const visible = new DOMRect(0, 0, 200, 100)
  const collapsed = new DOMRect(0, 0, 0, 0)
  rectangle.mockReturnValue(geometry === 'collapsed viewport' ? collapsed : visible)
  fireEvent.pointerDown(image, { pointerId: 1, button: 0, clientX: 2, clientY: 2 })
  fireEvent.wheel(image, { clientX: 2, clientY: 2, deltaY: 100 })
  expect(capture).not.toHaveBeenCalled()

  if (geometry === 'collapsed viewport') {
    rectangle.mockReturnValue(visible)
    fireEvent.pointerDown(image, { pointerId: 2, button: 0, clientX: 2, clientY: 2 })
    rectangle.mockReturnValue(collapsed)
    fireEvent.pointerUp(image, { pointerId: 2, button: 0, clientX: 3, clientY: 3 })
    expect(capture).toHaveBeenCalledExactlyOnceWith(2)
  }
  await act(async () => {})
  expect(input).not.toHaveBeenCalled()
})
