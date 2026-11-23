import { describe, expect, it, vi } from 'vitest'
import { claimDesktopSingleInstance, type DesktopSingleInstanceApplication } from '../src/single-instance.ts'

type DesktopSecondInstanceListener = Parameters<DesktopSingleInstanceApplication['on']>[1]

describe('desktop single-instance ownership', () => {
  it('quits a second process without registering lifecycle work', () => {
    const quit = vi.fn()
    const on = vi.fn()
    const application = {
      requestSingleInstanceLock: () => false,
      quit,
      on,
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, vi.fn())).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(on).not.toHaveBeenCalled()
  })

  it('routes a later launch to the primary process', () => {
    let secondInstance: DesktopSecondInstanceListener | undefined
    const openInOwner = vi.fn()
    const application = {
      requestSingleInstanceLock: () => true,
      quit: vi.fn(),
      on: vi.fn((_event: 'second-instance', listener: DesktopSecondInstanceListener) => { secondInstance = listener }),
    } satisfies DesktopSingleInstanceApplication

    expect(claimDesktopSingleInstance(application, openInOwner)).toBe(true)
    const argv = ['desktop', 'dsh://bots/prompt?text=Review']
    secondInstance?.({}, argv)
    expect(openInOwner).toHaveBeenCalledExactlyOnceWith(argv)
  })
})
