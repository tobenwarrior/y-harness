/** What the docked grid needs from the plugin: its state, its Sessions, and its actions. */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DockDirection, DockedSession, DropZone, SessionDockState } from './store.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A docked pane's second live view of one Session. */
    dockPane: unknown
  }
}

/** The part of the Session list the pane picker reads. */
export interface DockSessionList {
  /** Every Session the client knows, newest first. */
  readonly ids: readonly SessionId[]
}

/** Face injected into the center occupant that may render docked panes. */
export interface ConversationDockFace {
  /** Reading sources the panel binds as hooks. */
  readonly hooks: {
    /** Docked panes and their grid. */
    readonly dock: HostObservable<SessionDockState>
    /** Sessions the pane picker offers. */
    readonly sessions: HostObservable<DockSessionList>
  }
  /** Grow the grid toward one edge. */
  readonly split: (direction: DockDirection) => void
  /** Drop the last pane. */
  readonly close: () => void
  /** Point one pane at another Session. */
  readonly show: (index: number, sessionId: DockedSession) => void
  /** Place a Session dragged in from the sidebar on one edge. */
  readonly drop: (sessionId: SessionId, zone: DropZone) => void
  /** Label for one Session in the pane picker. */
  readonly titleOf: (sessionId: SessionId) => string
  /** Retain a Session for display in a pane; the caller disposes the reference. */
  readonly retain: (sessionId: SessionId) => SessionReference
  /** Release a reference a pane no longer needs. */
  readonly release: (reference: SessionReference) => void
}
