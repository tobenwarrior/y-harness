/** Exact owner-authenticated Web routes for the private Computer panel. */

import type { Branded } from '@yharness/brand'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { VpsComputer } from './computer.ts'

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
}

/** Server-selected Computer target for a Bot Session route. */
export interface BotComputerRouteTarget {
  /** Controller selected after resolving the exact owner Bot Session. */
  readonly computer: VpsComputer
  /** Stable identity rendered by the Web Computer status panel. */
  readonly id: string
  /** Whether permissions apply to the Bot or the legacy shared workspace. */
  readonly permissionScope: ComputerPermissionScope
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

function sessionTarget(payload: Record<string, unknown>, requireManaged: boolean): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(payload, 'sessionId')) {
    return requireManaged ? undefined : ''
  }
  const value = payload.sessionId
  return typeof value === 'string' && SESSION_ID.test(value) ? value : undefined
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

async function readComputerRequest(request: Request, requireManaged: boolean) {
  let payload: unknown
  try {
    payload = await readPayload(request)
  } catch (error) {
    // Malformed or interrupted requests never reach a Computer controller.
    void error
    return undefined
  }
  if (!isRecord(payload)) return undefined
  const target = sessionTarget(payload, requireManaged)
  return target === undefined ? undefined : { payload, target }
}

interface RouteOptions {
  readonly managed: boolean
  /** Permit the old shared route's omitted session id during an allowlisted rollout. */
  readonly allowMissingSession?: boolean
  readonly status: (computer: ResolvedComputer | undefined, sessionId: string) => Response
}

type ComputerRouteAction = (
  computer: ComputerRouteController, viewer: ViewerId, payload: Record<string, unknown>, signal: AbortSignal,
) => Promise<unknown>

const actions: Readonly<Record<string, ComputerRouteAction>> = {
  frame: (computer, viewer, _payload, signal) => computer.frame(viewer, signal),
  'take-control': (computer, viewer, _payload, signal) => computer.takeControl(viewer, signal),
  'release-control': (computer, viewer, _payload, signal) => computer.releaseControl(viewer, signal),
  input: (computer, viewer, payload, signal) => computer.input(viewer, payload.action, signal),
}

function routesFor(
  resolveComputer: (sessionId: string) => Promise<ResolvedComputer | undefined>,
  options: RouteOptions,
): readonly ConnectionFetchRoute[] {
  const requireManaged = options.managed && options.allowMissingSession !== true
  return [
    {
      path: '/api/computer/status',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const parsed = await readComputerRequest(request, requireManaged)
        if (parsed === undefined) return json({ error: 'invalid-request' }, 400)
        const { target } = parsed
        if (!options.managed) return options.status(await resolveComputer(target), target)
        try {
          return options.status(await resolveComputer(target), target)
        } catch (error) {
          // Lazy startup and provider diagnostics stay private to the Host.
          void error
          return options.status(undefined, target)
        }
      },
    },
    ...Object.entries(actions).map(([endpoint, action]): ConnectionFetchRoute => ({
      path: `/api/computer/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        const parsed = await readComputerRequest(request, requireManaged)
        if (parsed === undefined) return json({ error: 'invalid-request' }, 400)
        const { payload, target } = parsed
        const id = viewerId(payload.viewerId)
        if (id === undefined) return json({ error: 'invalid-request' }, 400)
        try {
          const resolved = await resolveComputer(target)
          if (resolved === undefined) return json({ error: 'computer-unavailable' }, 409)
          return json(await action(resolved.controller, id, payload, request.signal))
        } catch (error) {
          // Process diagnostics can contain host paths or desktop details.
          void error
          return json({ error: 'computer-unavailable' }, 409)
        }
      },
    })),
  ]
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
  return botComputerRoutesWithLegacy(async (sessionId) => {
    const computer = await resolveComputer(sessionId)
    return computer === undefined ? undefined : { computer, id: sessionId, permissionScope: 'bot' }
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
 * @returns The same five private POST routes as the other Computer APIs.
 */
export function botComputerRoutesWithLegacy(
  resolveTarget: (sessionId: string) => Promise<BotComputerRouteTarget | undefined>,
  options: { readonly allowMissingSession?: boolean } = {},
): readonly ConnectionFetchRoute[] {
  return routesFor(async (sessionId) => {
    const target = await resolveTarget(sessionId)
    return target === undefined ? undefined : {
      controller: target.computer,
      metadata: {
        id: target.id,
        location: 'vps',
        permissionScope: target.permissionScope,
      },
    }
  }, {
    managed: true,
    ...(options.allowMissingSession === undefined ? {} : { allowMissingSession: options.allowMissingSession }),
    status: (resolved, sessionId) => {
      const metadata = resolved?.metadata ?? {
        id: sessionId,
        location: 'vps' as const,
        permissionScope: 'bot' as const,
      }
      return json({
        available: resolved?.controller.status?.().available === true,
        kind: 'vps',
        computer: metadata satisfies ComputerStatusMetadata,
      })
    },
  })
}
