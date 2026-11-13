/** Exact owner-authenticated Web routes for the private Computer panel. */

import type { Branded } from '@yharness/brand'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { ComputerSignInAction, VpsComputer } from './computer.ts'
import { validateIsolatedBrowserUrl } from './vps-isolated-browser.ts'

type ViewerId = Branded<'computer-viewer-id'>
type Action = (viewer: ViewerId, signal: AbortSignal) => Promise<unknown>

interface ComputerRouteController {
  readonly frame: Action
  readonly takeControl: Action
  readonly releaseControl: Action
  readonly input: (viewer: ViewerId, action: unknown, signal: AbortSignal) => Promise<unknown>
  readonly status?: () => { readonly available: boolean }
}

interface ResolvedComputer {
  readonly controller: ComputerRouteController
  readonly metadata?: ComputerStatusMetadata
  readonly navigate?: (viewer: string, url: string, signal: AbortSignal) => Promise<unknown>
}

interface ComputerSignInRouteTarget {
  readonly status: () => ReturnType<VpsComputer['signInRequest']>
  readonly answer: VpsComputer['answerSignIn']
}

/** Cloud Computer location exposed by an authenticated status response. */
export type ComputerLocation = 'vps'

/** Owner scope to which a Cloud Computer's permissions apply. */
export type ComputerPermissionScope = 'bot' | 'workspace'

/** Stable identity metadata for the Computer selected by the active Bot. */
export interface ComputerStatusMetadata {
  /** Stable owner id for the isolated Bot, or `shared-vps` for the legacy display. */
  readonly id: string
  /** Execution location; credentials and host paths are intentionally omitted. */
  readonly location: ComputerLocation
  /** Whether input and display access are isolated to a Bot or shared by the workspace. */
  readonly permissionScope: ComputerPermissionScope
  /** Whether the Computer exposes browser address navigation. */
  readonly browser?: true
}

/** Server-selected Computer target for a Bot Session route. */
export interface BotComputerRouteTarget {
  /** Controller selected after resolving the exact owner Bot Session. */
  readonly computer: VpsComputer
  /** Stable identity rendered by the Web Computer status panel. */
  readonly id: string
  /** Whether permissions apply to the Bot or the legacy shared workspace. */
  readonly permissionScope: ComputerPermissionScope
  /** Network navigation for an isolated browser, admitted by this Computer's viewer lease. */
  readonly navigate?: (url: string, signal: AbortSignal) => Promise<void>
}

const BODY_LIMIT = 16_384
const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SESSION_ID = /^(?=.{1,256}$)[^\u0000-\u001f\u007f]+$/u

function viewerId(value: unknown): ViewerId | undefined {
  return typeof value === 'string' && VIEWER_ID.test(value) ? value as ViewerId : undefined
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface SessionTarget {
  readonly id: string
  readonly managed: boolean
}

function sessionTarget(payload: Record<string, unknown>, requireManaged: boolean): SessionTarget | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
    return requireManaged ? undefined : { id: '', managed: false }
  }
  const value = payload.sessionId
  return typeof value === 'string' && SESSION_ID.test(value) ? { id: value, managed: true } : undefined
}

async function readPayload(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (reader === undefined) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > BODY_LIMIT) {
        await reader.cancel()
        return undefined
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  return JSON.parse(text)
}

interface RouteOptions {
  readonly managed: boolean
  /** Permit the old shared route's omitted session id during an allowlisted rollout. */
  readonly allowMissingSession?: boolean
  readonly legacyComputer?: ComputerRouteController
  readonly status: (computer: ResolvedComputer | undefined, target: SessionTarget) => Response
}

function routesFor(
  resolveComputer: (sessionId: string) => Promise<ResolvedComputer | undefined>,
  options: RouteOptions,
): readonly ConnectionFetchRoute[] {
  const action = (computer: ComputerRouteController, endpoint: string) => {
    switch (endpoint) {
      case 'frame': return (id: ViewerId, _payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => computer.frame(id, signal)
      case 'take-control': return (id: ViewerId, _payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => computer.takeControl(id, signal)
      case 'release-control': return (id: ViewerId, _payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => computer.releaseControl(id, signal)
      case 'input': return (id: ViewerId, payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => computer.input(id, payload.action, signal)
      default: return undefined
    }
  }
  return [
    {
      path: '/api/computer/status',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        let payload: unknown
        try {
          payload = await readPayload(request)
        } catch (error) {
          // Ignore malformed or interrupted probe requests.
          void error
          return json({ error: 'invalid-request' }, 400)
        }
        if (!isRecord(payload)) return json({ error: 'invalid-request' }, 400)
        const target = sessionTarget(payload, options.managed && options.allowMissingSession !== true)
        if (target === undefined) return json({ error: 'invalid-request' }, 400)
        if (!options.managed) {
          return options.status(
            options.legacyComputer === undefined ? undefined : { controller: options.legacyComputer },
            target,
          )
        }
        try {
          return options.status(await resolveComputer(target.id), target)
        } catch (error) {
          // Lazy startup and provider diagnostics stay private to the Host.
          void error
          return options.status(undefined, target)
        }
      },
    },
    ...(['frame', 'take-control', 'release-control', 'input'] as const).map((endpoint): ConnectionFetchRoute => ({
      path: `/api/computer/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        let payload: unknown
        try {
          payload = await readPayload(request)
        } catch (error) {
          // Malformed or interrupted browser uploads never reach the controller.
          void error
          return json({ error: 'invalid-request' }, 400)
        }
        if (!isRecord(payload)) return json({ error: 'invalid-request' }, 400)
        const id = viewerId(payload.viewerId)
        const target = sessionTarget(payload, options.managed && options.allowMissingSession !== true)
        if (id === undefined || target === undefined) return json({ error: 'invalid-request' }, 400)
        try {
          const resolved = await resolveComputer(target.id)
          const handle = resolved === undefined ? undefined : action(resolved.controller, endpoint)
          if (handle === undefined) return json({ error: 'computer-unavailable' }, 409)
          return json(await handle(id, payload, request.signal))
        } catch (error) {
          // Process diagnostics can contain host paths or desktop details.
          void error
          return json({ error: 'computer-unavailable' }, 409)
        }
      },
    })),
  ]
}

function browserNavigationRoute(resolveComputer: (sessionId: string) => Promise<ResolvedComputer | undefined>): ConnectionFetchRoute {
  return {
    path: '/api/computer/navigate', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      let target: string
      let viewer: ViewerId
      let url: string
      try {
        const payload = await readPayload(request)
        if (!isRecord(payload) || Object.keys(payload).length !== 3 || typeof payload.url !== 'string') {
          return json({ error: 'invalid-request' }, 400)
        }
        const selected = sessionTarget(payload, true)
        const id = viewerId(payload.viewerId)
        if (selected === undefined || id === undefined) return json({ error: 'invalid-request' }, 400)
        target = selected.id
        viewer = id
        url = validateIsolatedBrowserUrl(payload.url)
      } catch (error) {
        void error
        return json({ error: 'invalid-request' }, 400)
      }
      try {
        const navigate = (await resolveComputer(target))?.navigate
        if (navigate !== undefined) return json(await navigate(viewer, url, request.signal))
      } catch (error) { void error }
      return json({ error: 'computer-unavailable' }, 409)
    },
  }
}

/**
 * Build the exact routes carried by Connection's authenticated operator channel.
 *
 * The legacy route keeps one shared VPS controller and ignores the optional
 * session id. Cloud Bot routes should use {@link botComputerRoutes} so the
 * active Session selects its own controller.
 * @param computer - Desktop controller shared with the model tool.
 * @returns The five private POST routes.
 */
export function computerRoutes(computer: ComputerRouteController): readonly ConnectionFetchRoute[] {
  return routesFor(() => Promise.resolve({ controller: computer }), {
    managed: false,
    legacyComputer: computer,
    status: resolved => json({
      available: resolved?.controller.status?.().available !== false,
      kind: 'vps',
      computer: {
        id: 'shared-vps',
        location: 'vps',
        permissionScope: 'workspace',
      } satisfies ComputerStatusMetadata,
    }),
  })
}

/**
 * Build owner-authenticated routes for per-Bot VPS Computers.
 *
 * A missing `sessionId` is rejected so a Bot cannot fall back to a shared
 * workspace Computer. A non-empty session id selects the isolated Bot Computer
 * and reports `permissionScope: 'bot'`.
 * Resolver failures and missing Computers produce a safe unavailable status or
 * a 409 action response without exposing provider diagnostics.
 * @param resolveComputer - Lazily resolve the Computer owned by a Bot Session.
 * @returns The same five private POST routes as the legacy Computer API.
 */
export function botComputerRoutes(
  resolveComputer: (sessionId: string) => Promise<VpsComputer | undefined>,
): readonly ConnectionFetchRoute[] {
  return routesFor(async (sessionId) => {
    const computer = await resolveComputer(sessionId)
    return computer === undefined ? undefined : { controller: computer }
  }, {
    managed: true,
    status: (resolved, target) => json({
      available: resolved?.controller.status?.().available === true,
      kind: 'vps',
      computer: {
        id: target.managed ? target.id : 'shared-vps',
        location: 'vps',
        permissionScope: target.managed ? 'bot' : 'workspace',
      } satisfies ComputerStatusMetadata,
    }),
  })
}

/**
 * Build one owner-authenticated route set that can select managed or legacy
 * Computer state only after resolving the exact server-owned Bot Session.
 *
 * The resolver must return `undefined` for unknown or inactive Sessions. A
 * client-supplied id therefore cannot choose the legacy controller as a
 * fallback; the Host decides whether a known Bot is selected for isolation.
 * @param resolveTarget - Resolve the server-selected Computer target.
 * @param options - Permit omitted session ids only for an explicit legacy rollout.
 * @returns Private Computer routes and the optional browser navigation route.
 */
export function botComputerRoutesWithLegacy(
  resolveTarget: (sessionId: string) => Promise<BotComputerRouteTarget | undefined>,
  options: { readonly allowMissingSession?: boolean } = {},
): readonly ConnectionFetchRoute[] {
  const resolveComputer = async (sessionId: string): Promise<ResolvedComputer | undefined> => {
    const target = await resolveTarget(sessionId)
    if (target === undefined) return undefined
    const navigate = target.navigate
    return {
      controller: target.computer,
      metadata: {
        id: target.id,
        location: 'vps',
        permissionScope: target.permissionScope,
        ...(navigate === undefined ? {} : { browser: true }),
      },
      ...(navigate === undefined ? {} : {
        navigate: (viewer, url, signal) => target.computer.navigateAsViewer(viewer, url, signal, navigate),
      }),
    }
  }
  return [...routesFor(resolveComputer, {
    managed: true,
    ...(options.allowMissingSession === undefined ? {} : { allowMissingSession: options.allowMissingSession }),
    status: (resolved, target) => {
      const metadata = resolved?.metadata ?? {
        id: target.id,
        location: 'vps' as const,
        permissionScope: 'bot' as const,
      }
      return json({
        available: resolved?.controller.status?.().available === true,
        kind: 'vps',
        computer: metadata satisfies ComputerStatusMetadata,
      })
    },
  }), browserNavigationRoute(resolveComputer)]
}

/**
 * Mount metadata and owner actions for eligible Bot sign-in handoffs.
 * @param resolve - Resolve an exact owner Session with sign-in access, without starting its desktop.
 * @returns The authenticated sign-in route. It accepts no form values or credentials.
 */
export function computerSignInRoute(
  resolve: (sessionId: string) => Promise<ComputerSignInRouteTarget | undefined>,
): ConnectionFetchRoute {
  return {
    path: '/api/computer/sign-in',
    methods: ['POST'],
    requestBody: 'streaming',
    async fetch(request) {
      let payload: unknown
      try {
        payload = await readPayload(request)
      } catch (error) {
        // Malformed or interrupted input never reaches the controller.
        void error
        return json({ error: 'invalid-request' }, 400)
      }
      if (!isRecord(payload)) return json({ error: 'invalid-request' }, 400)
      const target = sessionTarget(payload, true)
      if (target === undefined) return json({ error: 'invalid-request' }, 400)
      const action = payload.action
      if (action === 'status' && Object.keys(payload).length === 2) {
        try {
          const computer = await resolve(target.id)
          return json({ request: computer?.status() ?? null })
        } catch (error) {
          // Resolution errors must not disclose workspace metadata.
          void error
          return json({ error: 'computer-unavailable' }, 409)
        }
      }
      const id = payload.requestId
      const viewer = viewerId(payload.viewerId)
      if (typeof id !== 'string' || !VIEWER_ID.test(id) || !signInAction(action)
        || (viewer === undefined ? action !== 'cancel' || Object.keys(payload).length !== 3 : Object.keys(payload).length !== 4)) {
        return json({ error: 'invalid-request' }, 400)
      }
      try {
        const computer = await resolve(target.id)
        if (computer !== undefined) return json(await computer.answer(id, action, viewer, request.signal))
      } catch (error) {
        // Lease and provider diagnostics are private to the Host.
        void error
      }
      return json({ error: 'computer-unavailable' }, 409)
    },
  }
}

function signInAction(value: unknown): value is ComputerSignInAction {
  return value === 'take' || value === 'complete' || value === 'cancel'
}
