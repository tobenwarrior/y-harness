/**
 * Loopback bridge that puts the Compound code-map viewer inside Y Harness.
 *
 * The vendored viewer is a small site served by its own loopback process. It
 * refuses foreign origins, refuses framing, and calls absolute `/api/…` paths,
 * so a browser page cannot embed the original. This bridge serves the same
 * assets from the Harness origin with those API paths pointed at a proxy, and
 * proxies the calls themselves to `127.0.0.1`, which is the only host the
 * service accepts.
 *
 * @module @deepseek-ai/dsh-skill-compound
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Same-origin prefix every viewer asset and proxied call is served under. */
export const MAP_ROUTE_PREFIX = '/api/skill-compound.map'

/** Route the panel frames; the viewer's own assets resolve beside it. */
export const VIEWER_ROUTE = `${MAP_ROUTE_PREFIX}/viewer`

/** Viewer assets served unchanged, with their content types. */
const ASSETS: ReadonlyMap<string, string> = new Map([
  ['code-map.css', 'text/css; charset=utf-8'],
  ['map-graph.js', 'text/javascript; charset=utf-8'],
])

/** Viewer script served with its API paths rewritten onto the proxy prefix. */
const VIEWER_SCRIPT = 'code-map.js'

/** Service endpoints forwarded to the loopback process. */
const PROXIED_ENDPOINTS = ['projects', 'map', 'status', 'file'] as const

/** Absolute API path the vendored viewer builds its requests from. */
const VIEWER_API_PREFIX = '"/api/'

/**
 * Point the viewer's absolute API paths at this bridge's proxy.
 *
 * The vendored file stays byte-identical on disk; only the bytes served to the
 * browser change, because the viewer addresses the service by absolute path and
 * the Harness origin owns a different `/api` namespace.
 * @param source - vendored `code-map.js` contents.
 * @returns the same script with every API literal under {@link MAP_ROUTE_PREFIX}.
 */
export function rewriteViewerScript(source: string): string {
  return source.replaceAll(VIEWER_API_PREFIX, `"${MAP_ROUTE_PREFIX}/`)
}

/** Loopback target one viewer session talks to. */
export interface MapTarget {
  /** Port the service listens on. */
  readonly port: number
  /** Project id the service registered for this workspace. */
  readonly project: string
}

/** Environment variable the vendored scripts read for their state directory. */
export const STATE_DIR_VARIABLE = 'COMPOUND_SKILLS_STATE_DIR'

/**
 * Whether one path lies inside another.
 * @param candidate - absolute path to test.
 * @param root - absolute directory to test against.
 * @returns whether `candidate` is `root` or sits beneath it.
 */
function isInside(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/**
 * Choose the cache directory the vendored service keeps its index in.
 *
 * The service refuses a state directory inside the repository it maps, and a
 * deployment may run with `HOME` inside the checkout, so an in-repository
 * candidate falls back to the system temporary directory. An explicit
 * configuration or environment value is respected as written: a deliberate
 * choice the service then refuses should say so rather than be overridden.
 * @param workspaceRoot - absolute repository root being mapped.
 * @param configured - explicit config or environment value, when present.
 * @param home - home directory candidate; defaults to the process home.
 * @param temp - fallback directory; defaults to the system temporary directory.
 * @returns the absolute state directory to hand the service.
 */
export function resolveStateDir(
  workspaceRoot: string,
  configured: string | undefined = process.env[STATE_DIR_VARIABLE],
  home: string = homedir(),
  temp: string = tmpdir(),
): string {
  if (configured !== undefined && configured !== '') return configured
  const preferred = join(home, '.cache', 'compound-skills')
  return isInside(preferred, workspaceRoot) ? join(temp, 'compound-skills') : preferred
}

/** Deliberate inputs of one bridge. */
export interface MapBridgeOptions {
  /** Absolute Python 3.11+ interpreter that runs the vendored service. */
  readonly python: string
  /** Absolute assets directory holding the vendored skill folders. */
  readonly assetRoot: string
  /** Resolves the current assets directory when a private Compound overlay is active. */
  readonly assetRootFor?: () => string
  /** Absolute repository root the map is opened for. */
  readonly workspaceRoot: string
  /** Absolute cache directory for the service; defaults outside the mapped repository. */
  readonly stateDir?: string
  /** Starts the service and returns the viewer URL it printed; injectable for tests. */
  readonly startService?: (python: string, script: string, root: string, stateDir: string) => string
  /** Performs one proxied request; injectable for tests. */
  readonly forward?: (url: string, request: Request) => Promise<Response>
}

/**
 * Start the vendored service and register the workspace, without a browser.
 * @param python - absolute interpreter.
 * @param script - absolute `map_server.py` path.
 * @param root - absolute repository root to register.
 * @param stateDir - absolute cache directory the service may keep its index in.
 * @returns the viewer URL the script printed.
 * @throws when the interpreter cannot run, the script fails, or no URL is printed.
 */
function startMapService(python: string, script: string, root: string, stateDir: string): string {
  const result = spawnSync(python, ['-B', script, 'open', '--repo', root, '--no-open'], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, [STATE_DIR_VARIABLE]: stateDir },
  })
  if (result.error !== undefined) throw result.error
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.status !== 0) throw new Error(`code-map service exited ${String(result.status)}: ${output.slice(-300)}`)
  const url = output.split('\n').map(line => line.trim()).filter(line => line.startsWith('http')).pop()
  if (url === undefined) throw new Error(`code-map service printed no viewer URL: ${output.slice(-300)}`)
  return url
}

/**
 * Forward one viewer request to the loopback service.
 *
 * No `Origin` header is sent and the target host is `127.0.0.1`, which is
 * exactly what the service's own origin guard accepts.
 * @param url - absolute loopback URL.
 * @param request - the browser request being served.
 * @returns the service response.
 */
function forwardToService(url: string, request: Request): Promise<Response> {
  return fetch(url, { headers: { accept: 'application/json' }, signal: request.signal })
}

/** Owns one process's map target and the responses served from it. */
export class MapServiceBridge {
  private target: Promise<MapTarget> | undefined

  /** @param options - interpreter, assets, workspace root, and injectable edges. */
  constructor(private readonly options: MapBridgeOptions) {}

  /** Resolve the assets directory for a service start or viewer asset read. */
  private currentAssetRoot(): string {
    return this.options.assetRootFor?.() ?? this.options.assetRoot
  }

  /** Drop the cached target so the next request starts the current revision. */
  invalidate(): void {
    this.target = undefined
  }

  /**
   * Resolve the loopback target once per process.
   * @returns the service port and the project id registered for the workspace.
   * @throws when the service cannot be started or printed no usable URL.
   */
  private resolveTarget(): Promise<MapTarget> {
    this.target ??= Promise.resolve().then(() => {
      const url = (this.options.startService ?? startMapService)(
        this.options.python,
        join(this.currentAssetRoot(), 'compound', 'scripts', 'map_server.py'),
        this.options.workspaceRoot,
        this.options.stateDir ?? resolveStateDir(this.options.workspaceRoot),
      )
      const parsed = new URL(url)
      const project = parsed.searchParams.get('project')
      if (project === null || project === '') throw new Error(`code-map service printed no project id: ${url}`)
      return { port: Number(parsed.port), project }
    }).catch((error: unknown) => {
      this.target = undefined
      throw error
    })
    return this.target
  }

  /**
   * Read one vendored viewer asset.
   * @param name - file name inside the vendored assets directory.
   * @returns the file contents, with the viewer script rewritten.
   */
  private readAsset(name: string): string {
    const path = join(this.currentAssetRoot(), 'compound', 'assets', name)
    const source = readFileSync(path, 'utf8')
    return name === VIEWER_SCRIPT ? rewriteViewerScript(source) : source
  }

  /**
   * Answer one viewer document or asset.
   * @param name - requested file name.
   * @param contentType - content type to serve it with.
   * @returns the asset response, uncached and without a framing restriction.
   */
  respond(name: string, contentType: string): Response {
    return new Response(this.readAsset(name), {
      headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    })
  }

  /**
   * Forward one viewer API call to the loopback service.
   * @param endpoint - proxied endpoint name.
   * @param request - the browser request being served.
   * @returns the service response, or a 502 that carries why the map is unavailable.
   */
  async proxy(endpoint: string, request: Request): Promise<Response> {
    const failure = (error: unknown): Response => Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    )
    let target: MapTarget
    const targetPromise = this.resolveTarget()
    try {
      target = await targetPromise
    } catch (error: unknown) {
      return failure(error)
    }
    try {
      const query = new URL(request.url).search
      const response = await (this.options.forward ?? forwardToService)(`http://127.0.0.1:${target.port}/api/${endpoint}${query}`, request)
      if (endpoint !== 'projects' || !response.ok) return response
      const payload = await response.json() as Record<string, unknown>
      return Response.json({ ...payload, defaultProject: target.project }, { headers: { 'cache-control': 'no-store' } })
    } catch (error: unknown) {
      if (!request.signal.aborted && this.target === targetPromise) this.target = undefined
      return failure(error)
    }
  }
}

/** The four viewer assets plus the document, as routes to register. */
export const MAP_ASSET_ROUTES: readonly { readonly path: string; readonly name: string; readonly contentType: string }[] = [
  { path: VIEWER_ROUTE, name: 'code-map.html', contentType: 'text/html; charset=utf-8' },
  { path: `${MAP_ROUTE_PREFIX}/${VIEWER_SCRIPT}`, name: VIEWER_SCRIPT, contentType: 'text/javascript; charset=utf-8' },
  ...[...ASSETS].map(([name, contentType]) => ({ path: `${MAP_ROUTE_PREFIX}/${name}`, name, contentType })),
]

/** Proxied viewer calls, as routes to register. */
export const MAP_PROXY_ROUTES: readonly { readonly path: string; readonly endpoint: string }[] =
  PROXIED_ENDPOINTS.map(endpoint => ({ path: `${MAP_ROUTE_PREFIX}/${endpoint}`, endpoint }))

/**
 * Register the viewer document, its assets, and the proxied service calls.
 * @param ctx - Context carrying the shared API channel.
 * @param bridge - process-wide bridge owning the loopback target.
 */
export function registerMapRoutes(ctx: Context, bridge: MapServiceBridge): void {
  for (const route of MAP_ASSET_ROUTES) {
    ctx.connection.fetch.register({
      path: route.path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(bridge.respond(route.name, route.contentType)),
    })
  }
  for (const route of MAP_PROXY_ROUTES) {
    ctx.connection.fetch.register({
      path: route.path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => bridge.proxy(route.endpoint, request),
    })
  }
}
