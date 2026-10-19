/**
 * OverlayDocking: work-area clamping and per-monitor position memory.
 * Electron-free: fake screen, window, and store faces.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain } from 'electron'
import {
  OverlayDocking,
  OVERLAY_SKOOCH_CHANNEL,
  registerOverlayDockingIpc,
  type OverlayPositionStore,
  type PersistedOverlayPosition,
  type SkoochDisplay,
  type SkoochScreen,
  type SkoochWindow,
} from '../src/overlay-docking.ts'

function display(workArea: { x: number; y: number; width: number; height: number }, label = '', size?: { width: number; height: number }): SkoochDisplay {
  return {
    workArea: { ...workArea },
    bounds: { ...(size ?? { width: workArea.width, height: workArea.height }) },
    label,
  }
}

function screenStub(displays: readonly SkoochDisplay[], primary = 0): SkoochScreen & { nearest: SkoochDisplay[] } {
  return {
    nearest: [...displays],
    getDisplayNearestPoint: () => displays[0] as SkoochDisplay,
    getPrimaryDisplay: () => displays[primary] as SkoochDisplay,
    getAllDisplays: () => [...displays],
  }
}

function windowStub(at: readonly [number, number]): SkoochWindow & { moved: Array<readonly [number, number]> } {
  const moved: Array<readonly [number, number]> = []
  let position: readonly [number, number] = at
  return {
    moved,
    getPosition: () => [position[0], position[1]],
    setPosition: (x: number, y: number) => {
      position = [x, y]
      moved.push([x, y] as const)
    },
    isDestroyed: () => false,
  }
}

function memoryStore(initial: PersistedOverlayPosition | null = null): OverlayPositionStore & { saved: PersistedOverlayPosition | null } {
  return {
    saved: initial,
    load: function (this: { saved: PersistedOverlayPosition | null }): PersistedOverlayPosition | null {
      return this.saved
    },
    save: function (this: { saved: PersistedOverlayPosition | null }, position: PersistedOverlayPosition): void {
      this.saved = position
    },
  }
}

const AREA = { x: 0, y: 25, width: 1440, height: 875 }

describe('OverlayDocking.requestSkooch', () => {
  it('leaves a fitting window alone', () => {
    const window = windowStub([100, 100])
    const docking = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    expect(docking.requestSkooch({ contentWidth: 400, contentHeight: 300 })).toBe('noop')
    expect(window.moved).toEqual([])
  })

  it('grows upward when the bottom would overflow', () => {
    const window = windowStub([100, 700])
    const docking = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    expect(docking.requestSkooch({ contentWidth: 400, contentHeight: 300 })).toBe('moved')
    // bottom edge 700+300=1000 > workArea bottom 900 -> y = 900-300-8
    expect(window.moved).toEqual([[100, 592]])
  })

  it('grows leftward when the right edge would overflow', () => {
    const window = windowStub([1200, 100])
    const docking = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    expect(docking.requestSkooch({ contentWidth: 400, contentHeight: 300 })).toBe('moved')
    // right edge 1200+400=1600 > 1440 -> x = 1440-400-8
    expect(window.moved).toEqual([[1032, 100]])
  })

  it('clamps both axes at once', () => {
    const window = windowStub([1300, 800])
    const docking = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    expect(docking.requestSkooch({ contentWidth: 400, contentHeight: 300 })).toBe('moved')
    expect(window.moved).toEqual([[1032, 592]])
  })

  it('ignores destroyed windows and non-finite sizes', () => {
    const gone: SkoochWindow = { getPosition: () => [0, 0], setPosition: () => { throw new Error('must not move') }, isDestroyed: () => true }
    const docking = new OverlayDocking(gone, screenStub([display(AREA)]), memoryStore())
    expect(docking.requestSkooch({ contentWidth: 400, contentHeight: 300 })).toBe('noop')
    const window = windowStub([100, 100])
    const live = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    expect(live.requestSkooch({ contentWidth: Number.NaN, contentHeight: 10 })).toBe('noop')
    expect(window.moved).toEqual([])
  })
})

describe('OverlayDocking position memory', () => {
  const saved: PersistedOverlayPosition = {
    absolutePointInWorkspace: { x: 200, y: 300 },
    monitor: { label: 'Built-in', width: 1440, height: 900, workArea: { ...AREA } },
    relativePointFromMonitor: { x: 200, y: 275 },
  }

  it('restores the offset on an exact monitor match', () => {
    const docking = new OverlayDocking(
      windowStub([0, 0]),
      screenStub([display(AREA, 'Built-in', { width: 1440, height: 900 })]),
      memoryStore(saved),
    )
    expect(docking.restore()).toEqual({ x: 200, y: 300 })
  })

  it('restores proportionally on a same-label monitor', () => {
    const big = { x: 0, y: 25, width: 2880, height: 1750 }
    const docking = new OverlayDocking(
      windowStub([0, 0]),
      screenStub([display(big, 'Built-in', { width: 2880, height: 1800 })]),
      memoryStore(saved),
    )
    expect(docking.restore()).toEqual({ x: (200 / 1440) * 2880, y: 25 + (275 / 875) * 1750 })
  })

  it('centers on primary when nothing matches', () => {
    const docking = new OverlayDocking(
      windowStub([0, 0]),
      screenStub([display(AREA, 'Other')]),
      memoryStore(null),
    )
    expect(docking.restore()).toEqual({ x: 720, y: 25 + 437.5 })
  })

  it('round-trips persist/restore on one display', () => {
    const store = memoryStore()
    const first = new OverlayDocking(windowStub([300, 400]), screenStub([display(AREA, 'Built-in', { width: 1440, height: 900 })]), store)
    first.persist()
    const second = new OverlayDocking(
      windowStub([0, 0]),
      screenStub([display(AREA, 'Built-in', { width: 1440, height: 900 })]),
      store,
    )
    expect(second.restore()).toEqual({ x: 300, y: 400 })
  })

  it('never throws when persistence fails', () => {
    const failing: OverlayPositionStore = {
      load: () => { throw new Error('disk gone') },
      save: () => { throw new Error('disk gone') },
    }
    const logged: unknown[][] = []
    const docking = new OverlayDocking(
      windowStub([10, 10]),
      screenStub([display(AREA)]),
      failing,
      8,
      (message, ...args) => { logged.push([message, ...args]) },
    )
    expect(() => docking.persist()).not.toThrow()
    expect(logged.length).toBeGreaterThan(0)
  })

  it('deregisters its IPC handler', () => {
    const handled = new Map<string, unknown>()
    const removed: string[] = []
    const ipc = {
      handle: vi.fn((channel: string, listener: unknown) => { handled.set(channel, listener) }),
      removeHandler: vi.fn((channel: string) => {
        removed.push(channel)
        handled.delete(channel)
      }),
    }
    const window = { ...windowStub([0, 0]), webContents: { mainFrame: {} } }
    const docking = new OverlayDocking(window, screenStub([display(AREA)]), memoryStore())
    const dispose = registerOverlayDockingIpc(
      ipc as unknown as IpcMain,
      window as unknown as Parameters<typeof registerOverlayDockingIpc>[1],
      docking,
    )
    expect(ipc.handle).toHaveBeenCalledOnce()
    expect(handled.has(OVERLAY_SKOOCH_CHANNEL)).toBe(true)
    dispose()
    expect(removed).toEqual([OVERLAY_SKOOCH_CHANNEL])
  })
})
