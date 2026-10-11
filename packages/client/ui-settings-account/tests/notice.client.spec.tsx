// @vitest-environment jsdom
/**
 * The bonus notice card reports display only when the server's copy is
 * actually on screen: it needs an anchor position, a visible document, and one
 * presented frame. Closing counts as seen because the user acted on it.
 */
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountBonusOrderId } from '@deepseek-ai/dsh-deepseek-account/types'
import { AccountNoticeCard } from '../src/client/AccountNotice.tsx'

const disconnect = vi.fn()
let visibility: 'visible' | 'hidden' = 'visible'
/** Frame callbacks the card scheduled, in order. */
let frames: (() => void)[] = []
/** @param value - visibility the card observes. */
function setVisibility(value: 'visible' | 'hidden'): void {
  visibility = value
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  visibility = 'visible'
  frames = []
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  // jsdom drives requestAnimationFrame from its own clock, so the test presents frames explicitly.
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); disconnect.mockClear() })

function mount(id: string, onShown = vi.fn(), onDismiss = vi.fn()) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect })
  const anchor = createRef<HTMLDivElement>()
  const view = render(<>
    <div ref={anchor} style={{ position: 'absolute', left: 40, top: 200 }} />
    <AccountNoticeCard key={id} anchor={anchor} title="Bonus credited" closeLabel="Close"
      notice={{ orderId: id as AccountBonusOrderId, message: 'Server copy 5.00', expiresAt: '2099-01-01T00:00:00Z' }}
      onShown={onShown} onDismiss={onDismiss} />
  </>)
  return { view, onShown, onDismiss }
}

/**
 * Present every scheduled frame, then run the following task that reports the display.
 * @param after - hook between the frame and its follow-up task.
 */
async function presentFrames(after?: () => void): Promise<void> {
  await act(async () => {
    for (const frame of frames.splice(0)) frame()
    after?.()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
  })
}

it('renders server copy without moving focus and reports display after a presented frame', async () => {
  const initialFocus = document.activeElement
  const { onShown, onDismiss } = mount('order-1')
  expect(screen.getByRole('status').textContent).toBe('Bonus creditedServer copy 5.00')
  expect(document.activeElement).toBe(initialFocus)
  await expect(`${screen.getByRole('status').textContent}\n`).toMatchFileSnapshot('./expected/notice.txt')
  expect(onShown).not.toHaveBeenCalled()
  await presentFrames()
  expect(onShown).toHaveBeenCalledWith('order-1')
  expect(onDismiss).not.toHaveBeenCalled()
})

it('defers the display report until the document is visible', async () => {
  setVisibility('hidden')
  const { onShown } = mount('order-1')
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  setVisibility('visible')
  await presentFrames()
  expect(onShown).toHaveBeenCalledOnce()
})

it('waits for another visible frame when the document hides before the follow-up task', async () => {
  const onShown = vi.fn()
  mount('order-1', onShown)
  // The frame presents, then the window hides before the after-paint task runs.
  await presentFrames(() => { setVisibility('hidden') })
  expect(onShown).not.toHaveBeenCalled()
  setVisibility('visible')
  expect(onShown).not.toHaveBeenCalled()
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('order-1')
})

it('reports dismissal so closing the card counts as seen', async () => {
  const { onShown, onDismiss } = mount('order-1')
  await presentFrames()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onDismiss).toHaveBeenCalledWith('order-1')
  expect(onShown).toHaveBeenCalledOnce()
})

it('reports neither display nor dismissal when unmounted before its frame', async () => {
  const onShown = vi.fn()
  const onDismiss = vi.fn()
  const { view } = mount('order-1', onShown, onDismiss)
  view.unmount()
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  expect(onDismiss).not.toHaveBeenCalled()
})

it('does not render an award that expired before the card mounted', async () => {
  const onShown = vi.fn()
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  mount('order-1', onShown)
  expect(screen.queryByRole('status')).toBeNull()
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
})

it('reports display from the following task when the host has no frame clock', () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', undefined)
  const { onShown } = mount('order-1')
  expect(onShown).not.toHaveBeenCalled()
  act(() => { vi.runAllTimers() })
  expect(onShown).toHaveBeenCalledExactlyOnceWith('order-1')
})

it.each([true, false])('cancels the presentation task when the card unmounts first (frame clock: %s)', (frameClock) => {
  vi.useFakeTimers()
  if (frameClock) {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  } else vi.stubGlobal('requestAnimationFrame', undefined)
  const onShown = vi.fn()
  const { view } = mount('order-1', onShown)
  act(() => { for (const frame of frames.splice(0)) frame() })
  view.unmount()
  act(() => { vi.runAllTimers() })
  expect(onShown).not.toHaveBeenCalled()
})

function inlineNotice() {
  let notifyIntersection: ((entries: IntersectionObserverEntry[]) => void) | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: IntersectionObserverEntry[]) => void) { notifyIntersection = callback }
    observe() {}
    disconnect() {}
  })
  const onShown = vi.fn()
  const onDismiss = vi.fn()
  const view = render(<section aria-label="DeepSeek connection">
    <AccountNoticeCard inline title="Bonus credited" closeLabel="Close"
      notice={{ orderId: 'inline-order' as AccountBonusOrderId, message: 'Provider bonus', expiresAt: '2099-01-01T00:00:00Z' }}
      onShown={onShown} onDismiss={onDismiss} />
  </section>)
  const region = screen.getByRole('region', { name: 'DeepSeek connection' })
  const card = region.querySelector('aside')!
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 20, right: 280, bottom: 160, width: 260, height: 140, x: 20, y: 20, toJSON() {} })
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => card })
  const intersect = (visible: boolean) => {
    act(() => {
      const bounds = card.getBoundingClientRect()
      const entry: IntersectionObserverEntry = {
        target: card, isIntersecting: visible, intersectionRatio: visible ? 1 : 0,
        boundingClientRect: bounds, intersectionRect: visible ? bounds : new DOMRect(),
        rootBounds: null, time: performance.now(),
      }
      notifyIntersection?.([entry])
    })
  }
  return { view, region, card, onShown, onDismiss, intersect }
}

it('reports an inline provider notice only after it enters the Models viewport', async () => {
  const { region, onShown, intersect } = inlineNotice()
  expect(within(region).getByRole('status').textContent).toContain('Provider bonus')
  intersect(false)
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  intersect(true)
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('inline-order')
})

it.each(['inert', 'aria-hidden', 'ancestor-opacity', 'native-cover', 'hit-test-cover'] as const)('does not acknowledge an inline notice behind %s', async (cover) => {
  const { region, card, onShown, intersect } = inlineNotice()
  const layer = document.createElement('div')
  if (cover === 'inert') region.setAttribute('inert', '')
  else if (cover === 'aria-hidden') region.setAttribute('aria-hidden', 'true')
  else if (cover === 'ancestor-opacity') region.style.opacity = '0'
  else if (cover === 'native-cover') { layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-modal', 'true'); document.body.append(layer) }
  else Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => layer })
  intersect(true)
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
  region.removeAttribute('inert')
  region.removeAttribute('aria-hidden')
  region.style.opacity = ''
  layer.remove()
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => card })
  fireEvent.scroll(region)
  await presentFrames()
  expect(onShown).toHaveBeenCalledExactlyOnceWith('inline-order')
})

it('cancels an inline presentation when the provider region becomes hidden before its frame', async () => {
  const { region, onShown, intersect } = inlineNotice()
  intersect(true)
  await presentFrames(() => { region.setAttribute('aria-hidden', 'true') })
  expect(onShown).not.toHaveBeenCalled()
})

it('cancels an intersecting inline presentation when Models closes before its frame', async () => {
  const { view, onShown, intersect } = inlineNotice()
  intersect(true)
  expect(frames.length).toBeGreaterThan(0)
  view.unmount()
  await presentFrames()
  expect(onShown).not.toHaveBeenCalled()
})
