// @vitest-environment jsdom
/** Desktop account operations and ordinary-browser isolation in the shipped client composition. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {
  AccountBonusBatch, AccountBonusOrderId, AccountDetails, AccountUserId, AccountView, SignInAttemptId,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Config as OnboardingConfig } from '../src/index.ts'
import { ChatSettingsSchema as ChatConfig } from '../../ui-chat/src/chat-settings.ts'
import { DeveloperToolsSettingsSchema as SettingsConfig } from '../../ui-settings/src/developer-tools-settings.ts'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'
import { CONTACT_CONFIG_GLOBAL } from '../src/contact-config.ts'
import { AccountPlatformHost } from '../src/client/AccountPlatformHost.tsx'
import type { AccountPlatformHostInjected } from '../src/client/AccountPlatformHost.tsx'
import { AccountQuotaNotice } from '../src/client/AccountQuotaNotice.tsx'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'
const view: AccountView = {
  status: 'signed-out', attempt: null,
  links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
}
const stored: AccountView = { ...view, status: 'credential-stored' }
const profile: AccountDetails['profile'] = { status: 'ready', value: { id: 'account-user' as AccountUserId, name: 'User', contact: null } }
/** @param orderId - server order. @param message - server copy. @returns one unnotified bonus for this account. */
function bonus(orderId: string, message = 'Awarded 5.00'): AccountBonusBatch {
  return {
    accountId: 'account-user' as AccountUserId,
    bonuses: [{
      orderId: orderId as AccountBonusOrderId, campaign: 'dsh_login_bonus', amount: '5.00', currency: 'CNY',
      grantedAt: '2026-09-21T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z', message,
    }],
  }
}
function operations(c: TestClient): AccountSectionInjected {
  const injected: object = c.ctx.slots.entries('settings.models.footer').find(entry => entry.options.id === 'deepseek-connection')!.inject!()
  return injected as AccountSectionInjected
}
/** The account take-over registered into the Chat-owned frame-wide quota notice chain. */
function quotaNoticeEntry(c: TestClient) {
  return c.ctx.slots.entries('shell.quota-notice').find(entry => entry.component === AccountQuotaNotice)
}
/** The account feature's one shared native Platform page host. */
function platformHostEntry(c: TestClient) {
  return c.ctx.slots.entries('shell.overlay').find(entry => entry.component === AccountPlatformHost)
}
/** One registered entry's injected share, read through the same object-narrowing the account operations use. */
function injectedOf(entry: { inject?: (() => object) | undefined }): object {
  const injected: object = entry.inject!()
  return injected
}
beforeEach(() => {
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test')
  vi.stubGlobal('screen', { width: 1512, height: 982 })
  vi.stubGlobal('devicePixelRatio', 2)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('keeps account UI and account RPC inactive in a plain browser, including after reload', async ({ start, mock }) => {
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    await c.flush()
    expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.models.footer').some(entry => entry.options.id === 'deepseek-connection')).toBe(false)
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
    expect(quotaNoticeEntry(c)).toBeUndefined()
    expect(platformHostEntry(c)).toBeUndefined()
    expect(mock.log.calls().filter(call => call.endpoint.startsWith('account/'))).toEqual([])
    expect(mock.log.streams().filter(stream => stream.endpoint.startsWith('account/'))).toEqual([])
  }
}, 60_000)

it('keeps global identity, tutorial and account quota take-over absent in Desktop', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  expect(quotaNoticeEntry(c)).toBeUndefined()
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
  expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
  expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
  expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === 'desktop-onboarding')).toBe(false)
  expect(c.ctx.slots.entries('settings.models.footer').filter(entry => entry.options.id === 'deepseek-connection')).toHaveLength(1)
}, 60_000)

it('publishes provider dialog state through the Models footer and opens contextual support', async ({ start }) => {
  vi.stubGlobal(CONTACT_CONFIG_GLOBAL, { contactFormUrl: 'https://example.test/form/?prefill_device_model=old&hide_device_model=1', contactSource: 'harness' })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
  // The account UI follows the live theme service through the framework hook channel.
  const theme = c.ctx.get('theme') as ThemeRuntime
  const onTheme = vi.fn()
  const offTheme = actions.hooks.theme.subscribe(onTheme)
  expect(actions.hooks.theme.getSnapshot()).toBe(theme.getTheme())
  const probe = theme.register({ id: 'probe', colorScheme: 'dark', tokens: {} })
  expect(onTheme).toHaveBeenCalledOnce()
  probe()
  offTheme()
  expect(theme.getTheme().themes.map(candidate => candidate.id)).toEqual(['light', 'dark'])
  await actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).not.toHaveBeenCalled()
  const listener = vi.fn()
  const off = actions.hooks.account.subscribe(listener)
  actions.showLogin(true)
  actions.setOnboarding(true)
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, onboarding: true })
  expect(listener).toHaveBeenCalledTimes(2)
  off()
  actions.showLogin(false)
  expect(listener).toHaveBeenCalledTimes(2)
  actions.contactUs()
  const signedOut = new URL(String(open.mock.calls.at(-1)![0]))
  expect(signedOut.searchParams.has('prefill_uid')).toBe(false)
  expect(signedOut.searchParams.get('hide_uid')).toBe('1')
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile) })
  expect(c.ctx.slots.entries('settings.models.footer').find(entry => entry.options.id === 'deepseek-connection')!.inject!()).toBe(actions)
  expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
  actions.contactUs()
  const support = new URL(String(open.mock.calls.at(-1)![0]))
  expect(support.searchParams.get('prefill_uid')).toBe('account-user')
  expect(support.searchParams.get('hide_uid')).toBe('1')
  expect(support.searchParams.get('hide_harness_version')).toBe('1')
  expect(support.searchParams.get('prefill_harness_version')).toBe('0.0.0-test')
  expect(support.searchParams.get('hide_device_info')).toBe('1')
  expect(support.searchParams.get('prefill_device_info')).toBe(`${navigator.userAgent}; screen_resolution=3024x1964`)
  expect(support.searchParams.has('prefill_device_model')).toBe(false)
  expect(support.searchParams.has('hide_device_model')).toBe(false)
  for (const field of ['os_version', 'device_brand', 'app_locale', 'screen_resolution']) {
    expect(support.searchParams.has(`prefill_${field}`)).toBe(false)
    expect(support.searchParams.has(`hide_${field}`)).toBe(false)
  }
  expect(support.searchParams.has('prefill_app_version')).toBe(false)
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  actions.contactUs()
  const signedOutAgain = new URL(String(open.mock.calls.at(-1)![0]))
  expect(signedOutAgain.searchParams.has('prefill_uid')).toBe(false)
  expect(signedOutAgain.searchParams.get('hide_uid')).toBe('1')
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
  expect(c.ctx.slots.entries('settings.models.footer').some(entry => entry.options.id === 'deepseek-connection')).toBe(false)
}, 60_000)

it('prefills the native device description from the Desktop bridge on every click', async ({ start }) => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const deviceInfo = vi.fn(async () => 'platform=darwin; os=15.0; app_arch=arm64; cpu=Apple M3; memory_gib=16.0')
  vi.stubGlobal('dshDesktop', { deviceInfo })
  const c = await start()
  const actions = operations(c)
  actions.contactUs()
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  const first = new URL(String(open.mock.calls.at(-1)![0]))
  expect(first.searchParams.get('prefill_device_info'))
    .toBe('platform=darwin; os=15.0; app_arch=arm64; cpu=Apple M3; memory_gib=16.0; screen_resolution=3024x1964')
  expect(first.searchParams.get('hide_device_info')).toBe('1')
  deviceInfo.mockResolvedValue('platform=win32; os=10.0; app_arch=x64; memory_gib=32.0')
  vi.stubGlobal('screen', { width: 1920, height: 1080 })
  vi.stubGlobal('devicePixelRatio', 1)
  actions.contactUs()
  await vi.waitFor(() => { expect(open).toHaveBeenCalledTimes(2) })
  expect(new URL(String(open.mock.calls.at(-1)![0])).searchParams.get('prefill_device_info'))
    .toBe('platform=win32; os=10.0; app_arch=x64; memory_gib=32.0; screen_resolution=1920x1080')
  expect(deviceInfo).toHaveBeenCalledTimes(2)
}, 60_000)

it('opens the questionnaire with screen resolution when the native read fails', async ({ start }) => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const deviceInfo = vi.fn(async (): Promise<string> => { throw new Error('platform ipc unavailable') })
  vi.stubGlobal('dshDesktop', { deviceInfo })
  const c = await start()
  operations(c).contactUs()
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  const url = new URL(String(open.mock.calls.at(-1)![0]))
  expect(url.searchParams.get('prefill_device_info')).toBe('screen_resolution=3024x1964')
  expect(url.searchParams.get('hide_device_info')).toBe('1')
  expect(url.searchParams.has('prefill_app_locale')).toBe(false)
  expect(deviceInfo).toHaveBeenCalledOnce()
}, 60_000)

it('reports the account sampled by the click when a native read outlasts a sign-out', async ({ start }) => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const device = Promise.withResolvers<string>()
  vi.stubGlobal('dshDesktop', { deviceInfo: vi.fn(() => device.promise) })
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile) })
  actions.contactUs()
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  device.resolve('platform=darwin; os=15.0; app_arch=arm64; memory_gib=16.0')
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  expect(new URL(String(open.mock.calls.at(-1)![0])).searchParams.get('prefill_uid')).toBe('account-user')
}, 60_000)

it('coalesces refreshes, publishes independent failures, and rejects stale responses after sign-out or unload', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const pending = Promise.withResolvers<ReturnType<typeof ok<AccountDetails['profile'] | null>>>()
  c.mock.remote.account.getProfile.mockReturnValueOnce(pending.promise)
  c.mock.remote.account.getBalance.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce() })
  // Two concurrent account refreshes share the one in-flight request, so the
  // second call adds no second read of the profile or the balance.
  const a = actions.refreshAccount()
  const concurrently = actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  pending.resolve(ok(profile))
  await Promise.all([a, concurrently])
  expect(actions.hooks.account.getSnapshot().details).toBeUndefined()
  c.mock.remote.account.getProfile.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.remote.account.getBalance.mockRejectedValueOnce(new Error('offline'))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details).toEqual({ profile: { status: 'failed' }, balance: { status: 'failed' } }) })
  const pendingAgain = Promise.withResolvers<ReturnType<typeof ok<AccountDetails['profile'] | null>>>()
  c.mock.remote.account.getProfile.mockReturnValueOnce(pendingAgain.promise)
  const request = actions.refreshAccount()
  await c.unload(SELF)
  pendingAgain.resolve(ok(profile))
  await request
  expect(actions.hooks.account.getSnapshot().details?.profile).toEqual({ status: 'failed' })
}, 60_000)

it('uses the Desktop login carrier and exposes operation errors', async ({ start, mock }) => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  mock.remote.account.startSignIn.mockResolvedValue(ok(view))
  await actions.start()
  expect(mock.remote.account.startSignIn).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en', version: '0.0.0-test' }),
    window.location.origin, 'desktop')
  const failure = { ok: false as const, error: new RemoteError('gateway/internal', 'offline', {}) }
  mock.remote.account.startSignIn.mockResolvedValueOnce(failure)
  await expect(actions.start()).rejects.toThrow('account start failed')
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, loginFailed: true })
  const id = 'cancel-me' as SignInAttemptId
  mock.remote.account.cancelSignIn.mockResolvedValueOnce(ok(view)).mockResolvedValueOnce(failure)
  await actions.cancel(id)
  await expect(actions.cancel(id)).rejects.toThrow('account cancel failed')
  mock.remote.account.signOut.mockResolvedValueOnce(ok(view)).mockResolvedValueOnce(failure)
  await actions.signOut()
  // The provider action preserves the refused Remote call for its caller.
  await expect(actions.signOut()).rejects.toBe(failure.error)
}, 60_000)

it('publishes pending provider start until an attempt is observable', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const pending = Promise.withResolvers<ReturnType<typeof ok<AccountView>>>()
  mock.remote.account.startSignIn.mockReturnValueOnce(pending.promise)
  const started = actions.start()
  const initializing: AccountView = { ...view, attempt: { id: 'started' as SignInAttemptId, phase: 'initializing' } }
  try {
    expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, loginStarting: true })
    mock.streams.push('account/watch', initializing)
    await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: initializing, loginStarting: false }) })
  } finally {
    pending.resolve(ok(initializing))
    await started
  }
  expect(actions.hooks.account.getSnapshot().loginStarting).toBe(false)
}, 60_000)

it('admits safe returned start metadata when the watch frame has not arrived', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const initializing: AccountView = { ...view, attempt: { id: 'returned' as SignInAttemptId, phase: 'initializing' } }
  mock.remote.account.startSignIn.mockResolvedValueOnce(ok(initializing))
  await actions.start()
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: initializing, loginStarting: false })
}, 60_000)

it('initializes once from the success stream after a successful start response arrives first', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const succeeded: AccountView = { ...stored, attempt: { id: 'returned-success' as SignInAttemptId, phase: 'succeeded' } }
  mock.remote.session.initializeDefaultModel.mockResolvedValue(ok(undefined))
  mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus('returned-success-bonus')))
  mock.remote.account.startSignIn.mockResolvedValueOnce(ok(succeeded))
  await actions.start()
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: succeeded, loginStarting: false })
  expect(mock.remote.session.initializeDefaultModel).not.toHaveBeenCalled()
  expect(mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()
  mock.streams.push('account/watch', succeeded)
  await vi.waitFor(() => { expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith() })
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId: 'returned-success-bonus' }) })
  mock.streams.push('account/watch', succeeded)
  await c.flush()
  expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith()
  expect(mock.remote.account.ackBonusNotified).not.toHaveBeenCalled()
}, 60_000)

it('admits a returned new attempt after an old terminal watch frame during start', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const old: AccountView = { ...view, attempt: { id: 'previous' as SignInAttemptId, phase: 'cancelled' } }
  mock.streams.push('account/watch', old)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(old) })
  const pending = Promise.withResolvers<ReturnType<typeof ok<AccountView>>>()
  mock.remote.account.startSignIn.mockReturnValueOnce(pending.promise)
  const started = actions.start()
  const returned: AccountView = { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'initializing' } }
  try {
    const terminal: AccountView = { ...old, attempt: { id: 'previous' as SignInAttemptId, phase: 'failed', errorCode: 'network' } }
    mock.streams.push('account/watch', terminal)
    await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(terminal) })
  } finally {
    pending.resolve(ok(returned))
    await started
  }
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: returned, loginStarting: false })
}, 60_000)

it('keeps the returned new attempt when an old terminal watch frame arrives afterward', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const old: AccountView = { ...view, attempt: { id: 'previous' as SignInAttemptId, phase: 'cancelled' } }
  mock.streams.push('account/watch', old)
  await mock.streams.drained('account/watch')
  await c.flush()
  expect(actions.hooks.account.getSnapshot().view).toEqual(old)
  const returned: AccountView = { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'initializing' } }
  mock.remote.account.startSignIn.mockResolvedValueOnce(ok(returned))
  await actions.start()
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: returned, loginStarting: false })
  const delayed: AccountView = { ...old, attempt: { id: 'previous' as SignInAttemptId, phase: 'failed', errorCode: 'network' } }
  for (const terminal of [old, delayed]) {
    mock.streams.push('account/watch', terminal)
    await mock.streams.drained('account/watch')
    await c.flush()
    expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: returned, loginStarting: false })
  }
  mock.remote.account.cancelSignIn.mockResolvedValueOnce(ok(view))
  await actions.cancel(returned.attempt!.id)
  expect(mock.remote.account.cancelSignIn).toHaveBeenCalledExactlyOnceWith(returned.attempt!.id)
}, 60_000)

const authoritativeFrames: { name: string; next: AccountView }[] = [
  { name: 'current attempt cancellation', next: { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'cancelled' } } },
  { name: 'current attempt expiry', next: { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'expired' } } },
  { name: 'null sign-out', next: view },
  { name: 'different attempt success', next: { ...stored, attempt: { id: 'authoritative-new' as SignInAttemptId, phase: 'succeeded' } } },
]
for (const { name, next } of authoritativeFrames) it(`accepts ${name} after a returned new attempt and delayed old terminal frame`, async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const old: AccountView = { ...view, attempt: { id: 'previous' as SignInAttemptId, phase: 'cancelled' } }
  mock.streams.push('account/watch', old)
  await mock.streams.drained('account/watch')
  await c.flush()
  const returned: AccountView = { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'initializing' } }
  mock.remote.account.startSignIn.mockResolvedValueOnce(ok(returned))
  mock.remote.session.initializeDefaultModel.mockResolvedValue(ok(undefined))
  await actions.start()
  mock.streams.push('account/watch', old)
  await mock.streams.drained('account/watch')
  await c.flush()
  expect(actions.hooks.account.getSnapshot().view).toEqual(returned)
  mock.streams.push('account/watch', next)
  await mock.streams.drained('account/watch')
  await c.flush()
  expect(actions.hooks.account.getSnapshot().view).toEqual(next)
  if (next.status === 'credential-stored') {
    await vi.waitFor(() => { expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith() })
    mock.streams.push('account/watch', next)
    await mock.streams.drained('account/watch')
    await c.flush()
    expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith()
  } else {
    expect(actions.hooks.account.getSnapshot().details).toBeUndefined()
    expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
    expect(mock.remote.session.initializeDefaultModel).not.toHaveBeenCalled()
  }
}, 60_000)

it('retires the returned attempt fence at a new physical stream baseline', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  let restart: (() => void) | undefined
  const original = c.ctx.remote.$stream.bind(c.ctx.remote)
  const capture: typeof c.ctx.remote.$stream = (options) => {
    const stream = original(options)
    if (options.name === 'account') restart = () => { stream.restart() }
    return stream
  }
  vi.spyOn(c.ctx.remote, '$stream').mockImplementation(capture)
  await c.reload(SELF)
  const actions = operations(c)
  const old: AccountView = { ...view, attempt: { id: 'previous' as SignInAttemptId, phase: 'cancelled' } }
  mock.streams.push('account/watch', old)
  await mock.streams.drained('account/watch')
  await c.flush()
  const returned: AccountView = { ...view, attempt: { id: 'returned-new' as SignInAttemptId, phase: 'initializing' } }
  mock.remote.account.startSignIn.mockResolvedValueOnce(ok(returned))
  await actions.start()
  expect(actions.hooks.account.getSnapshot().view).toEqual(returned)
  mock.stream('account/watch', (_args, stream) => { stream.push(old) })
  const opens = mock.log.streams('account/watch').length
  expect(restart).toBeDefined()
  restart?.()
  await mock.streams.opened('account/watch', opens + 1)
  await mock.streams.drained('account/watch')
  await c.flush()
  expect(actions.hooks.account.getSnapshot().view).toEqual(old)
}, 60_000)

it('does not replace a newer sign-in completion with an older start response', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  mock.remote.session.initializeDefaultModel.mockResolvedValue(ok(undefined))
  const pending = Promise.withResolvers<ReturnType<typeof ok<AccountView>>>()
  mock.remote.account.startSignIn.mockReturnValueOnce(pending.promise)
  const started = actions.start()
  const succeeded: AccountView = { ...stored, attempt: { id: 'newer' as SignInAttemptId, phase: 'succeeded' } }
  try {
    mock.streams.push('account/watch', succeeded)
    await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(succeeded) })
  } finally {
    pending.resolve(ok({ ...view, attempt: { id: 'older' as SignInAttemptId, phase: 'initializing' } }))
    await started
  }
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: succeeded, loginStarting: false })
}, 60_000)

it('uses the Desktop stream origin and exposes the native platform bridge', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('__DSH_TRANSPORT__', { streamBaseUrl: 'http://localhost:9876/stream' })
  const platform = { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() }
  vi.stubGlobal('dshPlatform', platform)
  await c.reload(SELF)
  const actions = operations(c)
  // The native commands reach the one shared host through the account page channel.
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  expect(host.platform).toBe(platform)
  // The provider injects the page opener callback, not the channel object.
  expect(typeof actions.openPlatformPage).toBe('function')
  expect('platformPages' in actions).toBe(false)
  expect(host.hooks.page.getSnapshot()).toBeNull()

  // One surface requests a page; the viewer returning through the host's own
  // close action retires that owner exactly once and clears the observable.
  const owner = vi.fn()
  actions.openPlatformPage!('usage', owner)
  expect(host.hooks.page.getSnapshot()).toEqual({ page: 'usage' })
  host.closePage()
  expect(host.hooks.page.getSnapshot()).toBeNull()
  expect(owner).toHaveBeenCalledExactlyOnceWith('returned')
  mock.remote.account.startSignIn.mockResolvedValue(ok(view))
  await actions.start()
  expect(mock.remote.account.startSignIn).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }), 'http://localhost:9876', 'desktop')
}, 60_000)


it('re-reads the account when the shared host returns from top-up, and not from usage or an absent page', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(null))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok({ accountId: 'account-user' as AccountUserId, bonuses: [] }))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  // The account becoming active already ran one shared refresh; measure only the
  // reads each return triggers from here.
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalled() })
  await c.flush()
  c.mock.remote.account.getUnnotifiedBonuses.mockClear()
  c.mock.remote.account.getProfile.mockClear()

  // Usage changes nothing the account owns, so returning from it reads nothing.
  actions.openPlatformPage!('usage', vi.fn())
  host.closePage()
  await c.flush()
  expect(mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()

  // Closing with no page showing is not a return, so it reads nothing either.
  host.closePage()
  await c.flush()
  expect(mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()

  // Top up may have changed what the account holds, so its return runs the one
  // shared refresh: the wallet reads and the unnotified-bonus read.
  actions.openPlatformPage!('top-up', vi.fn())
  host.closePage()
  await vi.waitFor(() => { expect(mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce() })
  expect(mock.remote.account.getProfile).toHaveBeenCalledOnce()
}, 60_000)

it('does not refresh when a provider Platform request is superseded or released', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  await c.flush()
  c.mock.remote.account.getProfile.mockClear()
  c.mock.remote.account.getBalance.mockClear()
  c.mock.remote.account.getUnnotifiedBonuses.mockClear()
  const replaced = vi.fn()
  actions.openPlatformPage!('top-up', replaced)
  const release = actions.openPlatformPage!('top-up', vi.fn())
  expect(replaced).toHaveBeenCalledExactlyOnceWith('superseded')
  release()
  await c.flush()
  expect(c.mock.remote.account.getProfile).not.toHaveBeenCalled()
  expect(c.mock.remote.account.getBalance).not.toHaveBeenCalled()
  expect(c.mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()
}, 60_000)

it('waits for an in-flight pre-return read before the post-top-up read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  await c.reload(SELF)
  const actions = operations(c)
  const host = injectedOf(platformHostEntry(c)!) as AccountPlatformHostInjected
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalled() })
  await c.flush()
  c.mock.remote.account.getProfile.mockClear()
  c.mock.remote.account.getBalance.mockClear()
  c.mock.remote.account.getUnnotifiedBonuses.mockClear()
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof ok<AccountDetails['balance'] | null>>>>()
  c.mock.remote.account.getBalance.mockReturnValueOnce(pending.promise)
  try {
    c.mock.streams.push('account/watch', stored)
    await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce() })
    // The baseline includes the frame's own notice read, which is not the return read.
    const bonusesBeforeReturn = c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length

    actions.openPlatformPage!('top-up', vi.fn())
    host.closePage()
    await c.flush()
    // The return read has not started: the host is still waiting on the older one.
    expect(c.mock.remote.account.getProfile).toHaveBeenCalledOnce()
    expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()

    pending.resolve(ok(null))
    await vi.waitFor(() => { expect(c.mock.remote.account.getProfile).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length).toBeGreaterThan(bonusesBeforeReturn) })
  } finally {
    // A failed assertion above must not strand the read the host is awaiting.
    pending.resolve(ok(null))
  }
}, 60_000)

it('reads the unnotified bonus in the active locale and acknowledges only after the card renders', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.ackBonusNotified.mockResolvedValue(ok(true))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId, message: 'Awarded 5.00' })
  })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
  // A successful read is not a display, so nothing may be acknowledged yet.
  expect(c.mock.remote.account.ackBonusNotified).not.toHaveBeenCalled()
  actions.bonusNoticeShown(orderId as AccountBonusOrderId)
  await vi.waitFor(() => {
    expect(c.mock.remote.account.ackBonusNotified).toHaveBeenCalledWith('account-user', orderId, expect.objectContaining({ locale: 'en' }))
  })
  actions.bonusNoticeDismissed(orderId as AccountBonusOrderId)
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
}, 60_000)

it('keeps the notice and its acknowledgement retry across repeated signed-in frames', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubGlobal(CONTACT_CONFIG_GLOBAL, { bonusAckRetryDelayMs: 1, bonusAckRetryMaxDelayMs: 4 })
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  c.mock.remote.account.ackBonusNotified.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId }) })
  actions.bonusNoticeShown(orderId as AccountBonusOrderId)
  await vi.waitFor(() => { expect(c.mock.remote.account.ackBonusNotified.mock.calls.length).toBeGreaterThan(0) })
  // One sign-in commits the credential and then updates the attempt; a reconnected
  // stream replays the same signed-in state. None of them is a new account.
  c.mock.streams.push('account/watch', stored)
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(stored) })
  // The displayed card stays, no second read replaces it, and the failed
  // acknowledgement keeps backing off instead of stopping until sign-out.
  expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce()
  await vi.waitFor(() => { expect(c.mock.remote.account.ackBonusNotified.mock.calls.length).toBeGreaterThan(1) }, { timeout: 30_000 })
}, 60_000)

it('keeps the notice absent when the bonus read is refused, then shows the next read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const orderId = '4c1b0000-0000-4000-8000-000000000000'
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValueOnce({
    ok: false, error: new RemoteError('gateway/internal', 'offline', {}),
  })
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce() })
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  expect(c.mock.remote.account.ackBonusNotified).not.toHaveBeenCalled()
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus(orderId)))
  await actions.refreshAccount()
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice).toMatchObject({ orderId, message: 'Awarded 5.00' })
  })
}, 60_000)

it('drops the previous account notice and stops reading after sign-out', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonus('4c1b0000-0000-4000-8000-000000000001')))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().notice?.message).toBe('Awarded 5.00')
  })
  c.mock.streams.push('account/watch', view)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().view).toEqual(view) })
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  // Signing out ends the lifecycle, so no further read follows.
  const reads = c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(c.mock.remote.account.getUnnotifiedBonuses.mock.calls.length).toBe(reads)
}, 60_000)

it('refreshes balances and the bonus read on explicit provider entry, without polling', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const balance: AccountDetails['balance'] = {
    status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  }
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  // Signing in reads once; nothing else reads on a timer.
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1)
  // Signing in already read the wallet once through the details refresh.
  const balances = c.mock.remote.account.getBalance.mock.calls.length
  await actions.refreshAccount()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(balances + 1)
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
  // The bonus read carries the active UI language.
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'en' }))
}, 60_000)

it('publishes a failed balance from provider entry without dropping the bonus read', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  c.mock.remote.account.getBalance.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  await actions.refreshAccount()
  expect(actions.hooks.account.getSnapshot().details?.balance).toEqual({ status: 'failed' })
  // The bonus read still ran: a failed wallet read does not cancel it.
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
}, 60_000)

it('publishes a terminal state-stream failure without mistaking it for plugin disposal', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  await c.mock.streams.opened('account/watch', 1)
  c.mock.streams.end('account/watch')
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().failed).toBe(true) })
}, 60_000)

it('ignores a terminal stream error when plugin disposal already owns teardown', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  let disposal: Promise<void> | undefined
  const original = c.ctx.remote.$stream.bind(c.ctx.remote)
  const spy = vi.spyOn(c.ctx.remote, '$stream').mockImplementation((options) => {
    const stream = original(options)
    stream.signal.addEventListener('abort', () => { disposal = c.unload(SELF) }, { once: true })
    return stream
  })
  await c.reload(SELF)
  spy.mockRestore()
  const actions = operations(c)
  await c.mock.streams.opened('account/watch', 2)
  c.mock.streams.end('account/watch')
  await vi.waitFor(() => { expect(disposal).toBeDefined() })
  await disposal
  expect(actions.hooks.account.getSnapshot().failed).toBe(false)
}, 60_000)

it('samples the build version, language, and UTC offset for every account call', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(480)
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', stored)
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(1) })
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith({
    version: '0.0.0-test', locale: 'en', timezoneOffsetSeconds: -28_800,
  })
  // The next call reads the zone again instead of reusing the first sample.
  offset.mockReturnValue(-300)
  await actions.refreshAccount()
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenLastCalledWith({
    version: '0.0.0-test', locale: 'en', timezoneOffsetSeconds: 18_000,
  })
}, 60_000)

it('reads the account task impact and reports a refused query', async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  mock.remote.account.hasRunningAccountTasks.mockResolvedValueOnce(ok(true))
  expect(await actions.hasRunningAccountTasks()).toBe(true)
  mock.remote.account.hasRunningAccountTasks.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  await expect(actions.hasRunningAccountTasks()).rejects.toThrow('account task query failed')
}, 60_000)


it('forwards live account notices and removes their subscriptions', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const actions = operations(c)
  const expired = vi.fn()
  const unavailable = vi.fn()
  const offExpired = actions.subscribeSessionExpired!(expired)
  const offUnavailable = actions.subscribeModelSignInRequired!(unavailable)
  for (const event of ['deepseek-account/session-expired', 'deepseek-account/model-sign-in-required']) {
    c.mock.streams.push('$events', { type: 'emit', event, args: [] })
  }
  await c.flush()
  expect(expired).toHaveBeenCalledOnce()
  expect(unavailable).toHaveBeenCalledOnce()
  offExpired()
  offUnavailable()
  for (const event of ['deepseek-account/session-expired', 'deepseek-account/model-sign-in-required']) {
    c.mock.streams.push('$events', { type: 'emit', event, args: [] })
  }
  await c.flush()
  expect(expired).toHaveBeenCalledOnce()
  expect(unavailable).toHaveBeenCalledOnce()
})
for (const native of [false, true]) it(`registers only the provider footer and optional native host (native platform: ${native})`, async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  if (native) vi.stubGlobal('dshPlatform', { open: vi.fn(), setBounds: vi.fn(), close: vi.fn() })
  const c = await start()
  const actions = operations(c)
  expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === 'desktop-onboarding')).toBe(false)
  expect(Boolean(platformHostEntry(c))).toBe(native)
  expect(Boolean(actions.openPlatformPage)).toBe(native)
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.models.footer').some(entry => entry.options.id === 'deepseek-connection')).toBe(false)
  expect(platformHostEntry(c)).toBeUndefined()
  expect(mock.remote.account.getBalance).not.toHaveBeenCalled()
  expect(mock.remote.account.signOut).not.toHaveBeenCalled()
}, 60_000)

for (const step of ['welcome', 'credit', 'purpose', 'process', 'done'] as const) it(`preserves saved desktop settings without restoring the account tutorial (step: ${step})`, async ({ start, mock }) => {
  vi.stubGlobal('dshDesktop', {})
  const values: Record<string, object> = {
    'ui-settings-account': { version: 1, step, purpose: 'development', process: 'standard', completion: step === 'done' ? 'api-key' : null, usage: 'detailed', developerTools: true },
    'ui-chat': { transcriptView: 'compact', performanceUsage: 'detailed', linkOpening: 'sidebar' },
    'ui-settings': { enabled: false },
  }
  const schemas = { 'ui-settings-account': OnboardingConfig, 'ui-chat': ChatConfig, 'ui-settings': SettingsConfig }
  const namespace = (ns: keyof typeof schemas) => ({ ns, autoGenerate: false, schema: JSON.parse(JSON.stringify(schemas[ns].toJSON())) as JsonValue, value: values[ns] as JsonValue, applies: 'live' as const, secrets: [], revision: 0 })
  mock.remote.settings.describe.mockResolvedValue(ok({
    writable: true, hasDocument: true, namespaces: Object.keys(schemas).map(ns => namespace(ns as keyof typeof schemas)),
  }))
  const hasApiKey = vi.fn(async () => true)
  vi.stubGlobal('dshOnboarding', { hasApiKey })
  mock.remote.settings.mutate.mockImplementation(async (ns, ops) => {
    const key = ns as keyof typeof schemas
    const value: Record<string, unknown> = { ...values[key] }
    for (const op of ops) if (op.op === 'set') value[String(op.path[0])] = op.value
    values[key] = value
    return ok(namespace(key))
  })
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    mock.streams.push('account/watch', stored)
    await vi.waitFor(() => { expect(operations(c).hooks.account.getSnapshot().view?.status).toBe('credential-stored') })
    expect(c.ctx.slots.entries('shell.overlay').some(entry => entry.options.id === 'desktop-onboarding')).toBe(false)
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
    expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
    expect(c.ctx.slots.entries('settings.models.sign-in')).toHaveLength(0)
  }
  expect(hasApiKey).not.toHaveBeenCalled()
  expect(mock.remote.settings.mutate).not.toHaveBeenCalled()
  expect(values['ui-settings-account']).toEqual({ version: 1, step, purpose: 'development', process: 'standard', completion: step === 'done' ? 'api-key' : null, usage: 'detailed', developerTools: true })
  expect(mock.remote.account.signOut).not.toHaveBeenCalled()
  expect(values['ui-settings']).toEqual({ enabled: false })
  expect(values['ui-chat']).toEqual({ transcriptView: 'compact', performanceUsage: 'detailed', linkOpening: 'sidebar' })
}, 60_000)
