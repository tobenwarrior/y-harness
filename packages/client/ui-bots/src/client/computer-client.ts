/** Browser client for the authenticated Computer side-panel routes. */

export type ComputerMode = 'watching' | 'controlling' | 'other'

/** Direct response from the Computer status route. */
export interface ComputerStatus {
  readonly available: boolean
}

/** Direct response from a Computer frame request. */
export interface ComputerFrame {
  readonly jpeg: string
  readonly width: number
  readonly height: number
  readonly mode: ComputerMode
  readonly botActive: boolean
}

/** Bounded human input accepted by the Computer input route. */
export type ComputerInputAction =
  | { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button: 1 | 2 | 3 }
  | { readonly kind: 'drag'; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
  | { readonly kind: 'scroll'; readonly x: number; readonly y: number; readonly delta: number }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'text'; readonly text: string }

/** Lease mode returned after a control or input request. */
export interface ComputerControlResult {
  readonly mode: ComputerMode
}

/** HTTP failure returned by a Computer endpoint. */
export class ComputerApiError extends Error {
  /** HTTP status returned by the failed Computer route. */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ComputerApiError'
    this.status = status
  }
}

/** Authenticated browser client for the Computer routes. */
export interface ComputerClient {
  /** Read whether the Host exposes a Computer provider. */
  status(signal?: AbortSignal): Promise<ComputerStatus>
  /** Read one current screenshot and lease mode. */
  frame(viewerId: string, signal?: AbortSignal): Promise<ComputerFrame>
  /** Ask the Host for the human control lease. */
  takeControl(viewerId: string, signal?: AbortSignal): Promise<ComputerControlResult>
  /** Return the human control lease to the Host. */
  releaseControl(viewerId: string, options?: { readonly keepalive?: boolean }): Promise<ComputerControlResult>
  /** Send one bounded human input action while holding the lease. */
  input(viewerId: string, action: ComputerInputAction, signal?: AbortSignal): Promise<ComputerControlResult>
}

const STATUS_PATH = 'api/computer/status'
const FRAME_PATH = 'api/computer/frame'
const TAKE_CONTROL_PATH = 'api/computer/take-control'
const RELEASE_CONTROL_PATH = 'api/computer/release-control'
const INPUT_PATH = 'api/computer/input'

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function modeOf(value: unknown): ComputerMode | undefined {
  return value === 'watching' || value === 'controlling' || value === 'other' ? value : undefined
}

function statusOf(value: unknown): ComputerStatus | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined
  return { available: value.available }
}

function frameOf(value: unknown): ComputerFrame | undefined {
  if (!isRecord(value) || typeof value.jpeg !== 'string' || typeof value.width !== 'number'
    || !Number.isFinite(value.width) || value.width <= 0 || typeof value.height !== 'number'
    || !Number.isFinite(value.height) || value.height <= 0 || typeof value.botActive !== 'boolean') return undefined
  const mode = modeOf(value.mode)
  if (mode === undefined) return undefined
  return { jpeg: value.jpeg, width: value.width, height: value.height, mode, botActive: value.botActive }
}

function controlOf(value: unknown): ComputerControlResult | undefined {
  if (!isRecord(value)) return undefined
  const mode = modeOf(value.mode)
  return mode === undefined ? undefined : { mode }
}

async function post<T>(
  path: string,
  payload: unknown,
  parse: (value: unknown) => T | undefined,
  options: { readonly signal?: AbortSignal; readonly keepalive?: boolean } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
  })
  if (!response.ok) {
    throw new ComputerApiError(response.status, `Computer request failed (${response.status})`)
  }
  let value: unknown
  try {
    value = await response.json()
  } catch (error: unknown) {
    // A non-JSON success body cannot satisfy the endpoint's direct JSON contract.
    void error
    throw new ComputerApiError(response.status, 'Computer returned an invalid response')
  }
  const parsed = parse(value)
  if (parsed === undefined) throw new ComputerApiError(response.status, 'Computer returned an invalid response')
  return parsed
}

/**
 * Create the default fetch-backed Computer client.
 *
 * @returns a client that uses relative authenticated Computer routes
 */
export function createComputerClient(): ComputerClient {
  return {
    status: signal => post(STATUS_PATH, {}, statusOf, requestOptions(signal)),
    frame: (viewerId, signal) => post(FRAME_PATH, { viewerId }, frameOf, requestOptions(signal)),
    takeControl: (viewerId, signal) => post(TAKE_CONTROL_PATH, { viewerId }, controlOf, requestOptions(signal)),
    releaseControl: (viewerId, options) => post(RELEASE_CONTROL_PATH, { viewerId }, controlOf, options),
    input: (viewerId, action, signal) => post(INPUT_PATH, { viewerId, action }, controlOf, requestOptions(signal)),
  }
}
