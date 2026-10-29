/** Global Bot panel and its explicitly Session-bound Conversation child. */

import type { ReactNode } from 'react'
import type { BotView } from '@deepseek-ai/dsh-bots/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { BotWorkspaceFace, BotWorkspaceState } from './controller.ts'
import { BotWorkspace } from './BotWorkspace.tsx'
import type { BotStatus, BotSummary } from './types.ts'

/** Main panel child slot that owns the selected Bot's Session binding. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Embedded Conversation for the selected Bot. */
    'bots.conversation': { kind: 'single'; scope: 'session-maybe' }
  }
}

/** Complete props for the root Bot panel. */
export type BotsPanelProps =
  PropsRuntime<'main'>
  & PropsRenderSlots<'bots.conversation'>
  & PropsLocale<'bots'>
  & InjectFace<BotWorkspaceFace>

/** Props for the Session-bound embedded Conversation occurrence. */
export type BotsConversationProps = PropsRuntime<'bots.conversation'> & PropsRenderFactories

function statusOf(bot: BotView, statuses: SessionStatusSnapshot): BotStatus | undefined {
  if (bot.state === 'provisioning') return 'preparing'
  const running = statuses.get(bot.sessionId)?.running
  if (running === true) return 'working'
  if (running === false) return 'idle'
  return undefined
}

function summaryOf(bot: BotView, statuses: SessionStatusSnapshot): BotSummary {
  const status = statusOf(bot, statuses)
  return {
    id: bot.id,
    name: bot.name,
    ...(bot.description === undefined ? {} : { description: bot.description }),
    ...(status === undefined ? {} : { status }),
    accent: bot.accent,
    identity: bot.identity,
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
  }
}

/** Render the selected Bot's real Conversation under its retained Session. */
export function BotsConversation({ renderFactorySlot }: BotsConversationProps): ReactNode {
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })
}

/** Render the roster and the selected Bot's one persistent Conversation. */
export function BotsPanel({
  useWorkspace, useSessionStatus, reference, select, create, retry, loadAvatar, avatarEditor, SessionProvider, renderSlot, t,
}: BotsPanelProps): ReactNode {
  const state: BotWorkspaceState = useWorkspace(value => value)
  const statuses = useSessionStatus(value => value)
  const bots = state.bots.map(bot => summaryOf(bot, statuses))
  const selectedReference = reference()
  const conversation = selectedReference === undefined
    ? undefined
    : (
      <SessionProvider session={selectedReference}>
        {renderSlot('bots.conversation', {})}
      </SessionProvider>
    )
  return (
    <BotWorkspace
      bots={bots}
      selectedBotId={state.selectedBotId}
      onSelectBot={select}
      onCreateBot={create}
      onRetry={retry}
      loadAvatar={loadAvatar}
      avatarEditor={avatarEditor}
      error={state.error}
      loading={state.phase === 'loading' && bots.length === 0}
      t={t}
    >
      {conversation}
    </BotWorkspace>
  )
}
