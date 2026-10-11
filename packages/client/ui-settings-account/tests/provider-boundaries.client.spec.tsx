// @vitest-environment jsdom
/** Provider dialogs and bonus cards respect close actions, layout and the containing modal. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { AccountBonusOrderId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountSection, type AccountSectionInjected, type AccountSectionProps, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import { AccountNoticeCard } from '../src/client/AccountNotice.tsx'
import { en } from '../src/client/locales.ts'

const unavailableHook = () => { throw new Error('provider component requested an unrelated global hook') }
const globals: GlobalStandardProps = {
  usePanelInfo: unavailableHook, useSessions: unavailableHook, useSessionStatus: unavailableHook,
  useSessionRetainInfo: unavailableHook, useResource: unavailableHook, useWorkspaces: unavailableHook,
}
const theme: ThemeSnapshot = { style: 'default', preference: 'light', fontSize: 14,
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0 }
const dictionary = { ...commonEn, ...en }
let frames: (() => void)[]
const elementFromPointBefore = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')

beforeEach(() => {
  frames = []
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (elementFromPointBefore === undefined) Reflect.deleteProperty(document, 'elementFromPoint')
  else Object.defineProperty(document, 'elementFromPoint', elementFromPointBefore)
})

function inlineNotice(modal: boolean) {
  let intersection: ((entries: IntersectionObserverEntry[]) => void) | undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: IntersectionObserverEntry[]) => void) { intersection = callback }
    observe() {}
    disconnect() {}
  })
  const onShown = vi.fn()
  const body = <AccountNoticeCard inline title="Provider bonus" closeLabel="Close"
    notice={{ orderId: 'visible-provider-bonus' as AccountBonusOrderId, message: 'Local test copy', expiresAt: '2099-01-01T00:00:00Z' }}
    onShown={onShown} onDismiss={vi.fn()} />
  render(modal ? <div role="dialog" aria-modal="true">{body}</div> : body)
  const card = screen.getByRole('status').closest('aside')
  if (card === null) throw new Error('provider bonus card was not rendered')
  let width = 240
  let height = 120
  vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => new DOMRect(20, 20, width, height))
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => card })
  const intersect = (target: Element = card) => {
    const bounds = target.getBoundingClientRect()
    const entry: IntersectionObserverEntry = { target, isIntersecting: true, intersectionRatio: 1,
      boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null, time: performance.now() }
    act(() => { intersection?.([entry]) })
  }
  const resize = (nextWidth: number, nextHeight: number) => {
    width = nextWidth; height = nextHeight
    fireEvent(window, new Event('resize'))
  }
  return { card, onShown, intersect, resize }
}

function paint(): void {
  act(() => {
    for (const callback of frames.splice(0)) callback()
    vi.runOnlyPendingTimers()
  })
}

it.each(['width', 'height'] as const)('waits for a positive card %s before reporting a provider bonus', (dimension) => {
  const notice = inlineNotice(false)
  notice.resize(dimension === 'width' ? 0 : 240, dimension === 'height' ? 0 : 120)
  notice.intersect()
  paint()
  expect(notice.onShown).not.toHaveBeenCalled()
  notice.resize(240, 120)
  paint()
  expect(notice.onShown).toHaveBeenCalledExactlyOnceWith('visible-provider-bonus')
})

it('reports a bonus inside its containing modal only after the card intersection arrives', () => {
  const notice = inlineNotice(true)
  const unrelated = document.createElement('div')
  document.body.append(unrelated)
  notice.intersect(unrelated)
  paint()
  expect(notice.onShown).not.toHaveBeenCalled()
  notice.intersect()
  paint()
  expect(notice.onShown).toHaveBeenCalledExactlyOnceWith('visible-provider-bonus')
  unrelated.remove()
})

it('closes an explicitly opened provider dialog without starting or cancelling authorization', () => {
  let snapshot: AccountSnapshot = {
    view: { status: 'signed-out', attempt: null,
      links: { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top-up' } },
    details: undefined, failed: false, loginVisible: true,
  }
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getSnapshot = () => snapshot
  const actions: AccountSectionInjected = {
    hooks: { account: { subscribe, getSnapshot }, theme: { subscribe: () => () => {}, getSnapshot: () => theme } },
    contactUs: vi.fn(), setOnboarding: vi.fn(), bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    refreshAccount: vi.fn(async () => {}), start: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    hasRunningAccountTasks: vi.fn(async () => false), signOut: vi.fn(async () => {}),
    showLogin: vi.fn((visible: boolean) => {
      snapshot = { ...snapshot, loginVisible: visible }
      for (const listener of listeners) listener()
    }),
  }
  const props: AccountSectionProps = {
    ...globals, ...actions,
    useAccount: selector => selector(useSyncExternalStore(subscribe, getSnapshot)),
    useTheme: selector => selector(theme), t: key => dictionary[key],
  }
  render(<AccountSection {...props} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: dictionary.close }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(actions.showLogin).toHaveBeenCalledExactlyOnceWith(false)
  expect(actions.start).not.toHaveBeenCalled()
  expect(actions.cancel).not.toHaveBeenCalled()
})
