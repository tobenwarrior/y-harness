/** Browser client for the authenticated Computer side-panel routes. */

export type ComputerMode = 'watching' | 'controlling' | 'other'

/** Execution location reported for a Computer provider. */
export type ComputerLocation = 'mac' | 'vps'

/** Owner scope to which a Computer provider's permissions apply. */
export type ComputerPermissionScope = 'bot' | 'workspace'

/** Non-sensitive identity metadata for the Computer selected by the active Bot. */
export interface ComputerIdentity {
  readonly id?: string
  readonly location: ComputerLocation
  readonly permissionScope: ComputerPermissionScope
  readonly browser?: true
}

/** Direct response from the Computer status route. */
export interface ComputerStatus {
  readonly available: boolean
  readonly kind?: ComputerLocation
  readonly computer?: ComputerIdentity
}

/** Direct response from a Computer frame request. */
export interface ComputerFrame {
  readonly jpeg: string
  readonly width: number
  readonly height: number
  readonly mode: ComputerMode
  readonly botActive: boolean
  /** An active owner sign-in request. Non-controlling viewers receive an empty JPEG. */
  readonly signIn?: string
}

/** Metadata for the owner-only Computer sign-in card. */
export interface ComputerSignInRequest {
  readonly id: string
  readonly canCancel: boolean
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
  /** Read whether the Host exposes a Computer provider.
   * @param signal - Optional cancellation signal.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  status(signal?: AbortSignal, sessionId?: string): Promise<ComputerStatus>
  /** Read one current screenshot and lease mode.
   * @param viewerId - Browser viewer identity.
   * @param signal - Optional cancellation signal.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  frame(viewerId: string, signal?: AbortSignal, sessionId?: string): Promise<ComputerFrame>
  /** Ask the Host for the human control lease.
   * @param viewerId - Browser viewer identity.
   * @param signal - Optional cancellation signal.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  takeControl(viewerId: string, signal?: AbortSignal, sessionId?: string): Promise<ComputerControlResult>
  /** Return the human control lease to the Host.
   * @param viewerId - Browser viewer identity.
   * @param options - Optional keepalive behavior for unmount cleanup.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  releaseControl(viewerId: string, options?: { readonly keepalive?: boolean }, sessionId?: string): Promise<ComputerControlResult>
  /** Send one bounded human input action while holding the lease.
   * @param viewerId - Browser viewer identity.
   * @param action - Validated pointer or keyboard action.
   * @param signal - Optional cancellation signal.
   * @param sessionId - Active Bot Session selecting an isolated Cloud Computer.
   */
  input(viewerId: string, action: ComputerInputAction, signal?: AbortSignal, sessionId?: string): Promise<ComputerControlResult>
  /** Open a URL while the viewer controls the selected isolated browser. */
  readonly navigate?: (viewerId: string, url: string, sessionId: string, signal?: AbortSignal) => Promise<ComputerControlResult>
  /** Read or respond to sign-in requests on a VPS Bot's Computer. */
  readonly signIn?: {
    status(sessionId: string, signal: AbortSignal): Promise<{ readonly request: ComputerSignInRequest | null }>
    take(sessionId: string, requestId: string, viewerId: string): Promise<ComputerControlResult>
    complete(sessionId: string, requestId: string, viewerId: string): Promise<ComputerControlResult>
    cancel(sessionId: string, requestId: string, viewerId?: string): Promise<ComputerControlResult>
  }
}

const STATUS_PATH = 'api/computer/status'
const FRAME_PATH = 'api/computer/frame'
const TAKE_CONTROL_PATH = 'api/computer/take-control'
const RELEASE_CONTROL_PATH = 'api/computer/release-control'
const INPUT_PATH = 'api/computer/input'
const NAVIGATE_PATH = 'api/computer/navigate'
const SIGN_IN_PATH = 'api/computer/sign-in'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function requestOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function identityOf(value: unknown): ComputerIdentity | undefined {
  if (!isRecord(value)) return undefined
  const location = value.location === 'mac' || value.location === 'vps' ? value.location : undefined
  const permissionScope = value.permissionScope === 'bot' || value.permissionScope === 'workspace'
    ? value.permissionScope : undefined
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value.id) ? value.id : undefined
  if (location === undefined || permissionScope === undefined) return undefined
  return { ...(id === undefined ? {} : { id }), location, permissionScope,
    ...(location === 'vps' && permissionScope === 'bot' && value.browser === true ? { browser: true } : {}) }
}

function modeOf(value: unknown): ComputerMode | undefined {
  return value === 'watching' || value === 'controlling' || value === 'other' ? value : undefined
}

function statusOf(value: unknown): ComputerStatus | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined
  const kind = value.kind === 'mac' || value.kind === 'vps' ? value.kind : undefined
  const computer = identityOf(value.computer)
  return {
    available: value.available,
    ...(kind === undefined ? {} : { kind }),
    ...(computer === undefined ? {} : { computer }),
  }
}

function frameOf(value: unknown): ComputerFrame | undefined {
  if (!isRecord(value) || typeof value.jpeg !== 'string' || typeof value.width !== 'number'
    || !Number.isFinite(value.width) || value.width <= 0 || typeof value.height !== 'number'
    || !Number.isFinite(value.height) || value.height <= 0 || typeof value.botActive !== 'boolean') return undefined
  const mode = modeOf(value.mode)
  if (mode === undefined) return undefined
  const signIn = signInId(value.signIn)
  return { jpeg: value.jpeg, width: value.width, height: value.height, mode, botActive: value.botActive,
    ...(signIn === undefined ? {} : { signIn }) }
}

function signInId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined
}

function signInStatusOf(value: unknown): { readonly request: ComputerSignInRequest | null } | undefined {
  if (!isRecord(value)) return undefined
  const request = value.request
  if (request === null) return { request: null }
  if (!isRecord(request) || typeof request.canCancel !== 'boolean') return undefined
  const id = signInId(request.id)
  return id === undefined ? undefined : { request: { id, canCancel: request.canCancel } }
}

function controlOf(value: unknown): ComputerControlResult | undefined {
  if (!isRecord(value)) return undefined
  const mode = modeOf(value.mode)
  return mode === undefined ? undefined : { mode }
}

function withSession(payload: Record<string, unknown>, sessionId: string | undefined): Record<string, unknown> {
  return sessionId === undefined || sessionId === '' ? payload : { ...payload, sessionId }
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
    status: (signal, sessionId) => post(STATUS_PATH, withSession({}, sessionId), statusOf, requestOptions(signal)),
    frame: (viewerId, signal, sessionId) => post(FRAME_PATH, withSession({ viewerId }, sessionId), frameOf, requestOptions(signal)),
    takeControl: (viewerId, signal, sessionId) => post(
      TAKE_CONTROL_PATH, withSession({ viewerId }, sessionId), controlOf, requestOptions(signal),
    ),
    releaseControl: (viewerId, options, sessionId) => post(RELEASE_CONTROL_PATH, withSession({ viewerId }, sessionId), controlOf, options),
    input: (viewerId, action, signal, sessionId) => post(
      INPUT_PATH, withSession({ viewerId, action }, sessionId), controlOf, requestOptions(signal),
    ),
    navigate: (viewerId, url, sessionId, signal) => post(
      NAVIGATE_PATH, { viewerId, url, sessionId }, controlOf, requestOptions(signal),
    ),
    signIn: {
      status: (sessionId, signal) => post(SIGN_IN_PATH, { action: 'status', sessionId }, signInStatusOf, { signal }),
      take: (sessionId, requestId, viewerId) => post(SIGN_IN_PATH, { action: 'take', sessionId, requestId, viewerId }, controlOf),
      complete: (sessionId, requestId, viewerId) => post(SIGN_IN_PATH, { action: 'complete', sessionId, requestId, viewerId }, controlOf),
      cancel: (sessionId, requestId, viewerId) => post(SIGN_IN_PATH, { action: 'cancel', sessionId, requestId, viewerId }, controlOf),
    },
  }
}

/** The macOS grants and the panel's current sharing state. */
export interface MacComputerSetup {
  readonly screenRecording: boolean
  readonly accessibility: boolean
  readonly deviceControlLabel: boolean
  readonly shared: boolean
}

/** Local Mac setup operation. */
export type MacComputerOperation = 'setup' | 'start' | 'stop' | 'settings'

/** Local macOS permission opened in System Settings. */
export type MacComputerPermission = 'screenRecording' | 'accessibility'

function setupOf(value: unknown): MacComputerSetup | undefined {
  if (!isRecord(value) || typeof value.screenRecording !== 'boolean' || typeof value.accessibility !== 'boolean'
    || typeof value.shared !== 'boolean') return undefined
  return { screenRecording: value.screenRecording, accessibility: value.accessibility,
    deviceControlLabel: value.deviceControlLabel === true, shared: value.shared }
}

interface MacComputerClient {
  readonly computer: ComputerClient
  setup(operation: MacComputerOperation, permission?: MacComputerPermission, signal?: AbortSignal): Promise<MacComputerSetup>
}

/**
 * Create the local Computer client for the selected Bot and panel lifetime.
 * @param sessionId - Session of the selected Bot.
 * @param viewerId - Unique identity for this mounted Computer panel.
 * @returns local setup and viewing operations.
 */
export function createMacComputerClient(sessionId: string, viewerId: string): MacComputerClient {
  const owner = { sessionId, viewerId }
  const path = (operation: string): string => 'api/computer/mac/' + operation
  const computer: ComputerClient = {
    status: (signal, _sessionId) => post(STATUS_PATH, {}, statusOf, requestOptions(signal)),
    frame: (_viewerId, signal, _sessionId) => post(path('frame'), owner, frameOf, requestOptions(signal)),
    takeControl: (_viewerId, signal, _sessionId) => post(path('take-control'), owner, controlOf, requestOptions(signal)),
    releaseControl: (_viewerId, options, _sessionId) => post(path('release-control'), owner, controlOf, options),
    input: () => Promise.reject(new Error('Use your Mac keyboard and mouse to control the local display.')),
  }
  return {
    computer,
    setup: (operation: MacComputerOperation, permission?: MacComputerPermission, signal?: AbortSignal) =>
      post(path(operation), { ...owner, permission }, setupOf,
        operation === 'stop' ? { keepalive: true } : requestOptions(signal)),
  }
}
