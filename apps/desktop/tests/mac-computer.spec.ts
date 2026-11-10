import { describe, expect, it, vi } from 'vitest'
import { MacComputer } from '../src/mac-computer.ts'

const sessionId = '019abcdef000-0000-4000-a000-000000000000'
const otherSession = '019abcdef000-0000-4000-a000-000000000001'
const viewerId = '00000000-0000-4000-8000-000000000000'
const panel = { sessionId, viewerId }

function fixture() {
  let now = 1000
  const desktop = {
    permissions: vi.fn(() => ({ screenRecording: true, accessibility: true })),
    openSettings: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    capture: vi.fn(async () => ({ jpeg: '/9j/', width: 1000, height: 800 })),
    input: vi.fn(),
  }
  return { desktop, computer: new MacComputer(desktop, () => now), advance: () => { now += 9_000 } }
}

describe('Mac Computer sharing', () => {
  it('requires both macOS permissions before asking to share', async () => {
    const { desktop, computer } = fixture()
    desktop.permissions.mockReturnValue({ screenRecording: true, accessibility: false })
    expect(await computer.panel('start', panel)).toMatchObject({ shared: false, accessibility: false })
    expect(desktop.confirm).not.toHaveBeenCalled()
    await expect(computer.bot({ sessionId, action: { kind: 'observe' } })).rejects.toThrow('Share')
    expect(desktop.capture).not.toHaveBeenCalled()
  })

  it('only grants the approved Bot and pauses bot input during human control', async () => {
    const { desktop, computer } = fixture()
    expect(await computer.panel('start', panel)).toMatchObject({ shared: true })
    await expect(computer.bot({ sessionId: otherSession, action: { kind: 'observe' } })).rejects.toThrow('Share')
    const click = { kind: 'click', x: 200, y: 400, button: 1 }
    await expect(computer.bot({ sessionId, action: click })).rejects.toThrow('Observe')
    expect(await computer.bot({ sessionId, action: { kind: 'observe' } })).toMatchObject({ width: 1000 })
    await computer.panel('take-control', panel)
    await expect(computer.bot({ sessionId, action: click })).rejects.toThrow('paused')
    await computer.panel('release-control', panel)
    await computer.bot({ sessionId, action: { kind: 'observe' } })
    await computer.bot({ sessionId, action: click })
    expect(desktop.input).toHaveBeenCalledExactlyOnceWith(click, { width: 1000, height: 800 })
  })

  it('expires sharing when the viewer disappears and ignores a stale stop for another bot', async () => {
    const { computer, advance } = fixture()
    await computer.panel('start', panel)
    await computer.panel('stop', { ...panel, sessionId: otherSession })
    expect(await computer.panel('setup', panel)).toMatchObject({ shared: true })
    advance()
    expect(await computer.panel('setup', panel)).toMatchObject({ shared: false })
    await expect(computer.bot({ sessionId, action: { kind: 'observe' } })).rejects.toThrow('Share')
  })

  it('ends existing access before a second Bot can prompt for its own grant', async () => {
    const { computer, desktop } = fixture()
    await computer.panel('start', panel)
    expect(desktop.confirm).toHaveBeenCalledWith(sessionId, expect.any(AbortSignal))
    let allow: (value: boolean) => void = () => {}
    desktop.confirm.mockReturnValue(new Promise((resolve) => { allow = resolve }))
    const secondPanel = { ...panel, sessionId: otherSession }
    const starting = computer.panel('start', secondPanel)
    await expect(computer.bot({ sessionId, action: { kind: 'observe' } })).rejects.toThrow('Share')
    allow(true)
    expect(await starting).toMatchObject({ shared: true })
    expect(await computer.bot({ sessionId: otherSession, action: { kind: 'observe' } })).toMatchObject({ width: 1000 })
  })

  it('revokes bot access if the window closes while the permission dialog is open', async () => {
    const { computer, desktop } = fixture()
    let allow: (value: boolean) => void = () => {}
    desktop.confirm.mockReturnValue(new Promise((resolve) => { allow = resolve }))
    const starting = computer.panel('start', panel)
    await computer.panel('stop', panel)
    allow(true)
    expect(await starting).toMatchObject({ shared: false })
  })
})
