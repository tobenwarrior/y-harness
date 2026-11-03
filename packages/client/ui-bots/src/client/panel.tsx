/** Global Bot panel and its explicitly Session-bound Conversation child. */

import type { ReactNode } from 'react'
import type { BotView } from '@yharness/bots/client'
import type { PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, InjectFace } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-conversation/client'
import type { SessionStatusSnapshot } from '@yharness/client-ui-session/client'
import type { BotWorkspaceFace, BotWorkspaceState } from './controller.ts'
import { BotDetail, BotGroupDetail, BotRoster } from './BotWorkspace.tsx'
import type { BotStatus, BotSummary } from './types.ts'

/** Main panel child slot that owns the selected Bot's Session binding. */
declare module '@yharness/client-ui-slots' {
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

/** Props for the Bot roster occupying the shared application sidebar. */
export type BotsRosterProps =
  PropsRuntime<'sidebar.bots'>
  & PropsLocale<'bots'>
  & InjectFace<BotWorkspaceFace>

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
    ...(bot.group === undefined ? {} : { group: bot.group }),
    pinned: bot.pinned,
    hidden: bot.hidden,
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

/** Render the Bot roster inside the existing sidebar column. */
export function BotsRoster({
  wide, expandSidebar, useWorkspace, useSessionStatus, reference: _reference, select, selectGroup,
  create, createGroup, groupsAvailable, organize, retry, loadAvatar, avatarEditor, share, sharedClient, t,
  loadConnectedApps,
  setConnectedAppAccess,
}: BotsRosterProps): ReactNode {
  const state: BotWorkspaceState = useWorkspace(value => value)
  const statuses = useSessionStatus(value => value)
  const bots = state.bots.map(bot => summaryOf(bot, statuses))
  return (
    <BotRoster
      bots={bots}
      groups={state.groups}
      selectedBotId={state.selectedBotId}
      selectedGroupId={state.selectedGroupId}
      onSelectBot={select}
      onSelectGroup={groupsAvailable ? selectGroup : undefined}
      onCreateBot={create}

      onOrganizeBot={organize}
      onCreateGroup={groupsAvailable ? createGroup : undefined}
      groupError={state.groupError}
      onLoadConnectedApps={loadConnectedApps}
      onSetConnectedAppAccess={setConnectedAppAccess}
      onRetry={retry}
      loadAvatar={loadAvatar}
      avatarEditor={avatarEditor}
      {...(share === undefined ? {} : { share })}
      {...(sharedClient === undefined ? {} : { sharedClient })}
      error={state.error}
      loading={state.phase === 'loading' && bots.length === 0}
      wide={wide}
      expandSidebar={expandSidebar}
      t={t}
    />
  )
}

/** Render the selected Bot's one persistent Conversation in the main panel. */
export function BotsPanel({
  useWorkspace, useSessionStatus, reference, retryGroup, updateGroup, sendGroupMessage, groupsAvailable, loadAvatar, rename, memoryManager,
  SessionProvider, renderSlot, t, share,
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
  if (groupsAvailable && state.selectedGroupId !== null) {
    return (
      <BotGroupDetail
        group={state.selectedGroup ?? undefined}
        loading={state.groupPhase === 'loading'}
        error={state.groupError}
        onRetry={retryGroup}
        onUpdate={updateGroup}
        onSend={sendGroupMessage}
        loadAvatar={loadAvatar}
        bots={bots}
        t={t}
      />
    )
  }
  return (
    <BotDetail
      bot={state.selectedBotId === null ? undefined : bots.find(bot => bot.id === state.selectedBotId)}
      children={conversation}
      t={t}
      loadAvatar={loadAvatar}
      onRename={rename}
      {...(share === undefined ? {} : { share })}
      memoryManager={memoryManager}
      loading={state.phase === 'loading' && bots.length === 0}
    />
  )
}
