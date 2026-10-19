// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DockPaneClose, type DockPaneCloseProps } from '../src/client/dock/DockPaneClose.tsx'
import type { DockedPane, SessionDockState } from '../src/client/dock/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn) as DockPaneCloseProps['t']

const ids = ['a', 'b', 'c'].map(id => id as SessionId)

function pane(sessionId: DockedPane['sessionId']): DockedPane {
  return { sessionId }
}

function show(sessionId: SessionId, panes: readonly DockedPane[]) {
  const closePane = vi.fn()
  const useDock = bindSnapshotSelector(createSnapshotStore<SessionDockState>({
    panes, columns: panes.length, rows: 1,
  }))
  const props = { sessionId, useDock, closePane, t } as DockPaneCloseProps
  render(<DockPaneClose {...props} />)
  return { closePane }
}

describe('DockPaneClose', () => {
  it('closes the pane showing its own Session', () => {
    const { closePane } = show(ids[1] as SessionId, [pane(null), pane(ids[1] as SessionId), pane(ids[2] as SessionId)])
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }))
    expect(closePane).toHaveBeenCalledTimes(1)
    expect(closePane).toHaveBeenCalledWith(1)
  })

  it('renders nothing for a single pane', () => {
    show(ids[0] as SessionId, [pane(null)])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing when its Session is not docked', () => {
    show(ids[2] as SessionId, [pane(null), pane(ids[1] as SessionId)])
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing on the ambient pane the client follows', () => {
    show(ids[0] as SessionId, [pane(null), pane(ids[1] as SessionId)])
    expect(screen.queryByRole('button')).toBeNull()
  })
})
