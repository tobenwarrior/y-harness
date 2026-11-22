/** GitHub App owner sign-in stays redacted, serial, and cancel-safe. */
import { Context } from '@yharness/cordis'
import { GITHUB_APP_CREDENTIAL_KEY } from '@yharness/github-app-auth'
import type { AuthorizationOutcome, AuthorizationRequest } from '@yharness/authorization'
import { brandString } from '@yharness/brand'
import type GitHubAppAuth from '@yharness/github-app-auth'
import { afterEach, expect, it, vi } from 'vitest'
import AccountController from '../src/index.ts'
import type { GitHubAppSignInAttemptId } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function fixture(authStatus: 'needs-auth' | 'connected' = 'needs-auth', includeAuth = true) {
  const ctx = new Context()
  roots.push(ctx)
  const auth = {
    status: vi.fn<GitHubAppAuth['status']>().mockResolvedValue(authStatus),
    disconnect: vi.fn<GitHubAppAuth['disconnect']>().mockResolvedValue(),
  } satisfies Pick<GitHubAppAuth, 'status' | 'disconnect'>
  let request: AuthorizationRequest | undefined
  const begin = vi.fn<(value: AuthorizationRequest) => Promise<AuthorizationOutcome>>()
  const cancel = vi.fn<(key: typeof GITHUB_APP_CREDENTIAL_KEY) => void>()
  if (includeAuth) ctx.provide('githubAppAuth', auth as never)
  ctx.provide('authorization', { begin: (value: AuthorizationRequest) => {
    request = value
    return begin(value)
  }, cancel } as never)
  return { ctx, auth, begin, cancel, get request() { return request }, controller: new AccountController(ctx) }
}

it('reports the optional capability as unavailable without mounting the provider', async () => {
  const ctx = new Context()
  roots.push(ctx)
  const controller = new AccountController(ctx)
  await expect(controller.getGitHubAppSignIn()).resolves.toEqual({ status: 'unavailable', attempt: null })
})

it('keeps the optional capability unavailable when the provider is not installed', async () => {
  const f = fixture('needs-auth', false)
  await expect(f.controller.startGitHubAppSignIn()).resolves.toEqual({ status: 'unavailable', attempt: null })
  await expect(f.controller.disconnectGitHubApp()).resolves.toEqual({ status: 'unavailable', attempt: null })
})

it('does not start a device flow when the GitHub grant is already connected', async () => {
  const f = fixture('connected')
  await expect(f.controller.startGitHubAppSignIn()).resolves.toEqual({ status: 'connected', attempt: null })
  expect(f.begin).not.toHaveBeenCalled()
})

it('projects only a device URL and code, then settles cancellation without leaking notices', async () => {
  const f = fixture()
  let resolveBegin!: (outcome: AuthorizationOutcome) => void
  f.begin.mockImplementation(() => new Promise((resolve) => { resolveBegin = resolve }))
  const started = await f.controller.startGitHubAppSignIn()
  expect(started).toMatchObject({ status: 'needs-auth', attempt: { phase: 'starting' } })
  const request = f.request
  if (request === undefined) throw new Error('test authorization request was not captured')
  request.interaction.notify({ message: 'token-shaped private message', url: 'https://github.com/login/device', code: 'ABCD-EFGH' })
  expect(await f.controller.getGitHubAppSignIn()).toEqual({
    status: 'needs-auth', attempt: { id: started.attempt?.id, phase: 'waiting', url: 'https://github.com/login/device', code: 'ABCD-EFGH' },
  })
  await expect(f.controller.startGitHubAppSignIn()).resolves.toMatchObject({
    status: 'needs-auth', attempt: { id: started.attempt?.id, phase: 'waiting' },
  })
  await expect(request.interaction.prompt({ kind: 'text', message: 'not used' })).rejects.toThrow('does not use prompts')
  expect(JSON.stringify(await f.controller.getGitHubAppSignIn())).not.toContain('token-shaped')
  request.interaction.notify({ message: 'ignore this notice', url: 'https://example.invalid/device' })
  expect((await f.controller.getGitHubAppSignIn()).attempt?.phase).toBe('waiting')
  const cancelled = f.controller.cancelGitHubAppSignIn(started.attempt!.id)
  await vi.waitFor(() => {
    expect(request.signal?.aborted).toBe(true)
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(GITHUB_APP_CREDENTIAL_KEY)
  })
  resolveBegin({ status: 'cancelled' })
  await expect(cancelled).resolves.toMatchObject({ status: 'needs-auth', attempt: { phase: 'cancelled' } })
})

it('shows succeeded without exposing the provider grant and disconnects after settling the flow', async () => {
  const f = fixture()
  f.begin.mockResolvedValue({ status: 'authorized' })
  await f.controller.startGitHubAppSignIn()
  await expect(f.controller.getGitHubAppSignIn()).resolves.toMatchObject({ status: 'needs-auth', attempt: { phase: 'succeeded' } })
  expect(JSON.stringify(await f.controller.getGitHubAppSignIn())).not.toMatch(/token|secret/i)
  await expect(f.controller.disconnectGitHubApp()).resolves.toEqual({ status: 'needs-auth', attempt: null })
  expect(f.auth.disconnect).toHaveBeenCalledTimes(1)
})

it('turns provider failures into a redacted terminal phase', async () => {
  const f = fixture()
  f.begin.mockRejectedValue(new Error('private access token must not cross Remote'))
  await f.controller.startGitHubAppSignIn()
  const view = await f.controller.getGitHubAppSignIn()
  expect(view).toMatchObject({ status: 'needs-auth', attempt: { phase: 'failed' } })
  expect(JSON.stringify(view)).not.toContain('private access token')
})

it('marks an aborted provider rejection as cancelled', async () => {
  const f = fixture()
  let rejectBegin!: (reason: Error) => void
  f.begin.mockImplementation(() => new Promise((_, reject) => { rejectBegin = reject }))
  const started = await f.controller.startGitHubAppSignIn()
  const request = f.request
  if (request === undefined) throw new Error('test authorization request was not captured')
  const cancelled = f.controller.cancelGitHubAppSignIn(started.attempt!.id)
  await vi.waitFor(() => { expect(f.cancel).toHaveBeenCalledTimes(1) })
  rejectBegin(new Error('provider stopped after cancellation'))
  await expect(cancelled).resolves.toMatchObject({ status: 'needs-auth', attempt: { phase: 'cancelled' } })
  expect(request.signal?.aborted).toBe(true)
})

it('treats provider status failures as a request to sign in again', async () => {
  const f = fixture()
  f.auth.status.mockRejectedValue(new Error('private provider failure'))
  await expect(f.controller.getGitHubAppSignIn()).resolves.toEqual({ status: 'needs-auth', attempt: null })
})

it('keeps the terminal attempt visible when disconnect fails', async () => {
  const f = fixture()
  f.begin.mockResolvedValue({ status: 'authorized' })
  f.auth.disconnect.mockRejectedValueOnce(new Error('private provider failure'))
  await f.controller.startGitHubAppSignIn()
  await vi.waitFor(async () => {
    expect((await f.controller.getGitHubAppSignIn()).attempt?.phase).toBe('succeeded')
  })
  await expect(f.controller.disconnectGitHubApp()).resolves.toMatchObject({
    status: 'needs-auth', attempt: { phase: 'succeeded' },
  })
})

it('does not let a settled attempt deliver its code to a newer attempt', async () => {
  const f = fixture()
  const outcomes: Array<(outcome: AuthorizationOutcome) => void> = []
  f.begin.mockImplementation(() => new Promise((resolve) => { outcomes.push(resolve) }))
  const first = await f.controller.startGitHubAppSignIn()
  const firstRequest = f.request
  if (firstRequest === undefined) throw new Error('first authorization request was not captured')
  firstRequest.interaction.notify({ message: 'first', url: 'https://github.com/login/device', code: 'FIRST-CODE' })
  const cancelled = f.controller.cancelGitHubAppSignIn(first.attempt!.id)
  await vi.waitFor(() => { expect(firstRequest.signal?.aborted).toBe(true) })
  outcomes[0]?.({ status: 'cancelled' })
  await cancelled

  const second = await f.controller.startGitHubAppSignIn()
  const secondRequest = f.request
  if (secondRequest === undefined) throw new Error('second authorization request was not captured')
  firstRequest.interaction.notify({ message: 'stale', url: 'https://github.com/login/device', code: 'STALE-CODE' })
  secondRequest.interaction.notify({ message: 'second', url: 'https://github.com/login/device', code: 'SECOND-CODE' })
  await expect(f.controller.getGitHubAppSignIn()).resolves.toMatchObject({
    status: 'needs-auth', attempt: { id: second.attempt?.id, phase: 'waiting', code: 'SECOND-CODE' },
  })
  outcomes[1]?.({ status: 'cancelled' })
  await vi.waitFor(async () => { expect((await f.controller.getGitHubAppSignIn()).attempt?.phase).toBe('cancelled') })
})

it('serializes disconnect and a newly queued start', async () => {
  const f = fixture()
  f.begin.mockImplementation(request => new Promise((resolve) => {
    request.signal?.addEventListener('abort', () => { resolve({ status: 'cancelled' }) }, { once: true })
  }))
  const started = await f.controller.startGitHubAppSignIn()
  const disconnect = f.controller.disconnectGitHubApp()
  const queuedStart = f.controller.startGitHubAppSignIn()
  expect(f.begin).toHaveBeenCalledTimes(1)
  await disconnect
  await queuedStart
  expect(f.auth.disconnect).toHaveBeenCalledTimes(1)
  expect(f.begin).toHaveBeenCalledTimes(2)
  expect(started.attempt?.id).not.toBe((await f.controller.getGitHubAppSignIn()).attempt?.id)
})

it('settles the active attempt when the Host fiber is disposed', async () => {
  const f = fixture()
  f.begin.mockImplementation(request => new Promise((resolve) => {
    request.signal?.addEventListener('abort', () => { resolve({ status: 'cancelled' }) }, { once: true })
  }))
  await f.controller.startGitHubAppSignIn()
  await f.ctx.fiber.dispose()
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(GITHUB_APP_CREDENTIAL_KEY)
  await expect(f.controller.startGitHubAppSignIn()).resolves.toEqual({ status: 'unavailable', attempt: null })
})

it('accepts only an opaque attempt id when cancelling a stale attempt', async () => {
  const f = fixture()
  f.begin.mockResolvedValue({ status: 'authorized' })
  const started = await f.controller.startGitHubAppSignIn()
  const stale = brandString<GitHubAppSignInAttemptId>('stale-attempt')
  await f.controller.cancelGitHubAppSignIn(stale)
  expect(f.cancel).not.toHaveBeenCalled()
  expect((await f.controller.getGitHubAppSignIn()).attempt?.id).toBe(started.attempt?.id)
})
