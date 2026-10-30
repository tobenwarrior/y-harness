/** One docked pane: retains its Session for display and binds the scope for it. */
import { useEffect, useMemo, type ReactNode } from 'react'
import type { SessionReference } from '@yharness/api-session-controller/client'
import type { SessionId } from '@yharness/session/types'

/** Props of one docked Session body. */
export interface DockSessionProps {
  /** Session this pane shows. */
  readonly sessionId: SessionId
  /** Retains the Session while the pane is mounted. */
  readonly retain: (sessionId: SessionId) => SessionReference
  /** Releases the retained reference. */
  readonly release: (reference: SessionReference) => void
  /** Framework session-area component that binds the scope. */
  readonly SessionProvider: (props: { readonly session: SessionReference; readonly children: ReactNode }) => ReactNode
  /** Renders the Conversation subtree for the bound Session. */
  readonly renderConversation: () => ReactNode
}

/**
 * Render one pane's Conversation bound to its own Session.
 *
 * The reference is retained for the pane's lifetime: a pane is a second live view
 * of a Session, so the Session stays open until the pane goes away.
 * @param props - the pane's Session, its retain/release pair, and the slot seats.
 * @returns the bound Conversation subtree.
 */
export function DockSession({ sessionId, retain, release, SessionProvider, renderConversation }: DockSessionProps): ReactNode {
  const reference = useMemo(() => retain(sessionId), [retain, sessionId])
  useEffect(() => () => { release(reference) }, [reference, release])
  return <SessionProvider session={reference}>{renderConversation()}</SessionProvider>
}
