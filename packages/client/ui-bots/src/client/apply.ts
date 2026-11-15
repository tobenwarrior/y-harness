/** Registers the Bot roster panel and its explicitly bound Conversation. */

import type { Context } from '@yharness/cordis'
import type { ConnectionHandle } from '@yharness/client-connection/client'
import type {} from '@yharness/api-remotes/client'
import type {} from '@yharness/client-ui-renderer/client'
import type {} from '@yharness/client-ui-sidebar/client'
import type {} from '@yharness/client-ui-sidebar-right/client'
import type {} from '@yharness/client-ui-conversation/client'
import type {} from '@yharness/client-locale/client'
import type { InputTriggerSource } from '@yharness/client-ui-input-trigger/client'
import type { BotAvatar } from '@yharness/bots/client'
import { createSnapshotStore } from '@yharness/client-store'
import type { MainPanelId } from '@yharness/client-ui-layout/client'
import { BotWorkspaceController } from './controller.ts'
import { BotReplyAvatar, BotsConversation, BotsPanel, BotsRoster, type BotReplyAvatarFace, type ComputerSignInTarget } from './panel.tsx'
import { en, zh } from './locales.ts'
import { createSharedBotsClient } from './shared-client.ts'
import { createComputerAvailability } from './computer-availability.ts'
import { createComputerClient } from './computer-client.ts'
import { ComputerGlyph } from './ComputerAction.tsx'
import { createBotReferenceSource } from './bot-reference-source.ts'
import { BotVaultRequestCard } from './BotVaultRequestCard.tsx'
import { BotWebsiteLoginRequestCard } from './BotWebsiteLoginRequestCard.tsx'
import { ComputerSignInCard } from './ComputerSignInCard.tsx'

/** Stable main-panel identity shared by the sidebar entry and main occupant. */
export const PANEL_ID = 'bots' as MainPanelId

/** Services required by the Bot roster and its Session-backed Conversation; image generation is optional. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.bots', 'sessions', 'connection',
]

/** Register the Bot workspace, loading one durable roster and one Session per selection. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('bots', { en, zh }), 'ui-bots: dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  const sharedClient = createSharedBotsClient(connection.rpc, {
    subscribeConnectionGeneration: listener => connection.generation.subscribe(listener),
  })
  const controller = new BotWorkspaceController(
    ctx.remote.bots,
    ctx.sessions,
    () => ctx.locale.bind('bots')('unexpectedResponse'),
    ctx.get('remote.avatarGeneration') as typeof ctx.remote.avatarGeneration | undefined,
    () => ctx.locale.bind('bots')('groupDeliveryFailure'),
    undefined,
    key => ctx.locale.bind('bots')(key),
    sharedClient,
  )
  const computer = createComputerClient()
  const computerAvailability = createComputerAvailability(computer)
  const computerTarget = createSnapshotStore<string | null>(null)
  const computerSignIn = createSnapshotStore<ComputerSignInTarget | undefined>(undefined)
  let signInAttempt = 0
  const workspace = controller.face().hooks.workspace
  const selectedSessionId = (): string | undefined => {
    const snapshot = workspace.getSnapshot()
    const selected = snapshot.bots.find(bot => bot.id === snapshot.selectedBotId)
    return selected?.sessionId
  }
  const terminalAvailable = createSnapshotStore(false)
  const filesAvailable = createSnapshotStore(false)
  const sharedFilesAvailable = createSnapshotStore(false)
  const setComputerTarget = (sessionId: string | null, request?: ComputerSignInTarget): void => {
    const sidebar = ctx.get('sidebarRight')
    if (sessionId !== null && sidebar !== undefined && sidebar.mounted.getSnapshot() === sessionId && sidebar.isExpanded()) {
      sidebar.toggleExpanded()
    }
    computerSignIn.set(request)
    computerTarget.set(sessionId)
  }
  const openWorkspaceTab = (kind: 'terminal' | 'computer-files' | 'computer-shared-files'): void => {
    const sidebar = ctx.get('sidebarRight')
    const sessionId = controller.face().reference()?.sessionId
    if (sidebar === undefined || sessionId === undefined || sidebar.mounted.getSnapshot() !== sessionId) return
    const target = sidebar.commandTarget(null)
    const available = kind === 'terminal'
      ? terminalAvailable
      : kind === 'computer-files' ? filesAvailable : sharedFilesAvailable
    if (target === undefined || !available.getSnapshot()) return
    setComputerTarget(null)
    const active = sidebar.active()
    const existing = active?.kind === kind ? active : sidebar.tabsIn(sessionId).find(tab => tab.kind === kind)
    if (existing === undefined) {
      sidebar.openTabFromTarget(kind, target)
      return
    }
    sidebar.focus(existing.id)
    if (!sidebar.isExpanded()) sidebar.toggleExpanded()
  }
  ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
    scope.effect(() => {
      const sync = (): void => {
        const sessionId = controller.face().reference()?.sessionId
        const selection = workspace.getSnapshot().selectedBotId
        const identity = computerAvailability.identity.getSnapshot()
        const selected = sessionId !== undefined && identity?.id === selection ? identity : undefined
        const terminal = selected?.terminal === true && scope.sidebarRightTabs.get('terminal') !== undefined
        const files = selected?.files === true && scope.sidebarRightTabs.get('computer-files') !== undefined
        const sharedFiles = files && selected?.sharedFiles === true
          && scope.sidebarRightTabs.get('computer-shared-files') !== undefined
        scope.sidebarRight.selectPanelSession(PANEL_ID, terminal || files || sharedFiles ? sessionId : undefined)
        terminalAvailable.set(terminal)
        filesAvailable.set(files)
        sharedFilesAvailable.set(sharedFiles)
      }
      const stops = [workspace.subscribe(sync), computerAvailability.identity.subscribe(sync), scope.sidebarRightTabs.subscribe(sync)]
      sync()
      return () => {
        for (const stop of stops) stop()
        scope.sidebarRight.selectPanelSession(PANEL_ID, undefined)
        terminalAvailable.set(false)
        filesAvailable.set(false)
        sharedFilesAvailable.set(false)
      }
    }, 'ui-bots: selected VPS workspace')
  })
  const rosterReady = controller.load()
  ctx.inject(['inputTriggers'], (scope) => {
    const loadAvatar = (botId: string, avatar: BotAvatar): Promise<string> =>
      controller.face().loadAvatar(botId, avatar)
    const botSource = createBotReferenceSource({
      workspace,
      loadAvatar,
      section: () => scope.locale.bind('bots')('botMentionSection'),
      botLabel: () => scope.locale.bind('bots')('botMentionLabel'),
      ready: rosterReady,
    })
    scope.effect(() => scope.inputTriggers.registerSource(botSource), 'ui-bots: Bot mention')

    const availableFor = (sessionId: string): boolean => {
      const availability = computerAvailability.source.getSnapshot()
      return (availability === 'available' || availability === 'mac') && controller.face().reference()?.sessionId === sessionId
    }
    const source: InputTriggerSource = {
      trigger: '@',
      name: 'computer',
      order: -2,
      showGroupTitle: false,
      candidates({ sessionId }, { query, quoted, drilled }) {
        if (quoted || drilled || !'computer'.startsWith(query.trim().toLowerCase()) || !availableFor(sessionId)) return Promise.resolve([])
        return Promise.resolve([{ name: 'Computer', icon: ComputerGlyph, description: scope.locale.bind('bots')('computerMentionDescription') }])
      },
      onPick({ session: { sessionId }, candidate }) {
        if (candidate.name !== 'Computer' || !availableFor(sessionId)) return undefined
        setComputerTarget(sessionId)
        return { insert: { source: 'computer', ref: '@Computer', label: scope.locale.bind('bots')('computerLabel'), clipboardText: '@Computer' } }
      },
      codec: {
        clipboardText: ref => ref,
        serialize: ref => Promise.resolve(ref),
      },
      openReference({ sessionId }, { ref }) {
        if (ref !== '@Computer' || !availableFor(sessionId)) return false
        setComputerTarget(sessionId)
        return true
      },
    }
    scope.effect(() => scope.inputTriggers.registerSource(source), 'ui-bots: Computer mention')
  })

  ctx.effect(() => {
    let refreshedSession = selectedSessionId()
    const refresh = (force = false): void => {
      const nextSession = selectedSessionId()
      if (!force && nextSession === refreshedSession) return
      refreshedSession = nextSession
      computerAvailability.refresh(nextSession)
    }
    const stopGeneration = connection.generation.subscribe(() => { refresh(true) })
    const stopWorkspace = workspace.subscribe(() => { refresh() })
    refresh(true)
    return () => {
      stopGeneration()
      stopWorkspace()
      computerAvailability.dispose()
    }
  }, 'ui-bots: computer availability')

  ctx.effect(() => {
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: 'bots',
      children: { 'bots.conversation': { kind: 'single', scope: 'session-maybe' } },
      inject: () => {
        const face = controller.face()
        return {
          ...face, computer, setComputerTarget, openWorkspaceTab,
          hooks: {
            ...face.hooks,
            computerAvailability: computerAvailability.source,
            computerIdentity: computerAvailability.identity,
            computerTarget,
            computerSignIn,
            terminalAvailable,
            filesAvailable,
            sharedFilesAvailable,
          },
        }
      },
    }, BotsPanel))
    const disposeConversation = ctx.slots.inject('bots.conversation', () => ctx.slots.register({
      name: 'bots.conversation',
    }, BotsConversation))
    const disposeVaultRequest = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock', id: 'bot-vault-request', order: -1, locale: 'bots',
    }, BotVaultRequestCard))
    const disposeWebsiteLoginRequest = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock', id: 'bot-website-login-request', order: -1, locale: 'bots',
    }, BotWebsiteLoginRequestCard))
    const disposeSignIn = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock', id: 'bot-computer-sign-in', order: -1, locale: 'bots',
      inject: () => ({
        computer,
        openSignIn: (sessionId: string, requestId: string) => {
          if (selectedSessionId() !== sessionId) return
          setComputerTarget(sessionId, { sessionId, requestId, attempt: ++signInAttempt })
        },
      }),
    }, ComputerSignInCard))
    const disposeReplyAvatar = ctx.slots.inject('conversation.bot.reply.avatar', () => ctx.slots.register({
      name: 'conversation.bot.reply.avatar',
      inject: (): BotReplyAvatarFace => {
        const { hooks, loadAvatar } = controller.face()
        return { hooks, loadAvatar }
      },
    }, BotReplyAvatar))
    const disposeSidebar = ctx.slots.inject('sidebar.bots', () => ctx.slots.register({
      name: 'sidebar.bots',
      locale: 'bots',
      inject: () => controller.face(),
    }, BotsRoster))
    const disposeChanged = ctx.remote.$on('bots/changed', () => {
      controller.bumpRoutineRevision()
      void controller.load()
    })
    const disposeScheduleChanged = ctx.remote.$on('schedule/changed', () => { controller.bumpRoutineRevision() })
    void rosterReady
    return () => {
      disposeChanged()
      disposeScheduleChanged()
      disposeVaultRequest()
      disposeWebsiteLoginRequest()
      disposeSignIn()
      disposeSidebar()
      disposeReplyAvatar()
      disposeConversation()
      disposeMain()
      controller.dispose()
    }
  }, 'ui-bots: panel registrations')
}
