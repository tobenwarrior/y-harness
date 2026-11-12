/** Global Bot panel and its explicitly Session-bound Conversation child. */

import type { ReactNode } from 'react'
import type { BotView } from '@yharness/bots/client'
import type { HostObservable, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, InjectFace } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-conversation/client'
import type { SessionStatusSnapshot } from '@yharness/client-ui-session/client'
import type { BotWorkspaceFace, BotWorkspaceState } from './controller.ts'
import { BotDetail, BotGroupDetail, BotRoster } from './BotWorkspace.tsx'
import type { BotStatus, BotSummary } from './types.ts'
import { ComputerAction } from './ComputerAction.tsx'
import { GrokHistoryAction } from './GrokHistoryAction.tsx'
import { ComputerPanel } from './ComputerPanel.tsx'
import { MacComputerPanel } from './MacComputerPanel.tsx'
import type { AvailabilityState } from './computer-availability.ts'
import type { ComputerClient, ComputerIdentity } from './computer-client.ts'
import css from './BotWorkspace.module.css'

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
  & InjectFace<BotWorkspaceFace & {
    readonly computer: ComputerClient
    readonly setComputerTarget: (sessionId: string | null) => void
    readonly hooks: {
      readonly computerAvailability: HostObservable<AvailabilityState>
      readonly computerIdentity: HostObservable<ComputerIdentity | undefined>
      readonly computerTarget: HostObservable<string | null>
    }
  }>

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
    updatedAt: bot.updatedAt,
    name: bot.name,
    ...(bot.description === undefined ? {} : { description: bot.description }),
    ...(bot.persona === undefined ? {} : { persona: bot.persona }),
    ...(bot.capabilities === undefined ? {} : { capabilities: bot.capabilities }),
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
  create, createGroup, groupsAvailable, organize, templateActions, retry, loadAvatar, avatarEditor, share, sharedClient, t,
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
      templates={state.templates}
      templateActions={templateActions}
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
  useWorkspace, useSessionStatus, reference, retryGroup, updateGroup, sendGroupMessage,
  sendGroupMessageWithAttachments, reactGroupMessage, groupsAvailable, loadAvatar,
  rename, updateProfile, memoryManager, readGrokHistory,
  routineManager, skillManager, SessionProvider, renderSlot, t, share, computer, useComputerAvailability,
  setComputerTarget, useComputerTarget, useComputerIdentity,
}: BotsPanelProps): ReactNode {
  const state: BotWorkspaceState = useWorkspace(value => value)
  const statuses = useSessionStatus(value => value)
  const bots = state.bots.map(bot => summaryOf(bot, statuses))
  const availability = useComputerAvailability(value => value)
  const computerIdentity = useComputerIdentity(value => value)
  const computerTarget = useComputerTarget(value => value)
  const selectedBot = bots.find(bot => bot.id === state.selectedBotId)
  const selectedReference = reference()
  const canShowComputer = (availability === 'available' || availability === 'mac') && selectedReference !== undefined
  const showComputer = canShowComputer && computerTarget === selectedReference.sessionId
  const closeComputer = (): void => { setComputerTarget(null) }
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
        onSendWithAttachments={sendGroupMessageWithAttachments}
        {...(reactGroupMessage === undefined ? {} : { onReact: reactGroupMessage })}
        loadAvatar={loadAvatar}
        bots={bots}
        t={t}
      />
    )
  }
  return (
    <div className={css.computerLayout}>
      <BotDetail
        bot={selectedBot}
        children={conversation}
        headerActions={<>
          {canShowComputer && (
            <ComputerAction expanded={showComputer}
              {...(computerIdentity === undefined ? {} : { identity: computerIdentity })}
              toggle={() => { setComputerTarget(showComputer ? null : selectedReference.sessionId) }} t={t} />
          )}
          {readGrokHistory !== undefined && selectedBot !== undefined && (
            <GrokHistoryAction key={selectedBot.id} botId={selectedBot.id} botName={selectedBot.name} read={readGrokHistory} t={t} />
          )}
        </>}
        t={t}
        loadAvatar={loadAvatar}
        onRename={rename}
        onUpdateProfile={updateProfile}
        {...(share === undefined ? {} : { share })}
        memoryManager={memoryManager}
        skillManager={skillManager}
        routineManager={routineManager}
        routineRevision={state.routineRevision}
        loading={state.phase === 'loading' && bots.length === 0}
      />
      {showComputer && (
        <div className={css.computerSidebar}>
          {availability === 'mac' && selectedReference !== undefined
            ? <MacComputerPanel key={selectedReference.sessionId} sessionId={selectedReference.sessionId}
              close={closeComputer} t={t} />
            : <ComputerPanel key={selectedReference.sessionId} computer={computer} sessionId={selectedReference.sessionId}
              close={closeComputer} t={t} />}
        </div>
      )}
    </div>
  )
}
