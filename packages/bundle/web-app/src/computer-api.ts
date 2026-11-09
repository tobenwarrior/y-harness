/** Exact owner-authenticated Web routes for the private Computer panel. */

import type { Branded } from '@yharness/brand'
import type { ConnectionFetchRoute } from '@yharness/client-connection'

type ViewerId = Branded<'computer-viewer-id'>
type Action = (viewer: ViewerId, signal: AbortSignal) => Promise<unknown>

interface ComputerRouteController {
  readonly frame: Action
  readonly takeControl: Action
  readonly releaseControl: Action
  readonly input: (viewer: ViewerId, action: unknown, signal: AbortSignal) => Promise<unknown>
}

const BODY_LIMIT = 16_384
const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function viewerId(value: unknown): ViewerId | undefined {
  return typeof value === 'string' && VIEWER_ID.test(value) ? value as ViewerId : undefined
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/**
 * Build the exact routes carried by Connection's authenticated operator channel.
 * @param computer - Desktop controller shared with the model tool.
 * @returns The five private POST routes.
 */
export function computerRoutes(computer: ComputerRouteController): readonly ConnectionFetchRoute[] {
  const actions: Readonly<Record<string, (id: ViewerId, payload: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>> = {
    frame: (id, _payload, signal) => computer.frame(id, signal),
    'take-control': (id, _payload, signal) => computer.takeControl(id, signal),
    'release-control': (id, _payload, signal) => computer.releaseControl(id, signal),
    input: (id, payload, signal) => computer.input(id, payload.action, signal),
  }
  return [
    {
      path: '/api/computer/status',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        try {
          return isRecord(await readPayload(request)) ? json({ available: true }) : json({ error: 'invalid-request' }, 400)
        } catch (error) {
          // Ignore malformed or interrupted probe requests.
          void error
          return json({ error: 'invalid-request' }, 400)
        }
      },
    },
    ...Object.entries(actions).map(([endpoint, handle]): ConnectionFetchRoute => ({
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
        const id = isRecord(payload) ? viewerId(payload.viewerId) : undefined
        if (id === undefined || !isRecord(payload)) return json({ error: 'invalid-request' }, 400)
        try {
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
