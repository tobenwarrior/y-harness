// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import type { CompoundUpdateState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'
import { UpdatePanel } from '../src/client/UpdatePanel.tsx'

afterEach(cleanup)

const t = makeTranslate(en)
const RELEASED = {
  vendored: '0.11.0', upstream: '0.12.0', updateAvailable: true,
  repository: 'tobenwarrior/compound-skills', checkedAt: 1, error: null,
}

/** Panel state without the implicit update progress, which every case starts from idle. */
type PanelState = Omit<CompoundUpdateState, 'apply'> & { apply?: CompoundUpdateState['apply'] }

/**
 * Render the panel against one indicator state.
 * @param state - indicator state the injected hook reads.
 * @returns the recorded panel actions.
 */
function renderPanel(state: PanelState) {
  const full: CompoundUpdateState = { apply: { phase: 'idle', error: null }, ...state }
  const hide = vi.fn()
  const refresh = vi.fn()
  const show = vi.fn()
  const apply = vi.fn()
  const props = { t, useUpdate: (select: (value: CompoundUpdateState) => unknown) => select(full), hide, refresh, show, apply }
  render(<UpdatePanel {...props as ComponentProps<typeof UpdatePanel>} />)
  return { hide, refresh, show, apply }
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
    expect(dialog.textContent).toContain(en.restartHint)
    expect(dialog.querySelectorAll('svg')).toHaveLength(5)
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
    const { hide, refresh, apply } = renderPanel({ phase: 'ready', open: true, status: RELEASED })
    fireEvent.click(screen.getByRole('button', { name: en.update.replace('{upstream}', '0.12.0') }))
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    fireEvent.click(screen.getByRole('button', { name: en.close }))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('closes from Escape through the shared modal layer', () => {
    const { hide } = renderPanel({ phase: 'ready', open: true, status: RELEASED })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('reports a running update and its failure', () => {
    renderPanel({ phase: 'ready', open: true, status: RELEASED, apply: { phase: 'running', error: null } })
    expect(screen.getByRole('button', { name: en.updating }).hasAttribute('disabled')).toBe(true)
    cleanup()
    renderPanel({ phase: 'ready', open: true, status: RELEASED, apply: { phase: 'failed', error: 'tree is dirty' } })
    expect(screen.getByRole('dialog').textContent).toContain(en.updateFailed.replace('{reason}', 'tree is dirty'))
    expect(screen.getByRole('button', { name: en.update.replace('{upstream}', '0.12.0') }).hasAttribute('disabled')).toBe(false)
  })
})
