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
function renderBadge(state: BadgeState) {
  const full: CompoundUpdateState = { apply: { phase: 'idle', error: null }, ...state }
  const show = vi.fn()
  const props = { t, useUpdate: (select: (value: CompoundUpdateState) => unknown) => select(full), show }
  return { ...render(<UpdateBadge {...props as ComponentProps<typeof UpdateBadge>} />), show }
}

describe('update badge', () => {
  it('renders nothing while no newer release is known', () => {
    renderBadge({ phase: 'ready', open: false, status: null })
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: '0.11.0', updateAvailable: false, repository: 'r', checkedAt: 1, error: null },
    })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names the released version and opens the steps panel', () => {
    const { show } = renderBadge({
      phase: 'ready', open: false,
      status: { vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true, repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null },
    })
    const badge = screen.getByRole('button', { name: en.badge })
    expect(badge.textContent).toContain(en.badgeShort)
    expect(badge.textContent).toContain('0.12.0')
    fireEvent.click(badge)
    expect(show).toHaveBeenCalledTimes(1)
  })
})
