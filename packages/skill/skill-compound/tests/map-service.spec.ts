import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  MAP_ASSET_ROUTES, MAP_PROXY_ROUTES, MAP_ROUTE_PREFIX, MapServiceBridge, registerMapRoutes, resolveStateDir,
  rewriteViewerScript, STATE_DIR_VARIABLE, VIEWER_ROUTE,
} from '../src/map-service.ts'
import { describe, expect, it, vi } from 'vitest'

const assets = fileURLToPath(new URL('../assets/', import.meta.url))

/**
 * Build a bridge with injectable edges.
 * @param overrides - start and forward substitutions.
 * @returns the bridge and the recorded calls.
 */
function bridge(overrides: {
  startService?: () => string
  forward?: (url: string, request: Request) => Promise<Response>
} = {}) {
  const starts = vi.fn(overrides.startService ?? (() => 'http://127.0.0.1:43127/?project=abc123'))
  const forwards = vi.fn(overrides.forward ?? (() => Promise.resolve(Response.json({ model: {} }))))
  const service = new MapServiceBridge({
    python: '/usr/bin/python3.11',
    assetRoot: assets,
    workspaceRoot: '/work/repo',
    startService: starts,
    forward: forwards,
  })
  return { service, starts, forwards }
}

describe('viewer asset rewriting', () => {
  it('points absolute API literals at the proxy prefix', () => {
    const rewritten = rewriteViewerScript('const API = Object.freeze({ map: "/api/map" });')
    expect(rewritten).toBe(`const API = Object.freeze({ map: "${MAP_ROUTE_PREFIX}/map" });`)
    expect(rewriteViewerScript('const other = "/apiary";')).toBe('const other = "/apiary";')
  })

  it('rewrites the vendored viewer script the Harness serves', async () => {
    const { service } = bridge()
    const served = await service.respond('code-map.js', 'text/javascript; charset=utf-8').text()
    expect(served).toContain(`"${MAP_ROUTE_PREFIX}/map"`)
    expect(served).not.toContain('"/api/map"')
    expect(served).toContain('import { createGraph, groupColor } from "./map-graph.js";')
  })

  it('serves the document and the remaining assets unchanged', async () => {
    const { service } = bridge()
    const viewer = service.respond('code-map.html', 'text/html; charset=utf-8')
    expect(viewer.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await viewer.text()
    expect(html).toContain('<script type="module" src="./code-map.js">')
    // The vendored service refuses framing; the served copy must not.
    expect(html).not.toContain('frame-ancestors')
    const graph = await service.respond('map-graph.js', 'text/javascript; charset=utf-8').text()
    expect(graph.length).toBeGreaterThan(1000)
  })
})

describe('loopback proxy', () => {
  it('forwards a viewer call to the resolved service with its query', async () => {
    const { service, forwards } = bridge()
    const response = await service.proxy('map', new Request(`http://localhost${MAP_ROUTE_PREFIX}/map?project=abc&max_files=10`))
    expect(forwards).toHaveBeenCalledTimes(1)
    expect(forwards.mock.calls[0]?.[0]).toBe('http://127.0.0.1:43127/api/map?project=abc&max_files=10')
    expect(await response.json()).toEqual({ model: {} })
  })

  it('resolves the service once per process', async () => {
    const { service, starts } = bridge()
    await service.proxy('projects', new Request('http://localhost/x'))
    await service.proxy('status', new Request('http://localhost/x'))
    expect(starts).toHaveBeenCalledTimes(1)
  })

  it('answers 502 with the reason when the service cannot start', async () => {
    const { service } = bridge({ startService: () => { throw new Error('python3.11: not found') } })
    const response = await service.proxy('map', new Request('http://localhost/x'))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'python3.11: not found' })
  })

  it('refuses a viewer URL that names no project', async () => {
    const { service } = bridge({ startService: () => 'http://127.0.0.1:43127/?other=1' })
    const response = await service.proxy('map', new Request('http://localhost/x'))
    expect(response.status).toBe(502)
    const body = await response.json() as { error?: string }
    expect(body.error).toContain('printed no project id')
  })
})

describe('route registration', () => {
  it('registers the viewer, its assets, and every proxied endpoint', () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    const { service } = bridge()
    registerMapRoutes(ctx, service)
    expect(routes.map(route => route.path)).toEqual([
      VIEWER_ROUTE,
      ...MAP_ASSET_ROUTES.slice(1).map(route => route.path),
      ...MAP_PROXY_ROUTES.map(route => route.path),
    ])
    for (const route of routes) expect(route.methods).toEqual(['GET'])
    expect(routes.filter(route => route.path.startsWith(`${MAP_ROUTE_PREFIX}/`))).toHaveLength(8)
  })

  it('serves the registered viewer document through its handler', async () => {
    const routes: ConnectionFetchRoute[] = []
    const ctx = new Context()
    ctx.provide('connection', {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.push(route); return () => {} } },
    } as never)
    registerMapRoutes(ctx, bridge().service)
    const viewer = routes.find(route => route.path === VIEWER_ROUTE)
    const response = await viewer?.fetch(new Request(`http://localhost${VIEWER_ROUTE}`))
    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain('Compound · Code map')
  })
})

describe('service state directory', () => {
  it('names the environment variable the vendored scripts read', () => {
    expect(STATE_DIR_VARIABLE).toBe('COMPOUND_SKILLS_STATE_DIR')
  })

  it('keeps the cache outside a repository that contains the home directory', () => {
    expect(resolveStateDir('/work/repo', undefined, '/work/repo/.home', '/tmp')).toBe('/tmp/compound-skills')
    expect(resolveStateDir('/work/repo', undefined, '/Users/someone', '/tmp')).toBe('/Users/someone/.cache/compound-skills')
  })

  it('respects an explicit directory or environment value', () => {
    expect(resolveStateDir('/work/repo', '/chosen/state', '/work/repo/.home', '/tmp')).toBe('/chosen/state')
  })

  it('hands the resolved directory to the service it starts', async () => {
    const starts = vi.fn((_python: string, _script: string, _root: string, stateDir: string) => {
      expect(stateDir).toBe('/given/state')
      return 'http://127.0.0.1:43127/?project=abc123'
    })
    const service = new MapServiceBridge({
      python: 'python3.11', assetRoot: assets, workspaceRoot: '/work/repo', stateDir: '/given/state',
      startService: starts, forward: () => Promise.resolve(Response.json({ ok: true })),
    })
    await service.proxy('projects', new Request('http://localhost/x'))
    expect(starts).toHaveBeenCalledTimes(1)
  })
})
