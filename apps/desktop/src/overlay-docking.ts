/**
 * Quick-overlay docking: keep a floating window glued inside the visible
 * work area as its content grows, and remember its per-monitor position
 * across launches (clean-room behavior spec: Claude Desktop "skooch").
 *
 * Behavior contract (mirrors the observed reference):
 * - `requestSkooch(contentWidth, contentHeight)`: resolve the nearest
 *   display; if the window's bottom/right edge would overflow the work
 *   area, move it so it ends exactly `margin` inside (growing upward and
 *   leftward); if nothing would change, do not move.
 * - Position memory: on hide, persist absolute point + monitor identity +
 *   monitor-relative offset. On show: exact monitor match restores the
 *   offset; same-label monitor restores proportionally; otherwise the
 *   primary display proportionally; otherwise centered. Multi-monitor
 *   changes never strand the window off-screen.
 * - Renderer debounces content-resize reports (750ms in the reference);
 *   blur with empty content is a no-op dismiss (handled by the caller).
 *
 * All Electron access flows through structural faces so this module is
 * unit-testable without Electron (`import type` only, never a value).
 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

/** Work-area rectangle in physical pixels. */
export interface WorkArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Monitor identity used for position-memory matching. */
export interface MonitorIdentity {
  /** Stable OS label when available; empty string when not. */
  readonly label: string
  /** Full display bounds (size used for exact matching). */
  readonly width: number
  readonly height: number
  /** Work area at capture time. */
  readonly workArea: WorkArea
}

/** Persisted overlay position (JSON-serializable). */
export interface PersistedOverlayPosition {
  readonly absolutePointInWorkspace: { readonly x: number; readonly y: number }
  readonly monitor: MonitorIdentity
  readonly relativePointFromMonitor: { readonly x: number; readonly y: number }
}

/** Minimal display face (satisfied by Electron.Display). */
export interface SkoochDisplay {
  readonly workArea: WorkArea
  readonly bounds: { readonly width: number; readonly height: number }
  readonly label?: string
}

/** Minimal screen face (satisfied by Electron.Screen). */
export interface SkoochScreen {
  getDisplayNearestPoint(point: { x: number; y: number }): SkoochDisplay
  getPrimaryDisplay(): SkoochDisplay
  getAllDisplays(): SkoochDisplay[]
}

/** Minimal window face (satisfied by Electron.BrowserWindow). */
export interface SkoochWindow {
  getPosition(): [number, number]
  setPosition(x: number, y: number): void
  isDestroyed(): boolean
}

/** Persisted-position store (file, settings, or memory in tests). */
export interface OverlayPositionStore {
  load(): PersistedOverlayPosition | null
  save(position: PersistedOverlayPosition): void
}

/** Debug sink; defaults to silent so production stays quiet. */
export type SkoochLog = (message: string, ...args: readonly unknown[]) => void

/** Default margin kept inside the work area, in physical pixels. */
export const SKOOCH_MARGIN_PX = 8

/**
 * Content size reported by the renderer after layout settles.
 * Width/height are the scroll dimensions of the overlay content.
 */
export interface OverlayContentSize {
  readonly contentWidth: number
  readonly contentHeight: number
}

/**
 * Overlay docking controller for one floating window. Owns no Electron
 * singletons: pass the window, screen, store, and margin at construction.
 */
export class OverlayDocking {
  private readonly log: SkoochLog

  /**
   * @param window - the floating overlay window.
   * @param screen - Electron screen (or a test fake).
   * @param store - position-memory store.
   * @param margin - minimum gap kept inside the work area.
   * @param log - debug sink (silent by default).
   */
  constructor(
    private readonly window: SkoochWindow,
    private readonly screen: SkoochScreen,
    private readonly store: OverlayPositionStore,
    private readonly margin: number = SKOOCH_MARGIN_PX,
    log?: SkoochLog,
  ) {
    this.log = log ?? (() => {})
  }

  /**
   * Keep the window inside the work area for the given content size.
   * @returns 'moved' when the window was repositioned, 'noop' otherwise.
   */
  requestSkooch(content: OverlayContentSize): 'moved' | 'noop' {
    if (this.window.isDestroyed()) return 'noop'
    if (!Number.isFinite(content.contentWidth) || !Number.isFinite(content.contentHeight)) return 'noop'
    const [x, y] = this.window.getPosition()
    const display = this.screen.getDisplayNearestPoint({ x, y })
    const area = display.workArea
    this.log('Skooch requested: %d x %d at %d, %d', content.contentWidth, content.contentHeight, x, y)

    const bottom = area.y + area.height
    let nextY = bottom - content.contentHeight - this.margin
    if (y + content.contentHeight <= bottom) nextY = y

    const right = area.x + area.width
    let nextX = right - content.contentWidth - this.margin
    if (x + content.contentWidth <= right) nextX = x

    if (nextX === x && nextY === y) {
      this.log('No skooch needed')
      return 'noop'
    }
    this.log('Skooching to %d, %d', nextX, nextY)
    this.window.setPosition(Math.round(nextX), Math.round(nextY))
    return 'moved'
  }

  /** Persist the current position for the next launch. Call on hide. */
  persist(): void {
    if (this.window.isDestroyed()) return
    try {
      const [x, y] = this.window.getPosition()
      const nearest = this.screen.getDisplayNearestPoint({ x, y })
      this.store.save({
        absolutePointInWorkspace: { x, y },
        monitor: identityOf(nearest),
        relativePointFromMonitor: {
          x: x - nearest.workArea.x,
          y: y - nearest.workArea.y,
        },
      })
    } catch (error) {
      this.log('Failed to persist overlay position: %o', { error })
    }
  }

  /**
   * Resolve the show position: exact monitor match, same-label
   * proportional, primary proportional, else centered on primary.
   */
  restore(): { x: number; y: number } {
    const saved = this.store.load()
    const displays = this.screen.getAllDisplays()
    if (saved === null || displays.length === 0) return this.center()
    const exact = displays.find(candidate =>
      candidate.label === saved.monitor.label
      && candidate.bounds.width === saved.monitor.width
      && candidate.bounds.height === saved.monitor.height)
    if (exact !== undefined) {
      return {
        x: exact.workArea.x + saved.relativePointFromMonitor.x,
        y: exact.workArea.y + saved.relativePointFromMonitor.y,
      }
    }
    const sameLabel = displays.find(candidate => candidate.label === saved.monitor.label)
    const anchor = sameLabel ?? this.screen.getPrimaryDisplay()
    return {
      x: anchor.workArea.x + (saved.relativePointFromMonitor.x / saved.monitor.workArea.width) * anchor.workArea.width,
      y: anchor.workArea.y + (saved.relativePointFromMonitor.y / saved.monitor.workArea.height) * anchor.workArea.height,
    }
  }

  /** Fallback show position: centered on the primary display. */
  center(): { x: number; y: number } {
    const primary = this.screen.getPrimaryDisplay()
    return {
      x: primary.workArea.x + primary.workArea.width / 2,
      y: primary.workArea.y + primary.workArea.height / 2,
    }
  }
}

/** Build the monitor identity snapshot for persistence. */
function identityOf(display: SkoochDisplay): MonitorIdentity {
  return {
    label: display.label ?? '',
    width: display.bounds.width,
    height: display.bounds.height,
    workArea: { ...display.workArea },
  }
}

/** Main-side IPC channel for renderer resize reports. */
export const OVERLAY_SKOOCH_CHANNEL = 'dsh-overlay:skooch'

/**
 * Handle renderer content-size reports with the same ownership checks as
 * the welcome window: exact window webContents plus the main frame.
 * @param ipc - Electron ipcMain.
 * @param window - the overlay window owning this channel.
 * @param docking - the overlay's docking controller.
 */
export function registerOverlayDockingIpc(
  ipc: IpcMain,
  window: SkoochWindow & { readonly webContents: WebContents },
  docking: OverlayDocking,
): () => void {
  const listener = (event: IpcMainInvokeEvent, content: OverlayContentSize): 'moved' | 'noop' => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop overlay: rejected skooch from an unowned frame')
    }
    return docking.requestSkooch(content)
  }
  ipc.handle(OVERLAY_SKOOCH_CHANNEL, listener)
  return () => { ipc.removeHandler(OVERLAY_SKOOCH_CHANNEL) }
}
