// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CompoundUpdateState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdatePanel } from '../src/client/UpdatePanel.tsx'

afterEach(cleanup)

const t = makeTranslate(en)
const RELEASED = {
  vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true,
  repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null,
}

/**
 * Render the panel against one indicator state.
 * @param state - indicator state the injected hook reads.
 * @returns the recorded panel actions.
 */
function renderPanel(state: CompoundUpdateState) {
  const hide = vi.fn()
  const refresh = vi.fn()
  const show = vi.fn()
  const props = { t, useUpdate: (select: (value: CompoundUpdateState) => unknown) => select(state), hide, refresh, show }
  render(<UpdatePanel {...props as ComponentProps<typeof UpdatePanel>} />)
  return { hide, refresh, show }
}

describe('update steps panel', () => {
  it('renders nothing while it is closed', () => {
    renderPanel({ phase: 'ready', open: false, status: RELEASED })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports progress while the reading is in flight', () => {
    renderPanel({ phase: 'loading', open: true, status: null })
    expect(screen.getByRole('dialog').textContent).toContain(en.checking)
  })

  it('reports nothing about versions before the first reading', () => {
    renderPanel({ phase: 'idle', open: true, status: null })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).not.toContain(en.checking)
    expect(dialog.textContent).not.toContain(en.stepsTitle)
  })

  it('shows the released version, the steps, and the upstream repository', () => {
    renderPanel({ phase: 'ready', open: true, status: RELEASED })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('0.12.0')
    expect(dialog.textContent).toContain('0.11.0')
    expect(dialog.textContent).toContain(en.stepsTitle)
    expect(dialog.textContent).toContain(en.stepsBody)
    expect(screen.getByRole('link', { name: RELEASED.repository }).getAttribute('href'))
      .toBe(`https://github.com/${RELEASED.repository}`)
  })

  it('renders an available release that names no upstream version', () => {
    renderPanel({ phase: 'ready', open: true, status: { ...RELEASED, upstream: null } })
    expect(screen.getByRole('dialog').textContent).toContain(en.available.replace('{upstream}', '').replace('{vendored}', '0.11.0'))
  })

  it('reports an unreachable upstream without update steps', () => {
    renderPanel({
      phase: 'ready', open: true,
      status: { ...RELEASED, upstream: null, updateAvailable: false, error: 'HTTP 503' },
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('HTTP 503')
    expect(dialog.textContent).not.toContain(en.stepsTitle)
  })

  it('reports that the build already ships the released version', () => {
    renderPanel({
      phase: 'ready', open: true,
      status: { ...RELEASED, upstream: '0.11.0', updateAvailable: false },
    })
    expect(screen.getByRole('dialog').textContent).toContain(en.current.replace('{vendored}', '0.11.0'))
  })

  it('hands the deliberate actions back to the caller', () => {
    const { hide, refresh } = renderPanel({ phase: 'ready', open: true, status: RELEASED })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
