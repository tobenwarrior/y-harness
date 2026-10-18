import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  compareReleases, registerUpdateRoute, UPDATE_ROUTE, UPSTREAM_REPOSITORY, UpstreamReleaseTracker, VENDORED_VERSION,
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

  it('reads the published release from the repository raw file', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      requested.push(url)
      return Promise.resolve(Response.json({ name: 'compound-skills', version: '0.13.0' }))
    })
    const status = await new UpstreamReleaseTracker().status()
    expect(requested).toEqual([`https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/main/plugin.json`])
    expect(status).toMatchObject({ upstream: '0.13.0', updateAvailable: true, error: null })
  })

  it('reports the HTTP status when the raw file is not served', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('nope', { status: 404 })))
    await expect(new UpstreamReleaseTracker().status()).resolves.toMatchObject({ error: 'upstream plugin.json answered HTTP 404' })
  })

  it('reports a body that is not JSON', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('not json', { status: 200 })))
    const status = await new UpstreamReleaseTracker().status()
    expect(status).toMatchObject({ upstream: null, updateAvailable: false })
    expect(status.error).not.toBeNull()
  })

  it('reports JSON that carries no version', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ name: 'compound-skills' })))
    await expect(new UpstreamReleaseTracker().status()).resolves.toMatchObject({ error: 'upstream plugin.json carries no version' })
  })

  it('answers the registered route with the current status and no caching', async () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    registerUpdateRoute(ctx, new UpstreamReleaseTracker(() => Promise.resolve('0.12.0')))
    expect(routes.map(route => route.path)).toEqual([UPDATE_ROUTE])
    expect(routes[0]?.methods).toEqual(['GET'])
    const response = await routes[0]?.fetch(new Request(`http://127.0.0.1${UPDATE_ROUTE}`))
    expect(response?.headers.get('cache-control')).toBe('no-store')
    await expect(response?.json()).resolves.toMatchObject({ vendored: VENDORED_VERSION, upstream: '0.12.0', updateAvailable: true })
    await ctx.fiber.dispose()
  })
})
