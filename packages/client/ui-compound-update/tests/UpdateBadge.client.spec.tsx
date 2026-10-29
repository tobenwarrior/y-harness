// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CompoundUpdateState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdateBadge } from '../src/client/UpdateBadge.tsx'

afterEach(cleanup)

const t = makeTranslate(en)

/** Badge state without the update progress, which every case starts from idle. */
type BadgeState = Omit<CompoundUpdateState, 'apply'> & { apply?: CompoundUpdateState['apply'] }

/**
 * Render the badge against one indicator state.
 * @param state - indicator state the injected hook reads.
 * @returns the render result and the recorded open action.
 */
function renderBadge(state: BadgeState, wide = true) {
  const full: CompoundUpdateState = { apply: { phase: 'idle', error: null }, ...state }
  const show = vi.fn()
  const props = { t, useUpdate: (select: (value: CompoundUpdateState) => unknown) => select(full), show, wide }
  return { ...render(<UpdateBadge {...props as ComponentProps<typeof UpdateBadge>} />), show }
}

describe('update badge', () => {
  it('renders nothing before the first status read', () => {
    renderBadge({ phase: 'ready', open: false, status: null })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the sidebar quiet when skills are already up to date', () => {
    renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: '0.11.0', updateAvailable: false, repository: 'r', checkedAt: 1, error: null },
    })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps a failed status action available for retry', () => {
    renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: null, updateAvailable: false, repository: 'r', checkedAt: 1, error: 'HTTP 503' },
    })
    const badge = screen.getByRole('button', { name: en.badgeError })
    expect(badge.textContent).toBe('')
    expect(badge.querySelector('svg')).not.toBeNull()
  })

  it.each([true, false])('keeps the available action icon-only in %s sidebar mode', (wide) => {
    const { show } = renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true, repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null },
    }, wide)
    const badge = screen.getByRole('button', { name: en.badge })
    expect(badge.getAttribute('aria-label')).toBe(en.badge)
    expect(badge.textContent).toBe('')
    expect(badge.querySelector('svg')).not.toBeNull()
    fireEvent.click(badge)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('identifies the skills update in the tooltip', () => {
    renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true, repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null },
    })
    fireEvent.focus(screen.getByRole('button', { name: en.badge }))
    expect(screen.getByRole('tooltip').textContent).toContain(en.badge)
  })
})
