/**
 * presentUpdateBadge: every updater phase maps to a control that can act, a
 * silent background check stays silent, and the dot clears once acknowledged.
 */
import { describe, expect, it } from 'vitest'
import type { DesktopUpdatePresentation } from '../src/ipc.ts'
import { deriveBuildFlavor, presentUpdateBadge, updateBadgeDemandsAttention } from '../src/update-badge.ts'

function state(phase: DesktopUpdatePresentation['phase'], extra: Partial<DesktopUpdatePresentation> = {}): DesktopUpdatePresentation {
  return { phase, ...extra }
}

describe('presentUpdateBadge', () => {
  it.each(['idle', 'unavailable', 'checking'] as const)('stays hidden for %s', (phase) => {
    const badge = presentUpdateBadge(state(phase))
    expect(badge.visible).toBe(false)
    expect(badge.action).toBe('none')
  })

  it('announces an available update with the version and a dot', () => {
    const badge = presentUpdateBadge(state('available', { version: '1.4.0' }))
    expect(badge).toEqual({
      visible: true,
      tone: 'attention',
      dot: true,
      label: 'Update available: 1.4.0',
      action: 'open-update',
      version: '1.4.0',
    })
  })

  it('tells the user to restart once an update is ready', () => {
    const badge = presentUpdateBadge(state('ready', { version: '1.4.0' }))
    expect(badge.tone).toBe('attention')
    expect(badge.dot).toBe(true)
    expect(badge.label).toBe('Restart to update to 1.4.0')
  })

  it('shows download progress with a floored percentage', () => {
    const badge = presentUpdateBadge(state('downloading', { version: '1.4.0', percent: 42.7 }))
    expect(badge).toMatchObject({ tone: 'progress', percent: 42, dot: false })
    expect(badge.label).toBe('Downloading update: 42%')
  })

  it('omits the percentage when the updater did not report one', () => {
    const badge = presentUpdateBadge(state('downloading', { version: '1.4.0' }))
    expect(badge.percent).toBeUndefined()
    expect(badge.label).toBe('Downloading update')
  })

  it.each([
    ['verifying', 'Verifying update'],
    ['installing', 'Installing update'],
  ] as const)('reports %s as progress', (phase, label) => {
    expect(presentUpdateBadge(state(phase))).toMatchObject({ tone: 'progress', label, dot: false })
  })

  it('hides a silent background check failure', () => {
    const badge = presentUpdateBadge(state('error', { failure: 'check' }))
    expect(badge.visible).toBe(false)
  })

  it('surfaces a failure the user initiated, with a retry', () => {
    const badge = presentUpdateBadge(state('error', { failure: 'download' }), { userInitiated: true })
    expect(badge).toMatchObject({ visible: true, tone: 'problem', action: 'retry', label: 'Update failed' })
  })

  it('clears the dot once the version was acknowledged', () => {
    const badge = presentUpdateBadge(state('available', { version: '1.4.0' }), {
      acknowledgedVersions: ['1.4.0'],
    })
    expect(badge.visible).toBe(true)
    expect(badge.dot).toBe(false)
  })

  it('keeps the ready dot even when acknowledged (installing is deferred and destructive)', () => {
    const badge = presentUpdateBadge(state('ready', { version: '1.4.0' }), {
      acknowledgedVersions: ['1.4.0'],
    })
    expect(badge.dot).toBe(true)
  })

  it('never leaks failure diagnostics into the label', () => {
    const badge = presentUpdateBadge(
      state('error', { failure: 'check-network' }),
      { userInitiated: true },
    )
    expect(badge.label).toBe('Update check failed')
    expect(badge.label).not.toContain('ERR_')
  })

  it('stays actionable for every visible phase', () => {
    for (const phase of ['available', 'downloading', 'verifying', 'installing', 'ready'] as const) {
      const badge = presentUpdateBadge(state(phase, { version: '1.0.0' }))
      expect(badge.visible).toBe(true)
      expect(badge.action).toBe('open-update')
    }
  })
})

describe('updateBadgeDemandsAttention', () => {
  it('is true only for an unacknowledged attention state', () => {
    expect(updateBadgeDemandsAttention(presentUpdateBadge(state('available', { version: '1' })))).toBe(true)
    expect(updateBadgeDemandsAttention(presentUpdateBadge(state('ready', { version: '1' })))).toBe(true)
    expect(updateBadgeDemandsAttention(presentUpdateBadge(state('downloading', { version: '1' })))).toBe(false)
    expect(updateBadgeDemandsAttention(presentUpdateBadge(state('idle')))).toBe(false)
    expect(updateBadgeDemandsAttention(presentUpdateBadge(
      state('available', { version: '1' }), { acknowledgedVersions: ['1'] },
    ))).toBe(false)
  })
})

describe('deriveBuildFlavor', () => {
  it('treats a .dev. bundle identifier as a development build', () => {
    // The running bundle id is com.deepseek.harness.dev.659405b693f0.
    expect(deriveBuildFlavor({
      isPackaged: true,
      updateConfigPresent: true,
      bundleId: 'com.deepseek.harness.dev.659405b693f0',
    })).toBe('development')
  })

  it('requires BOTH packaging and an update feed to promise updates', () => {
    expect(deriveBuildFlavor({ isPackaged: true, updateConfigPresent: true, bundleId: 'com.yharness.app' }))
      .toBe('packaged')
    // Packaged but no feed: never described as update-capable.
    expect(deriveBuildFlavor({ isPackaged: true, updateConfigPresent: false, bundleId: 'com.yharness.app' }))
      .toBe('unknown')
    expect(deriveBuildFlavor({ isPackaged: false, updateConfigPresent: false }))
      .toBe('development')
  })

  it.each(['staging', 'test', 'development'])('treats .%s. identifiers as non-release', (segment) => {
    expect(deriveBuildFlavor({
      isPackaged: true,
      updateConfigPresent: true,
      bundleId: `com.yharness.fork.${segment}.launcher`,
    })).toBe('development')
  })
})

describe('development builds explain themselves', () => {
  it('reports why there is no update channel instead of rendering nothing', () => {
    const badge = presentUpdateBadge(state('idle'), { flavor: 'development' })
    expect(badge).toMatchObject({ visible: true, tone: 'not-applicable', action: 'none', dot: false })
    expect(badge.label).toContain('Development build')
  })

  it('does not promise updates even when the updater reports a state', () => {
    // Defensive: a dev build with a stale 'available' state still says the truth.
    const badge = presentUpdateBadge(state('available', { version: '9.9.9' }), { flavor: 'development' })
    expect(badge.tone).toBe('not-applicable')
    expect(badge.action).toBe('none')
  })

  it('never demands attention for a not-applicable badge', () => {
    expect(updateBadgeDemandsAttention(presentUpdateBadge(state('idle'), { flavor: 'development' }))).toBe(false)
  })
})
