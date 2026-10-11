/** Optional Desktop DeepSeek provider connection and reconnecting Remote subscription. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { AccountView, AccountDetails, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PlatformBridge } from './PlatformOverlay.tsx'
import { ContactConfig, CONTACT_CONFIG_GLOBAL } from '../contact-config.ts'
import { contactUrl } from './contact-url.ts'
import { AccountPlatformHost, type AccountPlatformHostInjected } from './AccountPlatformHost.tsx'
import { createPlatformPages, type PlatformPages } from './platform-pages.ts'
import { AccountSection, type AccountSnapshot, type AccountSectionInjected } from './AccountSection.tsx'
import { createBonusNoticeController } from './bonus-notices.ts'
import { accountClientMetadata } from './client-metadata.ts'
import { en, zh, type AccountKey } from './locales.ts'
import { refreshAfterReturn } from './account-refresh.ts'
export type { AccountSectionInjected, AccountSectionProps } from './AccountSection.tsx'
export type { AccountMenuProps } from './AccountMenu.tsx'
export type { AccountSnapshot } from './AccountSection.tsx'
export type { AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

/** Services required by account settings. */
export const inject = ['slots', 'locale', 'remote', 'remote.account', 'remote.session', 'theme']
/** Register account UI only in the Desktop renderer. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register('settings.account', { en, zh }), 'account: dictionaries')
  const page = globalThis as Partial<Record<typeof CONTACT_CONFIG_GLOBAL, unknown>>
  const config = ContactConfig(page[CONTACT_CONFIG_GLOBAL] ?? {})
  let snapshot: AccountSnapshot = { view: undefined, details: undefined, failed: false, loginVisible: false }
  const listeners = new Set<() => void>()
  const publish = (value: AccountSnapshot) => { snapshot = value; for (const listener of listeners) listener() }
  /** @returns the client identity for one account call, read at call time so it carries the language and zone in effect then. */
  const client = () => accountClientMetadata(ctx.locale.getSnapshot().active, process.env.DSH_CLIENT_VERSION)
  // The browser half of the notice lifecycle: reads when the account becomes
  // active and on an explicit refresh, and acknowledges an order only after its
  // card reports a presented frame. The Host owns which bonus is unnotified and
  // the server owns the copy.
  const notices = createBonusNoticeController({
    ackRetryDelayMs: config.bonusAckRetryDelayMs,
    ackRetryMaxDelayMs: config.bonusAckRetryMaxDelayMs,
    read: async () => {
      const result = await ctx.remote.account.getUnnotifiedBonuses(client())
      if (!result.ok) throw new Error('account bonus read failed')
      return result.value
    },
    acknowledge: async (accountId, orderId) => {
      const result = await ctx.remote.account.ackBonusNotified(accountId, orderId, client())
      if (!result.ok) throw new Error('account bonus acknowledgement failed')
      return result.value
    },
    publish: (notice) => {
      const { notice: _replaced, ...withoutNotice } = snapshot
      // exactOptionalPropertyTypes distinguishes an absent notice from an undefined one.
      publish(notice === null ? withoutNotice : { ...withoutNotice, notice })
    },
  })
  ctx.effect(() => () => { notices.end() }, 'account: bonus notice lifetime')
  let revision = 0
  let refreshing: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (snapshot.view?.status !== 'credential-stored') return Promise.resolve()
    if (refreshing !== undefined) return refreshing
    const generation = revision
    const read = async <K extends keyof AccountDetails>(field: K,
      query: () => Promise<AccountDetails[K] | null>) => {
      let value: AccountDetails[K] | null
      try { value = await query() }
      catch { value = { status: 'failed' } }
      if (generation === revision && value !== null) publish({ ...snapshot, details: { ...snapshot.details, [field]: value } })
    }
    const request = Promise.all([
      read('profile', async () => {
        const result = await ctx.remote.account.getProfile(client())
        if (!result.ok) throw new Error('account profile failed')
        return result.value
      }),
      read('balance', async () => {
        const result = await ctx.remote.account.getBalance(client())
        if (!result.ok) throw new Error('account balance failed')
        return result.value
      }),
    ]).then(() => undefined)
    refreshing = request
    void request.finally(() => { if (refreshing === request) refreshing = undefined })
    return request
  }
  ctx.effect(() => () => { revision++ }, 'account: details request lifetime')
  const stream = ctx.remote.$stream<AccountView>({
    name: 'account', open: signal => ctx.remote.account.watch(signal), ended: () => new Error('account stream ended'),
  })
  let disposed = false
  let signInGeneration = 0
  let signInSupersededGeneration = 0
  let startingFromAttempt: SignInAttemptId | undefined
  let startingFromStatus: AccountView['status'] | undefined
  let lastInitializationAttempt: SignInAttemptId | undefined
  let streamGeneration = 0
  let returnedAttemptFence: { previous: SignInAttemptId; generation: number } | undefined
  ctx.effect(() => () => { disposed = true; return stream.dispose() }, 'account: state stream')
  void (async () => {
    for await (const frame of stream) {
      // HTTP may return a new attempt before an older watch item is delivered.
      // Only its known predecessor's terminal item can be discarded here.
      if (returnedAttemptFence?.generation === frame.generation
        && frame.value.attempt?.id === returnedAttemptFence.previous
        && ['succeeded', 'cancelled', 'expired', 'failed'].includes(frame.value.attempt.phase)) {
        frame.accept()
        continue
      }
      returnedAttemptFence = undefined
      streamGeneration = frame.generation
      revision++
      refreshing = undefined
      // Only the stream claims completion; a start response may already have
      // published this successful attempt for presentation.
      const completedAttempt = frame.value.status === 'credential-stored' && frame.value.attempt?.phase === 'succeeded'
        ? frame.value.attempt.id : undefined
      const initialize = completedAttempt !== undefined && completedAttempt !== lastInitializationAttempt
      if (initialize) lastInitializationAttempt = completedAttempt
      const { notice, ...previous } = snapshot
      const identified = frame.value.attempt !== null && (frame.value.attempt.id !== startingFromAttempt
        || ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(frame.value.attempt.phase))
      const credentialChanged = frame.value.status === 'credential-stored'
        || (startingFromStatus !== undefined && frame.value.status !== startingFromStatus)
      if (identified || credentialChanged) signInSupersededGeneration = signInGeneration
      publish({ ...previous, view: frame.value, details: undefined, failed: false,
        loginStarting: snapshot.loginStarting === true && frame.value.status !== 'credential-stored' && !identified,
        ...(frame.value.status === 'credential-stored' && notice ? { notice } : {}) })
      frame.accept()
      if (frame.value.status === 'credential-stored') notices.begin()
      else notices.end()
      if (initialize) void (async () => {
        try {
          const initialized = await ctx.remote.session.initializeDefaultModel()
          if (!initialized.ok) console.info('[deepseek-account] default model initialization failed', { reason: 'refused' })
        } catch (_error) {
          console.info('[deepseek-account] default model initialization failed', { reason: 'disconnected' })
        }
      })()
      void refresh()
    }
  })().catch(() => { if (!disposed) publish({ ...snapshot, failed: true }) })
  const nativePlatform = (globalThis as typeof globalThis & { dshPlatform?: PlatformBridge }).dshPlatform
  // One request channel for the single native Platform view. It always exists
  // so every entry can observe whether a page is showing; only a native bridge
  // lets an entry request one.
  const platformPages = createPlatformPages()
  ctx.effect(() => () => { platformPages.dispose() }, 'account: platform page request')
  // One account refresh: the recharge/bonus wallet and the unnotified-bonus read,
  // whichever surface asks — a Models provider-card entry, or returning from top-up. Both
  // reads are independent, and a concurrent refresh shares the in-flight request.
  const refreshAccount = async (): Promise<void> => { await Promise.all([refresh(), notices.refresh()]) }
  /**
   * Narrow the shared channel to one surface's post-return read: only a viewer
   * returning from top-up re-reads, so a superseded page or a plugin teardown
   * never triggers account work.
   * @param reRead - that surface's read after a returned top-up page.
   * @returns the opener that surface injects.
   */
  const platformPageOpener = (reRead: () => Promise<void>): PlatformPages['open'] =>
    (page, onClose) => platformPages.open(page, (reason) => {
      onClose(reason)
      if (reason === 'returned' && page === 'top-up') void refreshAfterReturn(refreshing, reRead)
    })
  const operations: AccountSectionInjected = {
    subscribeSessionExpired: listener => ctx.remote.$on('deepseek-account/session-expired', listener),
    subscribeModelSignInRequired: listener => ctx.remote.$on('deepseek-account/model-sign-in-required', listener),
    ...nativePlatform === undefined ? {} : { openPlatformPage: platformPageOpener(refreshAccount) },
    refreshAccount,
    contactUs() {
      // Sample the account, build and environment before awaiting native information, so
      // a profile the read outlasts cannot replace the UID this click reported.
      const profile = snapshot.details?.profile
      const context = {
        uid: profile?.status === 'ready' ? profile.value.id : null,
        version: process.env.DSH_CLIENT_VERSION,
        width: window.screen.width, height: window.screen.height, pixelRatio: window.devicePixelRatio,
      }
      const openForm = (deviceInfo: string): void => {
        window.open(contactUrl(config, { ...context, deviceInfo }), '_blank', 'noopener,noreferrer')
      }
      const readDeviceInfo = (globalThis as typeof globalThis & {
        dshDesktop?: { deviceInfo?: () => Promise<string> }
      }).dshDesktop?.deviceInfo
      if (readDeviceInfo === undefined) {
        // A Desktop bridge without the optional reader reports the renderer user agent.
        openForm(navigator.userAgent)
        return
      }
      void (async () => {
        let deviceInfo = ''
        try { deviceInfo = await readDeviceInfo() }
        catch (_error) {
          // Native information is optional; the questionnaire opens without it.
        }
        openForm(deviceInfo)
      })()
    },
    showLogin(visible) { publish({ ...snapshot, loginVisible: visible }) },
    setOnboarding(active) { publish({ ...snapshot, onboarding: active }) },
    bonusNoticeShown(orderId) { notices.shown(orderId) },
    bonusNoticeDismissed(orderId) { notices.dismiss(orderId) },
    hooks: {
      account: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      theme: {
        getSnapshot: () => ctx.theme.getTheme(),
        subscribe: listener => ctx.on('theme/change', listener),
      },
    },
    async start() {
      const generation = ++signInGeneration
      returnedAttemptFence = undefined
      startingFromAttempt = snapshot.view?.attempt?.id
      startingFromStatus = snapshot.view?.status
      publish({ ...snapshot, loginVisible: true, loginFailed: false, loginStarting: true })
      const transport = (globalThis as typeof globalThis & {
        __DSH_TRANSPORT__?: { streamBaseUrl?: string }
      }).__DSH_TRANSPORT__
      try {
        const result = await ctx.remote.account.startSignIn(client(),
          transport?.streamBaseUrl !== undefined ? new URL(transport.streamBaseUrl).origin : window.location.origin,
          'desktop')
        if (!result.ok) throw new Error('account start failed')
        if (disposed || generation !== signInGeneration) return
        // A same-old terminal frame does not identify this start. Admit safe
        // returned metadata unless a new/active attempt or credential change
        // has superseded it, so cancellation never depends on its watch frame.
        if (signInSupersededGeneration !== generation) {
          revision++
          refreshing = undefined
          const returnedId = result.value.attempt?.id
          if (startingFromAttempt !== undefined && returnedId !== undefined && returnedId !== startingFromAttempt) {
            returnedAttemptFence = { previous: startingFromAttempt, generation: streamGeneration }
          }
          publish({ ...snapshot, view: result.value, details: undefined, loginStarting: false })
          void refresh()
        } else publish({ ...snapshot, loginStarting: false })
      } catch (error) {
        if (!disposed && generation === signInGeneration) publish({ ...snapshot, loginFailed: true, loginStarting: false })
        throw error
      }
    },
    async cancel(id) { const result = await ctx.remote.account.cancelSignIn(id); if (!result.ok) throw new Error('account cancel failed') },
    async hasRunningAccountTasks() {
      const result = await ctx.remote.account.hasRunningAccountTasks()
      if (!result.ok) throw new Error('account task query failed')
      return result.value
    },
    async signOut() {
      const result = await ctx.remote.account.signOut(client())
      if (result.ok) return
      throw result.error
    },
  }
  if (nativePlatform !== undefined) {
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'account.platform-page', locale: 'settings.account',
      inject: (): AccountPlatformHostInjected => ({
        platform: nativePlatform, hooks: { page: platformPages },
        closePage: platformPages.close,
      }),
    }, AccountPlatformHost))
  }
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'deepseek-connection', locale: 'settings.account', inject: () => operations,
  }, AccountSection))
}
