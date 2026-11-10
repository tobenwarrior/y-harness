/** Local Mac screen sharing with one user-approved Bot and an expiring panel lease. */

interface PanelOwner {
  readonly sessionId: string
  readonly viewerId: string
}

interface ScreenSize {
  readonly width: number
  readonly height: number
}

interface Frame extends ScreenSize {
  readonly jpeg: string
}

interface Permissions {
  readonly screenRecording: boolean
  readonly accessibility: boolean
  readonly deviceControlLabel?: boolean
}

type Permission = 'screenRecording' | 'accessibility'
type Point = { readonly x: number; readonly y: number }

type Input =
  | ({ readonly kind: 'move' } & Point)
  | ({ readonly kind: 'click'; readonly button: number } & Point)
  | ({ readonly kind: 'drag'; readonly toX: number; readonly toY: number } & Point)
  | ({ readonly kind: 'scroll'; readonly delta: number } & Point)
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'text'; readonly text: string }

/** Desktop facilities owned by the Electron main process. */
export interface MacDesktop {
  permissions(): Permissions
  openSettings(permission: Permission): Promise<void>
  confirm(sessionId: string, signal: AbortSignal): Promise<boolean>
  capture(): Promise<Frame>
  input(action: Input, screen: ScreenSize): void
}

const LEASE_MS = 8_000
const OBSERVATION_MS = 30_000
const VIEWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SESSION_ID = /^[a-z0-9_-]{1,128}$/iu

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Computer request.')
  return value as Record<string, unknown>
}

function ownerOf(value: Record<string, unknown>): PanelOwner {
  const { sessionId, viewerId } = value
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)
    || typeof viewerId !== 'string' || !VIEWER_ID.test(viewerId)) throw new Error('Invalid Computer viewer.')
  return { sessionId, viewerId }
}

function within(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
    throw new Error('Invalid Computer input.')
  }
  return value
}

function inputOf(value: Record<string, unknown>, { width, height }: ScreenSize): Input {
  switch (value.kind) {
    case 'key':
      if (typeof value.key !== 'string' || !/^[\x20-\x7e]{1,64}$/u.test(value.key)) throw new Error('Invalid Computer key.')
      return { kind: 'key', key: value.key }
    case 'text':
      if (typeof value.text !== 'string' || value.text.includes('\0') || Buffer.byteLength(value.text) > 8192) {
        throw new Error('Invalid Computer text.')
      }
      return { kind: 'text', text: value.text }
    default: {
      const point = { x: within(value.x, 0, width - 1), y: within(value.y, 0, height - 1) }
      switch (value.kind) {
        case 'move': return { kind: 'move', ...point }
        case 'click': return { kind: 'click', ...point, button: within(value.button, 1, 3) }
        case 'drag': return { kind: 'drag', ...point, toX: within(value.toX, 0, width - 1), toY: within(value.toY, 0, height - 1) }
        case 'scroll': return { kind: 'scroll', ...point, delta: within(value.delta, -10, 10) }
        default: throw new Error('Invalid Computer action.')
      }
    }
  }
}

function same(left: PanelOwner | undefined, right: PanelOwner): boolean {
  return left?.sessionId === right.sessionId && left.viewerId === right.viewerId
}

/** Authorize native capture and input only while the approved Mac Bot panel is present. */
export class MacComputer {
  private owner: PanelOwner | undefined
  private pending: { readonly owner: PanelOwner; readonly abort: AbortController } | undefined
  private paused = false
  private expiry = 0
  private observed: (ScreenSize & { readonly at: number }) | undefined
  private botActivityUntil = 0
  private frameRequest: Promise<Frame> | undefined

  /** @param desktop - native operations. @param now - clock for the panel lease. */
  constructor(private readonly desktop: MacDesktop, private readonly now = Date.now) {}

  /** End sharing and invalidate any outstanding native consent prompt. */
  revoke(): void {
    this.owner = undefined
    this.pending?.abort.abort()
    this.pending = undefined
    this.paused = false
    this.observed = undefined
    this.botActivityUntil = 0
    this.frameRequest = undefined
  }

  private expire(): void {
    const { screenRecording, accessibility } = this.desktop.permissions()
    if (this.owner !== undefined && (this.now() >= this.expiry || !screenRecording || !accessibility)) this.revoke()
  }

  private state(panel: PanelOwner) {
    this.expire()
    return { ...this.desktop.permissions(), shared: same(this.owner, panel) }
  }

  private capture(): Promise<Frame> {
    if (this.frameRequest !== undefined) return this.frameRequest
    const request = this.desktop.capture().finally(() => {
      if (this.frameRequest === request) this.frameRequest = undefined
    })
    this.frameRequest = request
    return request
  }

  /**
   * Handle a request from the local application document.
   * @param operation - Mac Computer panel endpoint.
   * @param body - untrusted JSON request.
   * @returns permission state, live frame or human control mode.
   */
  async panel(operation: string, body: unknown): Promise<unknown> {
    const value = record(body)
    const panel = ownerOf(value)
    this.expire()
    switch (operation) {
      case 'setup':
        return this.state(panel)
      case 'settings':
        if (value.permission !== 'screenRecording' && value.permission !== 'accessibility') throw new Error('Invalid Mac permission.')
        await this.desktop.openSettings(value.permission)
        return this.state(panel)
      case 'start': {
        const { screenRecording, accessibility, shared } = this.state(panel)
        if (shared || !screenRecording || !accessibility || this.pending !== undefined) return this.state(panel)
        // Existing Bot input must be disabled before a new approval dialog can appear.
        this.revoke()
        const pending = { owner: panel, abort: new AbortController() }
        this.pending = pending
        try {
          const allowed = await this.desktop.confirm(panel.sessionId, pending.abort.signal)
          const { screenRecording: screenAllowed, accessibility: inputAllowed } = this.desktop.permissions()
          if (allowed && this.pending === pending && screenAllowed && inputAllowed) {
            this.owner = panel
            this.paused = false
            this.observed = undefined
            this.expiry = this.now() + LEASE_MS
          }
        } finally {
          if (this.pending === pending) this.pending = undefined
        }
        return this.state(panel)
      }
      case 'stop':
        if (same(this.pending?.owner, panel)) this.revoke()
        if (same(this.owner, panel)) this.revoke()
        return this.state(panel)
      case 'frame': {
        if (!same(this.owner, panel)) throw new Error('Mac sharing has ended.')
        const owner = this.owner
        this.expiry = this.now() + LEASE_MS
        const frame = await this.capture()
        this.expire()
        if (this.owner !== owner) throw new Error('Mac sharing has ended.')
        return { ...frame, mode: this.paused ? 'controlling' : 'watching', botActive: this.now() < this.botActivityUntil }
      }
      case 'take-control':
      case 'release-control':
        if (!same(this.owner, panel)) throw new Error('Mac sharing has ended.')
        this.paused = operation === 'take-control'
        this.observed = undefined
        return { mode: this.paused ? 'controlling' : 'watching' }
      default:
        throw new Error('Invalid Computer request.')
    }
  }

  /**
   * Observe or operate the desktop for the one approved Bot.
   * @param body - Session identity and action sent by the local Host.
   * @returns a screenshot for observation, otherwise no result data.
   */
  async bot(body: unknown): Promise<Frame | undefined> {
    const value = record(body)
    const action = record(value.action)
    this.expire()
    const owner = this.owner
    if (owner === undefined || owner.sessionId !== value.sessionId) throw new Error('Share your Mac from this Bot’s Computer panel first.')
    if (this.paused) throw new Error('Bot control is paused. Choose Hand back in the Computer panel.')
    if (action.kind === 'observe') {
      const frame = await this.capture()
      this.expire()
      if (this.owner !== owner || this.paused) throw new Error('Mac sharing has ended or paused.')
      this.observed = { width: frame.width, height: frame.height, at: this.now() }
      return frame
    }
    const observed = this.observed
    if (observed === undefined || this.now() - observed.at >= OBSERVATION_MS) throw new Error('Observe the Mac screen before sending input.')
    this.desktop.input(inputOf(action, observed), { width: observed.width, height: observed.height })
    this.botActivityUntil = this.now() + 1000
    return undefined
  }
}
