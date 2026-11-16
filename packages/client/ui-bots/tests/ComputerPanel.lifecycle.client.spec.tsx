// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerApiError, type ComputerClient, type ComputerFrame } from '../src/client/computer-client.ts'
import { ComputerPanel } from '../src/client/ComputerPanel.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

function makeComputer(jpeg: string, overrides: Partial<ComputerClient> = {}): ComputerClient {
  const frame: ComputerFrame = { jpeg, width: 100, height: 50, mode: 'watching', botActive: false }
  return {
    status: vi.fn<ComputerClient['status']>().mockResolvedValue({ available: true }),
    frame: vi.fn<ComputerClient['frame']>().mockResolvedValueOnce(frame).mockImplementation((_viewerId, signal) =>
      new Promise<ComputerFrame>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      })),
    takeControl: vi.fn<ComputerClient['takeControl']>().mockResolvedValue({ mode: 'controlling' }),
    releaseControl: vi.fn<ComputerClient['releaseControl']>().mockResolvedValue({ mode: 'watching' }),
    input: vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' }),
    ...overrides,
  }
}

async function takeControl(jpeg: string): Promise<HTMLElement> {
  const image = await waitFor(() => {
    const current = screen.getByRole('img', { name: 'Live computer screen' })
    expect(current.getAttribute('src')).toBe(`data:image/jpeg;base64,${jpeg}`)
    return current
  })
  fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
  await screen.findByRole('button', { name: 'Hand back' })
  return image
}

afterEach(cleanup)

it('sends input to a replacement Computer while the previous request is pending', async () => {
  const firstRequest = Promise.withResolvers<Awaited<ReturnType<ComputerClient['input']>>>()
  onTestFinished(() => { firstRequest.resolve({ mode: 'watching' }) })
  const firstInput = vi.fn<ComputerClient['input']>().mockReturnValueOnce(firstRequest.promise)
    .mockResolvedValue({ mode: 'controlling' })
  const secondInput = vi.fn<ComputerClient['input']>().mockResolvedValue({ mode: 'controlling' })
  const first = makeComputer('first', { input: firstInput })
  const second = makeComputer('second', { input: secondInput })
  const close = vi.fn()
  const view = render(<ComputerPanel computer={first} close={close} t={t} />)

  const firstImage = await takeControl('first')
  await act(async () => { fireEvent.keyDown(firstImage, { key: 'a' }) })
  fireEvent.keyDown(firstImage, { key: 'b' })
  view.rerender(<ComputerPanel computer={second} close={close} t={t} />)
  const secondImage = await takeControl('second')
  await act(async () => { fireEvent.keyDown(secondImage, { key: 'c' }) })
  expect(firstInput).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'key', key: 'a' })
  expect(secondInput).toHaveBeenCalledExactlyOnceWith(expect.any(String), { kind: 'key', key: 'c' })

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
  const first = makeComputer('first', { input: firstInput })
  const second = makeComputer('second', { input: secondInput })
  const close = vi.fn()
  const view = render(<ComputerPanel computer={first} close={close} t={t} />)

  await takeControl('first')
  fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
  expect(readText).toHaveBeenCalledOnce()
  view.rerender(<ComputerPanel computer={second} close={close} t={t} />)
  await takeControl('second')

  await act(async () => {
    if (outcome === 'resolved') read.resolve('old clipboard text')
    else read.reject(new Error('clipboard read denied'))
  })
  expect(firstInput).not.toHaveBeenCalled()
  expect(secondInput).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})
