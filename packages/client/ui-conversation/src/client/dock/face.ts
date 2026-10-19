/** What the docked grid needs from the plugin: its state and its actions. */
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DropZone, SessionDockState } from './store.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A docked pane's second live view of one Session. */
    dockPane: unknown
  }
}

/** Face injected into the center occupant that may render docked panes. */
export interface ConversationDockFace {
  /** Reading sources the panel binds as hooks. */
  readonly hooks: {
    /** Docked panes and their grid. */
    readonly dock: HostObservable<SessionDockState>
  }
  /** Place a Session dragged in from the sidebar on one edge. */
  readonly drop: (sessionId: SessionId, zone: DropZone) => void
  /** Retain a Session for display in a pane; the caller disposes the reference. */
  readonly retain: (sessionId: SessionId) => SessionReference
  /** Release a reference a pane no longer needs. */
  readonly release: (reference: SessionReference) => void
}
