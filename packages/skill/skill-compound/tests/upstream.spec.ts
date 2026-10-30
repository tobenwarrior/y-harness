import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@yharness/cordis'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import {
  APPLY_ROUTE, compareReleases, registerUpdateRoute, UPDATE_ROUTE, UPSTREAM_REPOSITORY, UpstreamReleaseTracker,
  VENDORED_VERSION,
} from '../src/upstream.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('release comparison', () => {
  it('orders plain releases by each component', () => {
    expect(compareReleases('0.11.0', '0.11.0')).toBe(0)
    expect(compareReleases('0.12.0', '0.11.9')).toBeGreaterThan(0)
    expect(compareReleases('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareReleases('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareReleases('0.11.10', '0.11.9')).toBeGreaterThan(0)
  })

  it('answers nothing for values that are not plain releases', () => {
    expect(compareReleases('0.11', '0.11.0')).toBeUndefined()
    expect(compareReleases('0.11.0', 'v0.11.0')).toBeUndefined()
    expect(compareReleases('0.11.0-beta.1', '0.11.0')).toBeUndefined()
  })
})

describe('upstream release tracker', () => {
  it('reports an available update when upstream publishes a later release', async () => {
    const tracker = new UpstreamReleaseTracker(() => Promise.resolve('0.12.0'))
    const status = await tracker.status()
    expect(status).toMatchObject({
      vendored: VENDORED_VERSION, upstream: '0.12.0', updateAvailable: true, repository: UPSTREAM_REPOSITORY, error: null,
    })
    expect(status.checkedAt).toBeTypeOf('number')
  })

  it('reports no update when upstream matches or trails the vendored release', async () => {
    await expect(new UpstreamReleaseTracker(() => Promise.resolve(VENDORED_VERSION)).status())
      .resolves.toMatchObject({ updateAvailable: false, error: null })
    await expect(new UpstreamReleaseTracker(() => Promise.resolve('0.10.0')).status())
      .resolves.toMatchObject({ updateAvailable: false, error: null })
  })

  it('reports an unreadable upstream without claiming an update', async () => {
    const offline = await new UpstreamReleaseTracker(() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))).status()
    expect(offline).toMatchObject({ upstream: null, updateAvailable: false, error: 'getaddrinfo ENOTFOUND' })
    const reason: unknown = 'plain string'
    const rejected = await new UpstreamReleaseTracker(() => { throw reason }).status()
    expect(rejected.error).toBe('plain string')
  })

  it('refuses to compare a release upstream publishes in an unexpected form', async () => {
    const status = await new UpstreamReleaseTracker(() => Promise.resolve('0.12.0-rc.1')).status()
    expect(status).toMatchObject({ upstream: '0.12.0-rc.1', updateAvailable: false })
    expect(status.error).toContain('not a plain major.minor.patch version')
  })

  it('reuses a reading until its window expires, and retries a failure sooner', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'))
    const reader = vi.fn(() => Promise.resolve('0.12.0'))
    const tracker = new UpstreamReleaseTracker(reader)
    await tracker.status()
    vi.setSystemTime(new Date('2026-10-18T05:59:00Z'))
    await tracker.status()
    expect(reader).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-18T06:01:00Z'))
    await tracker.status()
    expect(reader).toHaveBeenCalledTimes(2)

    const failing = vi.fn(() => Promise.reject(new Error('offline')))
    const failingTracker = new UpstreamReleaseTracker(failing)
    await failingTracker.status()
    vi.setSystemTime(new Date('2026-10-18T06:10:00Z'))
    await failingTracker.status()
    expect(failing).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-10-18T06:16:00Z'))
    await failingTracker.status()
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('drops a cached reading when the active baseline revision changes', async () => {
    let baseline = { version: VENDORED_VERSION, commit: 'd36f372a60624b92e0e364871cae2c50cbf4ba01' }
    const reader = vi.fn(() => Promise.resolve({ version: '2.0.0', commit: 'a'.repeat(40) }))
    const tracker = new UpstreamReleaseTracker(reader, () => baseline)
    await expect(tracker.status()).resolves.toMatchObject({ vendored: VENDORED_VERSION, updateAvailable: true })
    baseline = { version: '2.0.0', commit: 'a'.repeat(40) }
    await expect(tracker.status()).resolves.toMatchObject({ vendored: '2.0.0', updateAvailable: false })
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('re-reads when the active baseline changes during a remote read', async () => {
    let baseline = { version: VENDORED_VERSION, commit: 'd36f372a60624b92e0e364871cae2c50cbf4ba01' }
    const first = Promise.withResolvers<{ version: string; commit: string }>()
    const reader = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ version: '2.0.0', commit: 'a'.repeat(40) })
    const tracker = new UpstreamReleaseTracker(reader, () => baseline)
    const status = tracker.status()
    await Promise.resolve()
    baseline = { version: '2.0.0', commit: 'a'.repeat(40) }
    first.resolve({ version: '2.0.0', commit: 'a'.repeat(40) })
    await expect(status).resolves.toMatchObject({ vendored: '2.0.0', updateAvailable: false, error: null })
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('detects a changed commit at the same version and ignores an older version', async () => {
    const changed = { version: VENDORED_VERSION, commit: 'a'.repeat(40) }
    await expect(new UpstreamReleaseTracker(() => Promise.resolve(changed)).status()).resolves.toMatchObject({
      updateAvailable: true, error: null,
    })
    await expect(new UpstreamReleaseTracker(() => Promise.resolve({ ...changed, version: '0.10.0' })).status()).resolves.toMatchObject({ updateAvailable: false, error: null })
    await expect(new UpstreamReleaseTracker(() => Promise.resolve({ ...changed, commit: 'd36f372a60624b92e0e364871cae2c50cbf4ba01' })).status()).resolves.toMatchObject({ updateAvailable: false, error: null })
  })

  it('reads the published release from the repository raw file', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      requested.push(url)
      return Promise.resolve(Response.json(url.includes('api.github.com') ? { sha: 'a'.repeat(40) } : { name: 'compound-skills', version: '0.13.0' }))
    })
    const status = await new UpstreamReleaseTracker().status()
    expect(requested).toEqual([`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/main`, `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${'a'.repeat(40)}/plugin.json`])
    expect(status).toMatchObject({ upstream: '0.13.0', updateAvailable: true, error: null })
  })

  it.each([403, 429])('uses noninteractive git head fallback for GitHub HTTP %s rate limits', async (statusCode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-compound-git-head-'))
    const git = join(root, 'git')
    const marker = join(root, 'environment')
    const commit = 'b'.repeat(40)
    const previousPath = process.env.PATH
    await writeFile(git, `#!/bin/sh\nprintf '%s\\n' "$GIT_TERMINAL_PROMPT|$GIT_ASKPASS|$SSH_ASKPASS|$SSH_ASKPASS_REQUIRE" > ${JSON.stringify(marker)}\nprintf '%s\\n' '${commit} refs/heads/main'\n`)
    await chmod(git, 0o755)
    process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`
    const requested: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      requested.push(url)
      if (url.includes('/commits/')) return Promise.resolve(new Response('rate limited', { status: statusCode, headers: { 'x-ratelimit-remaining': '0' } }))
      return Promise.resolve(Response.json({ name: 'compound-skills', version: '0.13.0' }))
    })
    try {
      const result = await new UpstreamReleaseTracker().status()
      expect(result).toMatchObject({ upstream: '0.13.0', updateAvailable: true, error: null })
      expect(requested).toEqual([`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits/main`, `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit}/plugin.json`])
      expect(await readFile(marker, 'utf8')).toBe('0|||' + 'never\n')
    } finally {
      process.env.PATH = previousPath
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the HTTP status when the raw file is not served', async () => {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(url.includes('api.github.com') ? Response.json({ sha: 'a'.repeat(40) }) : new Response('nope', { status: 404 })))
    await expect(new UpstreamReleaseTracker().status()).resolves.toMatchObject({ error: 'upstream plugin.json answered HTTP 404' })
  })

  it('reports a body that is not JSON', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('not json', { status: 200 })))
    const status = await new UpstreamReleaseTracker().status()
    expect(status).toMatchObject({ upstream: null, updateAvailable: false })
    expect(status.error).not.toBeNull()
  })

  it('reports JSON that carries no version', async () => {
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(Response.json(url.includes('api.github.com') ? { sha: 'a'.repeat(40) } : { name: 'compound-skills' })))
    await expect(new UpstreamReleaseTracker().status()).resolves.toMatchObject({ error: 'upstream plugin.json carries no version' })
  })

  it('cancels an in-flight remote read when its caller is disposed', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('upstream read aborted', { cause: init.signal?.reason }))
      }, { once: true })
    }))
    const reading = new UpstreamReleaseTracker().status(controller.signal)
    controller.abort()
    await expect(reading).resolves.toMatchObject({ upstream: null, updateAvailable: false })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('answers the registered route with the current status and no caching', async () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    registerUpdateRoute(ctx, new UpstreamReleaseTracker(() => Promise.resolve('0.12.0')))
    expect(routes.map(route => route.path)).toEqual([UPDATE_ROUTE, APPLY_ROUTE])
    expect(routes[0]?.methods).toEqual(['GET'])
    const response = await routes[0]?.fetch(new Request(`http://127.0.0.1${UPDATE_ROUTE}`))
    expect(response?.headers.get('cache-control')).toBe('no-store')
    await expect(response?.json()).resolves.toMatchObject({ vendored: VENDORED_VERSION, upstream: '0.12.0', updateAvailable: true })
    await ctx.fiber.dispose()
  })

  it('applies through the injected procedure and drops the cached reading', async () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    const tracker = new UpstreamReleaseTracker(() => Promise.resolve('0.12.0'))
    let applied = 0
    registerUpdateRoute(ctx, tracker, async () => {
      applied += 1
      return { status: 'updated', upstream: '0.12.0', error: null }
    })
    const applyRoute = routes.find(route => route.path === APPLY_ROUTE)
    expect(applyRoute?.methods).toEqual(['POST'])
    const response = await applyRoute?.fetch(new Request(`http://127.0.0.1${APPLY_ROUTE}`, { method: 'POST' }))
    await expect(response?.json()).resolves.toEqual({ status: 'updated', upstream: '0.12.0', error: null })
    expect(applied).toBe(1)
    // A second attempt while the first runs must not race it into the checkout.
    const slow = routes.find(route => route.path === APPLY_ROUTE)?.fetch
    const first = slow?.(new Request(`http://127.0.0.1${APPLY_ROUTE}`, { method: 'POST' }))
    const second = slow?.(new Request(`http://127.0.0.1${APPLY_ROUTE}`, { method: 'POST' }))
    const [one, two] = await Promise.all([first, second])
    expect([one?.status, two?.status].sort()).toEqual([200, 409])
    await ctx.fiber.dispose()
  })
})

it('compares upstream against the active installed revision', async () => {
  const commit = 'a'.repeat(40)
  const tracker = new UpstreamReleaseTracker(
    () => Promise.resolve({ version: '0.12.0', commit }),
    () => ({ version: '0.12.0', commit }),
  )
  await expect(tracker.status()).resolves.toMatchObject({ vendored: '0.12.0', updateAvailable: false, error: null })
})
