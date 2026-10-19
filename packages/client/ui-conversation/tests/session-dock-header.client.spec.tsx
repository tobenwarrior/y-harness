// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionDock, type SessionDockProps } from '../src/client/dock/SessionDock.tsx'

afterEach(cleanup)

const sessions = ['b', 'c'].map(id => id as SessionId)

function props(overrides: Partial<SessionDockProps> = {}): SessionDockProps {
  return {
    state: {
      panes: [{ sessionId: null }, { sessionId: sessions[0] as SessionId }],
      columns: 2,
      rows: 1,
    },
    sessions,
    titleOf: sessionId => `Session ${sessionId}`,
    ambientLabel: 'Current session',
    renderBody: () => <div />,
    onClose: vi.fn(),
    onShow: vi.fn(),
    labels: { close: 'Close pane', pane: 'Session pane' },
    ...overrides,
  }
}

describe('SessionDock header', () => {
  it('renders one close control per pane and no split controls', () => {
    const view = render(<SessionDock {...props()} />)
    expect(view.getAllByRole('button', { name: 'Close pane' })).toHaveLength(2)
    expect(view.queryByText('Split right')).toBeNull()
    expect(view.queryByText('Split down')).toBeNull()
    expect(view.queryByText('Close pane')).toBeNull()
  })

  it('closes the pane whose control was pressed, not the last one', () => {
    const onClose = vi.fn()
    const view = render(<SessionDock {...props({ onClose })} />)
    fireEvent.click(view.getAllByRole('button', { name: 'Close pane' })[0] as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(0)
  })

  it('shows no close control for a single pane', () => {
    const view = render(<SessionDock {...props({
      state: { panes: [{ sessionId: null }], columns: 1, rows: 1 },
    })} />)
    expect(view.queryByRole('button', { name: 'Close pane' })).toBeNull()
  })

  it('points a pane at the picked Session', () => {
    const onShow = vi.fn()
    const view = render(<SessionDock {...props({ onShow })} />)
    const picker = view.getAllByRole('combobox', { name: 'Session pane' })[1] as HTMLSelectElement
    fireEvent.change(picker, { target: { value: 'c' } })
    expect(onShow).toHaveBeenCalledWith(1, 'c')
  })
})
