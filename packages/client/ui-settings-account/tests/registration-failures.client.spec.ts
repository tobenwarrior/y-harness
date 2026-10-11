// @vitest-environment jsdom
/** Provider registration keeps stream state authoritative when independent RPCs settle late. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'
import * as accountPlugin from '../src/client/index.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'
const disconnectedIt = createClientTest({ roster: webApp, provide: { [SELF]: {
  ...accountPlugin,
  apply(ctx) {
    const original = ctx.remote.session
    const isolated = ctx.isolate('remote.session')
    isolated.provide('remote.session', new Proxy(original, {
      get(target, name, receiver) {
        if (name === 'initializeDefaultModel') return async () => { throw new Error('transport disconnected') }
        const value: unknown = Reflect.get(target, name, receiver)
        return value
      },
    }))
    accountPlugin.apply(isolated)
  },
} } })
const signedOut: AccountView = {
  status: 'signed-out', attempt: null,
  links: { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top-up' },
}
const completed: AccountView = {
  ...signedOut, status: 'credential-stored', attempt: { id: 'registration-complete' as SignInAttemptId, phase: 'succeeded' },
}

function operations(client: TestClient): AccountSectionInjected {
  const entry = client.ctx.slots.entries('settings.models.footer').find(row => row.options.id === 'deepseek-connection')
  if (entry?.inject === undefined) throw new Error('provider connection was not registered')
  const injected: object = entry.inject()
  return injected as AccountSectionInjected
}

beforeEach(() => {
  vi.stubGlobal('dshDesktop', {})
  vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-registration-test')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

for (const failure of ['refused', 'disconnected'] as const) (failure === 'refused' ? it : disconnectedIt)(
  `continues account state after default initialization is ${failure}`, async ({ start, mock }) => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    if (failure === 'refused') mock.remote.session.initializeDefaultModel.mockResolvedValue({
      ok: false, error: new RemoteError('gateway/internal', 'model selection refused', {}),
    })
    const client = await start()
    const actions = operations(client)
    mock.streams.push('account/watch', completed)
    await expect.poll(() => log.mock.calls).toContainEqual([
      '[deepseek-account] default model initialization failed', { reason: failure },
    ])
    mock.streams.push('account/watch', signedOut)
    await expect.poll(() => actions.hooks.account.getSnapshot()).toMatchObject({ view: signedOut, failed: false })
    if (failure === 'refused') expect(mock.remote.session.initializeDefaultModel).toHaveBeenCalledExactlyOnceWith()
  }, 60_000)

it('does not block credential removal on an unfinished default initialization', async ({ start, mock }) => {
  const pending = Promise.withResolvers<RemoteResult<void>>()
  mock.remote.session.initializeDefaultModel.mockReturnValue(pending.promise)
  const client = await start()
  const actions = operations(client)
  try {
    mock.streams.push('account/watch', completed)
    await expect.poll(() => mock.remote.session.initializeDefaultModel.mock.calls.length).toBe(1)
    mock.streams.push('account/watch', signedOut)
    await expect.poll(() => actions.hooks.account.getSnapshot()).toMatchObject({ view: signedOut, failed: false })
  } finally { pending.resolve(ok(undefined)) }
}, 60_000)

for (const outcome of ['resolved', 'rejected'] as const) it(`ignores a start response ${outcome} after provider unload`, async ({ start, mock }) => {
  const pending = Promise.withResolvers<RemoteResult<AccountView>>()
  mock.remote.account.startSignIn.mockReturnValue(pending.promise)
  const client = await start()
  const actions = operations(client)
  const started = actions.start()
  const result = started.then(() => undefined, (error: unknown) => error)
  await expect.poll(() => mock.remote.account.startSignIn.mock.calls.length).toBe(1)
  await client.unload(SELF)
  const before = actions.hooks.account.getSnapshot()
  const failure = new Error('late transport failure')
  if (outcome === 'resolved') pending.resolve(ok(completed))
  else pending.reject(failure)
  if (outcome === 'resolved') expect(await result).toBeUndefined()
  else expect(await result).toMatchObject({ message: 'account start failed' })
  expect(actions.hooks.account.getSnapshot()).toBe(before)
  expect(client.ctx.slots.entries('settings.models.footer').some(entry => entry.options.id === 'deepseek-connection')).toBe(false)
}, 60_000)

it('keeps a newer start visible when an earlier start fails', async ({ start, mock }) => {
  const pending = Promise.withResolvers<RemoteResult<AccountView>>()
  const waiting: AccountView = {
    ...signedOut, attempt: { id: 'newer-registration' as SignInAttemptId, phase: 'initializing' },
  }
  mock.remote.account.startSignIn.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok(waiting))
  const client = await start()
  const actions = operations(client)
  const failed = actions.start().then(() => undefined, (error: unknown) => error)
  await expect.poll(() => mock.remote.account.startSignIn.mock.calls.length).toBe(1)
  await actions.start()
  const failure = new Error('superseded transport failure')
  pending.reject(failure)
  expect(await failed).toMatchObject({ message: 'account start failed' })
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ view: waiting, loginStarting: false, loginFailed: false })
}, 60_000)

it('reports an invalid build version before attempting a provider sign-in', async ({ start, mock }) => {
  const client = await start()
  const actions = operations(client)
  vi.stubEnv('DSH_CLIENT_VERSION', '')
  await expect(actions.start()).rejects.toThrow('this client build carries no DSH_CLIENT_VERSION')
  expect(mock.remote.account.startSignIn).not.toHaveBeenCalled()
  expect(actions.hooks.account.getSnapshot()).toMatchObject({ loginVisible: true, loginFailed: true, loginStarting: false })
}, 60_000)
