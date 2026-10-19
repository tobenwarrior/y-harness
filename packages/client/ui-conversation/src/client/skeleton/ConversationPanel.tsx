/** Root-scoped main occupant; Session binding belongs to its Conversation child. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DockSession } from '../dock/DockSession.tsx'
import { SessionDock } from '../dock/SessionDock.tsx'
import type { ConversationDockFace } from '../dock/face.ts'
import type {} from '../contract/slots.ts'

/**
 * Render the Conversation with optional current-Session binding.
 *
 * One pane is the ambient Session, which is the client's usual single view. Once
 * panes are docked the same Conversation renders per pane, each bound to its own
 * Session through the `SessionProvider` seat.
 * @param props - main-slot inputs, the declared Conversation renderer, dock state, and locale.
 * @returns the Conversation subtree, or the docked grid.
 */
export function ConversationPanel({
  renderSlot, SessionProvider, t, useDock, useSessions, split, close, show, titleOf, retain, release,
}: PropsRuntime<'main'> & PropsRenderSlots<'main.conversation'> & InjectFace<ConversationDockFace> & PropsLocale<'conversation'>): ReactNode {
  const dock = useDock(state => state)
  const sessions = useSessions(state => state.ids)
  if (dock.panes.length <= 1) return renderSlot('main.conversation', {})
  return (
    <SessionDock
      state={dock}
      sessions={sessions ?? []}
      titleOf={titleOf}
      ambientLabel={t('dock.ambient')}
      canSplit={dock.columns < 3 || dock.rows < 2}
      onSplit={split}
      onClose={close}
      onShow={show}
      labels={{
        splitRight: t('dock.splitRight'),
        splitDown: t('dock.splitDown'),
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
}
