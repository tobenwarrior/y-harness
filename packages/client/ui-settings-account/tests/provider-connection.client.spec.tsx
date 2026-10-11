// @vitest-environment jsdom
/** Optional DeepSeek connection belongs to Models, including its dialogs and notices. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { AccountBonusOrderId, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountSection, type AccountSectionInjected, type AccountSectionProps, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const links = { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' }
const theme: ThemeSnapshot = { style: 'default', preference: 'light', fontSize: 14,
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0 }
function fixture(state: AccountView | undefined, extra: Partial<AccountSnapshot> = {}) {
  let snapshot: AccountSnapshot = { view: state, details: undefined, failed: false, ...extra }
  const listeners = new Set<() => void>()
  const getSnapshot = () => snapshot
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const publish = (update: Partial<AccountSnapshot>) => {
    snapshot = { ...snapshot, ...update }
    for (const listener of listeners) listener()
  }
  const operations: AccountSectionInjected = {
    hooks: { account: { getSnapshot, subscribe },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} } },
    contactUs: vi.fn(), setOnboarding: vi.fn(),
    showLogin: vi.fn((visible: boolean) => { publish({ loginVisible: visible }) }),
    bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(), refreshAccount: vi.fn(async () => {}),
    start: vi.fn(async () => { publish({ loginVisible: true }) }), cancel: vi.fn(async () => {}),
    hasRunningAccountTasks: vi.fn(async () => false), signOut: vi.fn(async () => {}),
  }
  const props = (copy: typeof en | typeof zh = en) => {
    const dictionary = { ...(copy === zh ? commonZh : commonEn), ...copy }
    const t: AccountSectionProps['t'] = key => dictionary[key]
    return {
      ...({} as GlobalStandardProps), ...operations,
      useAccount: <T,>(selector: (value: AccountSnapshot) => T) => selector(useSyncExternalStore(subscribe, getSnapshot)),
      useTheme: <T,>(selector: (value: ThemeSnapshot) => T) => selector(theme),
      t,
    }
  }
  return { operations, publish, props }
}

it.each([{ copy: en, name: 'DeepSeek connection' }, { copy: zh, name: 'DeepSeek 连接' }])('renders an optional disconnected provider in Models ($name)', async ({ copy, name }) => {
  const f = fixture({ status: 'signed-out', attempt: null, links })
  const view = render(<AccountSection {...f.props(copy)} />)
  const card = screen.getByRole('region', { name })
  expect(within(card).getByRole('button', { name: copy.signIn })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.operations.start).not.toHaveBeenCalled()
  expect(f.operations.signOut).not.toHaveBeenCalled()
  expect(f.operations.refreshAccount).toHaveBeenCalledOnce()
  view.rerender(<AccountSection {...f.props(copy)} />)
  expect(f.operations.refreshAccount).toHaveBeenCalledOnce()
  view.unmount()
  render(<AccountSection {...f.props(copy)} />)
  expect(f.operations.refreshAccount).toHaveBeenCalledTimes(2)
})

it('keeps provider loading and offline state local without starting authorization', async () => {
  const f = fixture(undefined)
  render(<AccountSection {...f.props()} />)
  expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe(en.loading)
  await act(async () => { f.publish({ failed: true }) })
  expect(screen.getByRole('status').textContent).toBe(en.failed)
  expect(f.operations.start).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('retains a connected provider when profile and balance reads fail', () => {
  const f = fixture({ status: 'credential-stored', attempt: null, links }, {
    details: { profile: { status: 'failed' }, balance: { status: 'failed' } },
  })
  render(<AccountSection {...f.props()} />)
  const card = screen.getByRole('region', { name: 'DeepSeek connection' })
  expect(within(card).getByText(en.signedIn)).toBeTruthy()
  expect(within(card).getByRole('button', { name: en.signOut })).toBeTruthy()
  expect(within(card).getByRole('link', { name: en.usage }).getAttribute('href')).toBe(links.usageUrl)
  expect(within(card).getByRole('link', { name: en.topUp }).getAttribute('href')).toBe(links.topUpUrl)
  expect(f.operations.signOut).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('opens only an explicitly requested provider dialog and resumes it on return to Models', async () => {
  const f = fixture({ status: 'signed-out', attempt: { id: 'pending' as SignInAttemptId, phase: 'waiting-browser' }, links })
  const view = render(<AccountSection {...f.props()} />)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { f.publish({ loginVisible: true }) })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.addApiKey })).toBeNull()
  view.unmount()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.operations.cancel).not.toHaveBeenCalled()
  render(<AccountSection {...f.props()} />)
  expect(screen.getByRole('dialog')).toBeTruthy()
  await act(async () => { f.publish({ view: { status: 'credential-stored', attempt: { id: 'pending' as SignInAttemptId, phase: 'succeeded' }, links } }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.operations.showLogin).toHaveBeenLastCalledWith(false)
  expect(screen.getByRole('region', { name: 'DeepSeek connection' })).toBeTruthy()
})

it.each([false, true, 'unknown'] as const)('requires explicit provider disconnect confirmation after impact query (%s)', async (running) => {
  const f = fixture({ status: 'credential-stored', attempt: null, links })
  vi.mocked(f.operations.hasRunningAccountTasks).mockImplementation(async () => {
    if (running === 'unknown') throw new Error('offline')
    return running
  })
  render(<AccountSection {...f.props()} />)
  const card = screen.getByRole('region', { name: 'DeepSeek connection' })
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: en.signOut })) })
  expect(f.operations.hasRunningAccountTasks).toHaveBeenCalledOnce()
  expect(f.operations.signOut).not.toHaveBeenCalled()
  expect(screen.getByText(running === 'unknown' ? en.signOutUnknownDescription : running ? en.signOutRunningDescription : en.signOutDescription)).toBeTruthy()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.cancel }))
  expect(f.operations.signOut).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(within(card).getByRole('button', { name: en.signOut })) })
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.signOut })) })
  expect(f.operations.signOut).toHaveBeenCalledOnce()
})

it('discards a stale disconnect impact query after the provider session changes', async () => {
  const f = fixture({ status: 'credential-stored', attempt: null, links })
  const pending = Promise.withResolvers<boolean>()
  vi.mocked(f.operations.hasRunningAccountTasks).mockReturnValueOnce(pending.promise)
  render(<AccountSection {...f.props()} />)
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await act(async () => { f.publish({ view: { status: 'signed-out', attempt: null, links } }) })
  await act(async () => { pending.resolve(true); await pending.promise })
  await act(async () => { f.publish({ view: { status: 'credential-stored', attempt: null, links } }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.operations.signOut).not.toHaveBeenCalled()
})

it('contains a bonus notice in the provider card and cancels its display report when Models closes before paint', async () => {
  let frame: (() => void) | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const f = fixture({ status: 'credential-stored', attempt: null, links }, {
    notice: { orderId: 'bonus-1' as AccountBonusOrderId, message: 'Provider bonus', expiresAt: '2099-01-01T00:00:00Z' },
  })
  const view = render(<AccountSection {...f.props()} />)
  const card = screen.getByRole('region', { name: 'DeepSeek connection' })
  expect(card.querySelector('aside')?.textContent).toContain('Provider bonus')
  expect(f.operations.bonusNoticeShown).not.toHaveBeenCalled()
  view.unmount()
  await act(async () => { frame?.(); await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  expect(f.operations.bonusNoticeShown).not.toHaveBeenCalled()
  expect(f.operations.bonusNoticeDismissed).not.toHaveBeenCalled()
})
