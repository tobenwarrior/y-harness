/**
 * Private Linux X-display controller for the Web Computer panel.
 *
 * The controller owns one fixed 1280×800 display. Native commands receive a
 * credential-scrubbed environment and are always started with argv, never a
 * shell. Browser input and model input share one admission queue; an expiring
 * viewer lease excludes model input and observation during human control.
 * @module @yharness/web-app/computer
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { scrubbedParentEnv } from '@yharness/subprocess'
import { brandString, type Branded } from '@yharness/brand'

/** Fixed width exposed by the first private Computer panel. */
export const COMPUTER_WIDTH = 1280
/** Fixed height exposed by the first private Computer panel. */
export const COMPUTER_HEIGHT = 800

const LEASE_DURATION_MS = 8_000
const SIGN_IN_DURATION_MS = 10 * 60_000
const COMMAND_TIMEOUT_MS = 2_000
const MAX_TEXT_BYTES = 8_192
const XDOTOOL_TEXT_INTERVAL_MS = 12
const XDOTOOL_TEXT_SETTLE_MS = 350
const MAX_KEY_LENGTH = 64
const VIEWER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Mode reported to browser viewers and control operations. */
export type ComputerMode = 'watching' | 'controlling' | 'other'

/** The JSON result shared by operations that change or release human control. */
export interface ComputerControlResult {
  readonly mode: ComputerMode
}

/** One bounded pointer, keyboard, or text operation admitted by the Host. */
export type ComputerAction =
  | { readonly kind: 'click'; readonly x: number; readonly y: number; readonly button: 1 | 2 | 3 }
  | { readonly kind: 'drag'; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
  | { readonly kind: 'scroll'; readonly x: number; readonly y: number; readonly delta: number }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'move'; readonly x: number; readonly y: number }

interface ComputerImage {
  readonly jpeg: string
  readonly width: typeof COMPUTER_WIDTH
  readonly height: typeof COMPUTER_HEIGHT
}

/** Frame returned by the Host. `jpeg` is base64 encoded JPEG data. */
export interface ComputerFrame extends ComputerImage {
  readonly mode: ComputerMode
  readonly botActive: boolean
  /** An outstanding sign-in handoff. Viewers without its lease receive no JPEG. */
  readonly signIn?: ComputerSignInId
}

/** Opaque identifier for one private Computer handoff. */
export type ComputerSignInId = Branded<'ComputerSignInId'>

/** Metadata for a live owner request. */
export interface ComputerSignInRequest {
  readonly id: ComputerSignInId
  readonly canCancel: boolean
}

/** Owner actions on an exact sign-in request. */
export type ComputerSignInAction = 'take' | 'complete' | 'cancel'

/** The only outcomes returned to the model. */
export type ComputerSignInResult = 'completed' | 'cancelled' | 'interrupted'

interface SignIn {
  readonly id: ComputerSignInId
  taken: boolean
  settle(result: ComputerSignInResult): void
}

/** Private opt-in X11 settings supplied by the composition owner. */
export interface ComputerConfig {
  readonly display: string
  readonly authorityPath: string
}

/**
 * Native argv runner used by the Host; implementations must not invoke a shell.
 * @param command - Executable name resolved by the host environment.
 * @param args - Positional argv, never a shell command string.
 * @param env - Credential-scrubbed child environment.
 * @param signal - Cancellation and command deadline signal.
 * @param stdin - Optional text sent through a pipe, outside process arguments.
 * @returns When the command exits successfully.
 */
export type ComputerCommandRunner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
  stdin?: string,
) => Promise<void>

/**
 * Capture one JPEG from an execution environment that owns its display.
 *
 * The returned bytes must come from that environment's stdout or equivalent
 * byte channel. The Host never supplies a shared filesystem path for this
 * operation.
 * @param signal - Cancellation and command deadline signal.
 * @returns JPEG bytes captured inside the execution environment.
 */
export type ComputerCaptureRunner = (signal: AbortSignal) => Promise<Buffer>

/** Deterministic seams for tests; production uses the local clock and child process runner. */
export interface ComputerInternals {
  readonly now?: () => number
  readonly run?: ComputerCommandRunner
  /** Optional in-environment screenshot capture used by container-backed Hosts. */
  readonly capture?: ComputerCaptureRunner
  /** An isolated browser receives normalized input after Computer lease admission. */
  readonly input?: (action: ComputerAction, signal: AbortSignal) => Promise<void>
}

/** Stable error codes for route and tool owners that need to classify failures. */
export type ComputerErrorCode =
  | 'invalid-config'
  | 'invalid-viewer'
  | 'invalid-action'
  | 'lease'
  | 'disposed'
  | 'command-failed'
  | 'command-timeout'
  | 'aborted'
  | 'capture-failed'

/** Error raised by the private Computer Host without exposing host diagnostics. */
export class ComputerError extends Error {
  /**
   * @param message - Safe diagnostic for an in-process caller.
   * @param code - Stable error category.
   */
  constructor(message: string, readonly code: ComputerErrorCode) {
    super(message)
    this.name = 'ComputerError'
  }
}

/** Invalid X11 action or action field. */
export class ComputerInputError extends ComputerError {
  /** @param message - Safe validation diagnostic. */
  constructor(message = 'invalid computer action') {
    super(message, 'invalid-action')
    this.name = 'ComputerInputError'
  }
}

/** Invalid or unavailable human lease. */
export class ComputerLeaseError extends ComputerError {
  /** @param message - Safe lease diagnostic. */
  constructor(message = 'computer control is unavailable') {
    super(message, 'lease')
    this.name = 'ComputerLeaseError'
  }
}

/** Record guard for hostile JSON supplied by the browser or a model tool. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidConfig(message: string): never {
  throw new ComputerError(message, 'invalid-config')
}

function validateConfig(config: ComputerConfig): ComputerConfig {
  if (typeof config.display !== 'string' || config.display.length === 0 || /[\u0000-\u001f\u007f]/u.test(config.display)) {
    invalidConfig('invalid computer display')
  }
  if (typeof config.authorityPath !== 'string' || !isAbsolute(config.authorityPath) || /[\u0000-\u001f\u007f]/u.test(config.authorityPath)) {
    invalidConfig('invalid computer authority path')
  }
  return config
}

function invalidViewer(): never {
  throw new ComputerLeaseError('invalid computer viewer')
}

function validateViewer(value: string): string {
  if (!VIEWER_ID_PATTERN.test(value)) invalidViewer()
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ComputerInputError('invalid computer coordinate')
  }
  return value
}

function coordinate(value: unknown): number {
  return boundedInteger(value, 0, COMPUTER_WIDTH - 1)
}

function verticalCoordinate(value: unknown): number {
  return boundedInteger(value, 0, COMPUTER_HEIGHT - 1)
}

const MODIFIERS = new Set(['alt', 'altgr', 'ctrl', 'hyper', 'meta', 'shift', 'super'])
const KEY_NAMES = new Set([
  'BackSpace', 'Tab', 'Return', 'Escape', 'space', 'Left', 'Right', 'Up', 'Down', 'Home', 'End',
  'Page_Up', 'Page_Down', 'Insert', 'Delete', 'Caps_Lock', 'Num_Lock', 'Scroll_Lock', 'Print', 'Pause', 'Menu',
  'minus', 'equal', 'bracketleft', 'bracketright', 'backslash', 'semicolon', 'apostrophe', 'grave', 'comma',
  'period', 'slash',
  'plus', 'quotedbl', 'braceleft', 'braceright',
  ...Array.from({ length: 12 }, (_, index) => `F${String(index + 1)}`),
])
const KEY_CHARACTERS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_!@#$%^&*()-=[]\\;\',./?:<>|~`'.split(''))
const SYMBOL_KEYSYMS: Readonly<Record<string, string>> = {
  _: 'underscore', '!': 'exclam', '@': 'at', '#': 'numbersign', '$': 'dollar', '%': 'percent',
  '^': 'asciicircum', '&': 'ampersand', '*': 'asterisk', '(': 'parenleft', ')': 'parenright',
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '?': 'question',
  ':': 'colon', '<': 'less', '>': 'greater', '|': 'bar', '~': 'asciitilde', '`': 'grave',
}

function validKey(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) {
    throw new ComputerInputError('invalid computer key')
  }
  const parts = value.split('+')
  const final = parts.at(-1)
  if (final === undefined || final.length === 0 || parts.slice(0, -1).some(part => !MODIFIERS.has(part.toLowerCase()))) {
    throw new ComputerInputError('invalid computer key')
  }
  if (final.length !== 1 && !KEY_NAMES.has(final)) throw new ComputerInputError('invalid computer key')
  if (final.length === 1 && !KEY_CHARACTERS.has(final)) throw new ComputerInputError('invalid computer key')
  return [...parts.slice(0, -1).map(part => part.toLowerCase()), final].join('+')
}

/**
 * Validate and normalize an untrusted browser/tool action.
 * @param value - JSON value from the browser or model tool.
 * @returns A bounded action safe to translate to xdotool argv.
 */
export function validateComputerAction(value: unknown): ComputerAction {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new ComputerInputError()
  switch (value.kind) {
    case 'move':
      return { kind: 'move', x: coordinate(value.x), y: verticalCoordinate(value.y) }
    case 'click': {
      const button = boundedInteger(value.button, 1, 3)
      return { kind: 'click', x: coordinate(value.x), y: verticalCoordinate(value.y), button: button as 1 | 2 | 3 }
    }
    case 'drag':
      return {
        kind: 'drag',
        x: coordinate(value.x),
        y: verticalCoordinate(value.y),
        toX: coordinate(value.toX),
        toY: verticalCoordinate(value.toY),
      }
    case 'scroll':
      return {
        kind: 'scroll',
        x: coordinate(value.x),
        y: verticalCoordinate(value.y),
        delta: boundedInteger(value.delta, -10, 10),
      }
    case 'key':
      return { kind: 'key', key: validKey(value.key) }
    case 'text': {
      if (typeof value.text !== 'string' || value.text.includes('\u0000') || Buffer.byteLength(value.text, 'utf8') > MAX_TEXT_BYTES) {
        throw new ComputerInputError('invalid computer text')
      }
      return { kind: 'text', text: value.text }
    }
    default:
      throw new ComputerInputError()
  }
}

function abortError(): ComputerError {
  return new ComputerError('computer operation aborted', 'aborted')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/** Start one no-shell command with a private deadline and no captured output. */
const runNativeCommand: ComputerCommandRunner = (command, args, env, signal, stdin) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(abortError())
    return
  }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...args], { env: { ...env }, shell: false, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'] })
  } catch (error) {
    void error
    reject(new ComputerError('computer command failed', 'command-failed'))
    return
  }
  let timedOut = false
  let aborted = false
  let settled = false
  const timeout = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGKILL') } catch (error) { void error }
  }, COMMAND_TIMEOUT_MS)
  timeout.unref()
  const onAbort = (): void => {
    aborted = true
    try { child.kill('SIGKILL') } catch (error) { void error }
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const settle = (error?: ComputerError): void => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    if (error === undefined) resolve()
    else reject(error)
  }
  child.once('error', () => {
    settle(new ComputerError('computer command failed', 'command-failed'))
  })
  child.once('close', (code) => {
    if (timedOut) settle(new ComputerError('computer command timed out', 'command-timeout'))
    else if (aborted || signal.aborted) settle(abortError())
    else if (code === 0) settle()
    else settle(new ComputerError('computer command failed', 'command-failed'))
  })
  if (stdin !== undefined) {
    child.stdin?.on('error', (error) => { void error })
    child.stdin?.end(stdin)
  }
})

/** The Host-side controller shared by the private browser panel and model tool. */
export class VpsComputer {
  private readonly config: ComputerConfig
  private readonly now: () => number
  private readonly run: ComputerCommandRunner
  private readonly captureRunner: ComputerCaptureRunner | undefined
  private readonly inputRunner: ComputerInternals['input']
  private queue: Promise<void> = Promise.resolve()
  private readonly captures = new Set<Promise<void>>()
  private owner: string | undefined
  private leaseExpiry = 0
  private signIn: SignIn | undefined
  private signInRevision = 0
  private pendingBotActions = 0
  private disposed = false
  private disposePromise: Promise<void> | undefined

  /**
   * @param config - private X display and authority-file settings.
   * @param internals - optional test seams for time and native argv execution.
   */
  constructor(config: ComputerConfig, internals: ComputerInternals = {}) {
    this.config = validateConfig(config)
    this.now = internals.now ?? Date.now
    this.run = internals.run ?? runNativeCommand
    this.captureRunner = internals.capture
    this.inputRunner = internals.input
  }

  /**
   * Return whether this configured private display is currently available.
   * @returns Availability of the live Host.
   */
  status(): { readonly available: boolean } {
    return { available: !this.disposed }
  }

  /**
   * Read owner-visible sign-in metadata without starting or extending the request.
   * @returns The current request, if any.
   */
  signInRequest(): ComputerSignInRequest | undefined {
    return this.signIn === undefined ? undefined : { id: this.signIn.id, canCancel: !this.signIn.taken }
  }

  /**
   * Suspend Computer access until the owner hands it back or the turn stops.
   * A Computer already used for sign-in stays private until the owner returns it.
   * @param signal - Cancellation of the Bot's waiting turn.
   * @returns The owner's answer, or interruption when the wait ends.
   */
  async requestSignIn(signal: AbortSignal): Promise<ComputerSignInResult> {
    const answer = Promise.withResolvers<ComputerSignInResult>()
    await this.admit(() => {
      if (this.signIn !== undefined) throw new ComputerLeaseError('a Computer sign-in is already open')
      const interrupt = (): void => {
        void this.admit(() => {
          if (this.signIn !== request) return
          if (!request.taken) this.clearSignIn()
          request.settle('interrupted')
        }).catch((error: unknown) => { void error })
      }
      const timer = setTimeout(interrupt, SIGN_IN_DURATION_MS)
      timer.unref()
      const request: SignIn = {
        id: brandString<ComputerSignInId>(randomUUID()),
        taken: false,
        settle(result) {
          signal.removeEventListener('abort', interrupt)
          clearTimeout(timer)
          answer.resolve(result)
        },
      }
      this.signIn = request
      this.signInRevision++
      signal.addEventListener('abort', interrupt, { once: true })
    }, signal)
    return answer.promise
  }

  /**
   * Change an exact sign-in request from the authenticated owner interface.
   * @param requestId - ID read from the current Bot's request.
   * @param action - Take control, finish sign-in, or decline the request.
   * @param viewerId - Viewer claiming or returning its lease. Required to cancel a claimed request.
   * @param signal - Optional cancellation before the action is admitted.
   * @returns The viewer mode after the action.
   */
  answerSignIn(requestId: string, action: ComputerSignInAction, viewerId?: string, signal?: AbortSignal): Promise<ComputerControlResult> {
    const id = viewerId === undefined ? undefined : validateViewer(viewerId)
    return this.admit(() => {
      const request = this.signIn
      if (request?.id !== requestId) throw new ComputerLeaseError('Computer sign-in request has ended')
      this.expireLease()
      if (action === 'take') {
        if (id === undefined) invalidViewer()
        this.grantControl(id)
        request.taken = true
        return { mode: 'controlling' }
      }
      if (request.taken ? id === undefined || this.owner !== id : action === 'complete') {
        throw new ComputerLeaseError('viewer does not hold the sign-in lease')
      }
      if (request.taken) this.clearLease()
      this.clearSignIn()
      request.settle(action === 'complete' ? 'completed' : 'cancelled')
      return { mode: this.modeFor(id) }
    }, signal)
  }

  /**
   * Capture a browser frame and renew the caller's lease when it owns control.
   * @param viewerId - UUID identifying the browser viewer.
   * @param signal - Optional request cancellation.
   * @returns Base64 JPEG and current viewer mode.
   */
  async frame(viewerId: string, signal?: AbortSignal): Promise<ComputerFrame> {
    const id = validateViewer(viewerId)
    this.assertOpen()
    throwIfAborted(signal)
    this.expireLease()
    const revision = this.signInRevision
    if (this.signIn !== undefined && (this.owner !== id || !this.signIn.taken)) return this.browserFrame(id)
    if (this.owner === id) this.leaseExpiry = this.now() + LEASE_DURATION_MS
    const image = await this.capture(signal)
    this.expireLease()
    return this.browserFrame(id, this.signInRevision !== revision || (this.signIn !== undefined && this.owner !== id)
      ? undefined : image)
  }

  /**
   * Capture a model/tool frame when no viewer controls the display.
   * @param signal - Optional request cancellation.
   * @returns Base64 JPEG with the non-viewer mode.
   */
  observe(signal?: AbortSignal): Promise<ComputerFrame> {
    return this.admit(async () => {
      this.expireLease()
      this.assertBotControl()
      const image = await this.capture(signal)
      return { ...image, mode: 'other', botActive: this.pendingBotActions > 0 }
    }, signal)
  }

  /**
   * Admit one viewer as controller after all admitted input and model frames settle.
   * @param viewerId - UUID identifying the browser viewer.
   * @param signal - Optional request cancellation while waiting for admission.
   * @returns The controlling mode.
   */
  async takeControl(viewerId: string, signal?: AbortSignal): Promise<ComputerControlResult> {
    const id = validateViewer(viewerId)
    return this.admit(() => {
      this.expireLease()
      if (this.signIn !== undefined) throw new ComputerLeaseError('use the Computer sign-in request to take control')
      this.grantControl(id)
      return { mode: 'controlling' as const }
    }, signal)
  }

  /**
   * Release only the caller's lease; an old viewer cannot revoke a new owner.
   * @param viewerId - UUID identifying the browser viewer.
   * @param signal - Optional request cancellation while waiting for admission.
   * @returns The caller's resulting mode.
   */
  async releaseControl(viewerId: string, signal?: AbortSignal): Promise<ComputerControlResult> {
    const id = validateViewer(viewerId)
    return this.admit(() => {
      this.expireLease()
      if (this.owner === id) this.clearLease()
      return { mode: this.modeFor(id) }
    }, signal)
  }

  /**
   * Admit one human action, requiring and renewing that viewer's lease.
   * @param viewerId - UUID identifying the browser viewer.
   * @param action - Untrusted action value to validate before admission.
   * @param signal - Optional request cancellation.
   * @returns The continuing controlling mode.
   */
  async input(viewerId: string, action: unknown, signal?: AbortSignal): Promise<ComputerControlResult> {
    const id = validateViewer(viewerId)
    const normalized = validateComputerAction(action)
    return this.admit(async () => {
      this.expireLease()
      if (this.owner !== id) throw new ComputerLeaseError('viewer does not hold computer control')
      if (this.signIn !== undefined && !this.signIn.taken) throw new ComputerLeaseError('accept the Computer sign-in request first')
      this.leaseExpiry = this.now() + LEASE_DURATION_MS
      await this.execute(normalized, signal, this.signIn !== undefined)
      return { mode: 'controlling' as const }
    }, signal)
  }

  /**
   * Admit one model/bot action unless a human lease owns the display.
   * @param action - Untrusted action value to validate before admission.
   * @param signal - Optional request cancellation.
   * @returns When the action has settled.
   */
  async actAsBot(action: unknown, signal?: AbortSignal): Promise<void> {
    const normalized = validateComputerAction(action)
    return this.runWhileBotControls(() => this.execute(normalized, signal), signal)
  }

  /**
   * Admit a website navigation through the Bot's isolated browser provider.
   * @param url - Website to validate and visit at the provider.
   * @param signal - Cancellation before admission and during provider work.
   * @param navigate - The already selected provider for this Bot's browser.
   * @returns When the provider has accepted the navigation.
   */
  navigateAsBot(url: string, signal: AbortSignal, navigate: (url: string, signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.runWhileBotControls(() => navigate(url, signal), signal)
  }

  /**
   * Navigate the viewer's isolated browser while that viewer holds control.
   * @param viewerId - Current viewer lease identifier.
   * @param url - Validated website URL.
   * @param signal - Request cancellation.
   * @param navigate - Provider for this Computer's browser.
   * @returns The viewer mode after navigation.
   */
  navigateAsViewer(viewerId: string, url: string, signal: AbortSignal,
    navigate: (url: string, signal: AbortSignal) => Promise<void>): Promise<ComputerControlResult> {
    const id = validateViewer(viewerId)
    return this.admit(async () => {
      this.expireLease()
      if (this.owner !== id || this.signIn !== undefined) throw new ComputerLeaseError('viewer does not hold browser control')
      await navigate(url, signal)
      this.leaseExpiry = this.now() + LEASE_DURATION_MS
      return { mode: 'controlling' }
    }, signal)
  }

  /**
   * Admit a Bot operation while the owner has no active Computer lease.
   * @param work - Provider operation that settles before the next input is admitted.
   * @param signal - Cancellation while waiting for admission.
   * @returns The operation's result.
   */
  runWhileBotControls<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pendingBotActions += 1
    const result = this.admit(() => {
      this.expireLease()
      this.assertBotControl()
      return work()
    }, signal)
    return result.finally(() => { this.pendingBotActions -= 1 })
  }

  /**
   * Alias retained for Host callers that name the model path `botAction`.
   * @param action - Untrusted action value to validate before admission.
   * @param signal - Optional request cancellation.
   * @returns When the action has settled.
   */
  botAction(action: unknown, signal?: AbortSignal): Promise<void> {
    return this.actAsBot(action, signal)
  }

  /**
   * Stop admissions and await all queued actions and in-flight captures.
   * @returns When all Host-owned work has quiesced.
   */
  async dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.clearLease()
    this.signIn?.settle('interrupted')
    this.clearSignIn()
    this.disposePromise = (async () => {
      await this.queue
      await Promise.all([...this.captures])
    })()
    return this.disposePromise
  }

  private assertOpen(): void {
    if (this.disposed) throw new ComputerError('computer is disposed', 'disposed')
  }

  private expireLease(): void {
    if (this.owner !== undefined && this.now() >= this.leaseExpiry) this.clearLease()
  }

  private clearLease(): void {
    this.owner = undefined
    this.leaseExpiry = 0
  }

  private clearSignIn(): void {
    this.signIn = undefined
    this.signInRevision++
  }

  private grantControl(id: string): void {
    if (this.owner !== undefined && this.owner !== id) throw new ComputerLeaseError('computer is controlled by another viewer')
    this.owner = id
    this.leaseExpiry = this.now() + LEASE_DURATION_MS
  }

  private assertBotControl(): void {
    if (this.signIn !== undefined || this.owner !== undefined) throw new ComputerLeaseError('computer is controlled by a human')
  }

  private browserFrame(id: string, image?: ComputerImage): ComputerFrame {
    return {
      ...(image ?? { jpeg: '', width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }),
      mode: this.signIn !== undefined && (this.owner !== id || !this.signIn.taken) ? 'other' : this.modeFor(id),
      botActive: this.pendingBotActions > 0,
      ...(this.signIn === undefined ? {} : { signIn: this.signIn.id }),
    }
  }

  private modeFor(viewerId: string | undefined): ComputerMode {
    if (this.owner === undefined) return 'watching'
    return this.owner === viewerId ? 'controlling' : 'other'
  }

  private admit<T>(work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const run = this.queue.then(() => {
      this.assertOpen()
      throwIfAborted(signal)
      return work()
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async execute(action: ComputerAction, signal?: AbortSignal, signIn = false): Promise<void> {
    throwIfAborted(signal)
    if (this.inputRunner !== undefined) {
      await this.inputRunner(action, signal ?? new AbortController().signal)
      return
    }
    const env = { ...scrubbedParentEnv(), DISPLAY: this.config.display, XAUTHORITY: this.config.authorityPath }
    const move = async (x: number, y: number): Promise<void> => {
      await this.run('xdotool', ['mousemove', '--sync', String(x), String(y)], env, signal ?? new AbortController().signal)
    }
    switch (action.kind) {
      case 'move':
        await move(action.x, action.y)
        return
      case 'click':
        await move(action.x, action.y)
        await this.run('xdotool', ['click', String(action.button)], env, signal ?? new AbortController().signal)
        return
      case 'drag':
        await move(action.x, action.y)
        let failure: unknown
        try {
          await this.run('xdotool', ['mousedown', '1'], env, signal ?? new AbortController().signal)
          await move(action.toX, action.toY)
        } catch (error: unknown) {
          failure = error
        }
        try {
          // Never leave a pressed button behind when a request aborts during the drag.
          await this.run('xdotool', ['mouseup', '1'], env, new AbortController().signal)
        } catch (error: unknown) {
          if (failure === undefined) failure = error
        }
        if (failure !== undefined) throw failure
        return
      case 'scroll':
        await move(action.x, action.y)
        if (action.delta !== 0) {
          const button = action.delta > 0 ? '5' : '4'
          await this.run('xdotool', ['click', '--repeat', String(Math.abs(action.delta)), button], env, signal ?? new AbortController().signal)
        }
        return
      case 'key':
        if (signIn) {
          // Xdotool's command reader expands `$` and treats quotes as delimiters.
          const keys = action.key.split('+').map(key => SYMBOL_KEYSYMS[key] ?? key).join('+')
          await this.run('xdotool', ['-'], env, signal ?? new AbortController().signal, `key --clearmodifiers ${keys}\n`)
        } else {
          await this.run('xdotool', ['key', '--clearmodifiers', action.key], env, signal ?? new AbortController().signal)
        }
        return
      case 'text': {
        // Firefox needs paced key events. Reserve half the command deadline for X11 and process overhead.
        const interval = Math.min(XDOTOOL_TEXT_INTERVAL_MS, Math.floor(COMMAND_TIMEOUT_MS / (2 * Math.max(1, action.text.length))))
        const args = ['type', '--clearmodifiers', '--delay', String(interval)]
        if (signIn) await this.run('xdotool', [...args, '--file', '-'], env, signal ?? new AbortController().signal, action.text)
        else await this.run('xdotool', [...args, '--', action.text], env, signal ?? new AbortController().signal)
        // X11 can finish queuing text before Firefox applies it to the address bar.
        await delay(XDOTOOL_TEXT_SETTLE_MS, undefined, { signal })
        return
      }
    }
  }

  private capture(signal?: AbortSignal): Promise<ComputerImage> {
    const operation = this.captureNow(signal)
    const settled = operation.then(() => undefined, () => undefined)
    this.captures.add(settled)
    void operation.finally(() => { this.captures.delete(settled) }).catch((error) => { void error })
    return operation
  }

  private async captureNow(signal?: AbortSignal): Promise<ComputerImage> {
    throwIfAborted(signal)
    if (this.captureRunner !== undefined) {
      try {
        const bytes = await this.captureRunner(signal ?? new AbortController().signal)
        if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
          throw new ComputerError('computer frame capture failed', 'capture-failed')
        }
        return { jpeg: bytes.toString('base64'), width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }
      } catch (error) {
        if (error instanceof ComputerError) throw error
        if (signal?.aborted === true) throw abortError()
        throw new ComputerError('computer frame capture failed', 'capture-failed')
      }
    }
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-computer-'))
      await chmod(directory, 0o700)
      const output = join(directory, 'frame.jpg')
      const env = { ...scrubbedParentEnv(), DISPLAY: this.config.display, XAUTHORITY: this.config.authorityPath }
      await this.run('scrot', ['--pointer', '--quality', '85', output], env, signal ?? new AbortController().signal)
      const bytes = await readFile(output)
      if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ComputerError('computer frame capture failed', 'capture-failed')
      return { jpeg: bytes.toString('base64'), width: COMPUTER_WIDTH, height: COMPUTER_HEIGHT }
    } catch (error) {
      if (error instanceof ComputerError) throw error
      throw new ComputerError('computer frame capture failed', 'capture-failed')
    } finally {
      if (directory !== undefined) {
        try { await rm(directory, { recursive: true, force: true }) } catch (error) { void error }
      }
    }
  }
}

/**
 * Create a Computer Host whose display commands execute inside a private
 * container or remote execution environment.
 *
 * `run` receives argv without a shell. Input actions invoke `xdotool` through
 * that callback, while screenshots invoke the image’s capture command so the JPEG stays
 * inside the execution environment until the callback returns its bytes.
 * @param run - Execute one argv vector with optional piped input and return stdout bytes.
 * @returns A Computer Host using the supplied execution environment.
 */
export function containerComputer(
  run: (argv: readonly string[], signal: AbortSignal, stdin?: string) => Promise<Buffer>,
): VpsComputer {
  const execute: ComputerCommandRunner = async (command, args, _env, signal, stdin) => {
    await run([command, ...args], signal, stdin)
  }
  const capture: ComputerCaptureRunner = signal => run(
    ['/usr/local/bin/yharness-vps-bot-capture'], signal,
  )
  return new VpsComputer({ display: ':container', authorityPath: '/dev/null' }, { run: execute, capture })
}

/** Compatibility name for Host-side callers that prefer the generic service term. */
export { VpsComputer as ComputerHost }
