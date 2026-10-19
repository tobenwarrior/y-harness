/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import { useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DockSession } from '../dock/DockSession.tsx'
import { SessionDock } from '../dock/SessionDock.tsx'
import type { ConversationDockFace } from '../dock/face.ts'
import type { DropZone } from '../dock/store.ts'
import type {} from '../contract/slots.ts'
import css from '../dock/SessionDock.module.css'

/** Fraction of the surface that counts as an edge rather than the centre. */
const EDGE_BAND = 0.3

/** Which edge a pointer sits on; the centre reads as "beside", never as a new row. */
function zoneAt(event: DragEvent<HTMLDivElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  if (x < EDGE_BAND) return 'left'
  if (x > 1 - EDGE_BAND) return 'right'
  if (y < EDGE_BAND) return 'top'
  if (y > 1 - EDGE_BAND) return 'bottom'
  return 'right'
}

/**
 * Render the Conversation with optional current-Session binding, and accept a
 * Session dragged in from the sidebar.
 *
 * One pane is the ambient Session, which is the client's usual single view. Once
 * panes are docked the same Conversation renders per pane, each bound to its own
 * Session through the `SessionProvider` seat. A Session dropped on an edge adds a
 * pane on that side; the surface previews the side while the drag is over it.
 * @param props - main-slot inputs, the declared Conversation renderer, dock state, and locale.
 * @returns the Conversation subtree, the docked grid, and the drop preview.
 */
export function ConversationPanel({
  renderSlot, SessionProvider, t, useDock, useSessions, close, show, titleOf, retain, release, drop,
}: PropsRuntime<'main'> & PropsRenderSlots<'main.conversation'> & InjectFace<ConversationDockFace> & PropsLocale<'conversation'>): ReactNode {
  const dock = useDock(state => state)
  const sessions = useSessions(state => state.ids)
  const [zone, setZone] = useState<DropZone | null>(null)
  const known = new Set<string>(sessions)
  const carriesSession = (event: DragEvent<HTMLDivElement>): boolean => event.dataTransfer.types.includes('text/plain')

  const body = dock.panes.length <= 1
    ? renderSlot('main.conversation', {})
    : (
      <SessionDock
        state={dock}
        sessions={sessions}
        titleOf={titleOf}
        ambientLabel={t('dock.ambient')}
        onClose={close}
        onShow={show}
        labels={{
          close: t('dock.close'),
          pane: t('dock.pane'),
        }}
        renderBody={sessionId => sessionId === null
          ? renderSlot('main.conversation', {})
          : (
            <DockSession
              sessionId={sessionId}
              retain={retain}
              release={release}
              SessionProvider={SessionProvider}
              renderConversation={() => renderSlot('main.conversation', {})}
            />
          )}
      />
    )

  return (
    <div
      className={css.surface}
      data-yh-part="conversation-drop-surface"
      data-drop-zone={zone ?? undefined}
      onDragOver={(event) => {
        if (!carriesSession(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setZone(zoneAt(event))
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setZone(null)
      }}
      onDrop={(event) => {
        if (!carriesSession(event)) return
        event.preventDefault()
        const dropped = event.dataTransfer.getData('text/plain')
        setZone(null)
        if (known.has(dropped)) drop(dropped as SessionId, zoneAt(event))
      }}
    >
      {body}
      {zone !== null && <div className={clsx(css.preview, css[zone])} aria-hidden="true" />}
    </div>
  )
}
