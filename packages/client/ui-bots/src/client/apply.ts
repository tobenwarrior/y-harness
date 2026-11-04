/** Registers the Bot roster panel and its explicitly bound Conversation. */

import type { Context } from '@yharness/cordis'
import type { ConnectionHandle } from '@yharness/client-connection/client'
import type {} from '@yharness/api-remotes/client'
import type {} from '@yharness/client-ui-renderer/client'
import type {} from '@yharness/client-ui-sidebar/client'
import type {} from '@yharness/client-ui-conversation/client'
import type {} from '@yharness/client-locale/client'
import type { MainPanelId } from '@yharness/client-ui-layout/client'
import { BotWorkspaceController } from './controller.ts'
import { BotsConversation, BotsPanel, BotsRoster } from './panel.tsx'
import { en, zh } from './locales.ts'
import { createSharedBotsClient } from './shared-client.ts'

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

  ctx.effect(() => {
    const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: 'bots',
      children: { 'bots.conversation': { kind: 'single', scope: 'session-maybe' } },
      inject: () => controller.face(),
    }, BotsPanel))
    const disposeConversation = ctx.slots.inject('bots.conversation', () => ctx.slots.register({
      name: 'bots.conversation',
    }, BotsConversation))
    const disposeSidebar = ctx.slots.inject('sidebar.bots', () => ctx.slots.register({
      name: 'sidebar.bots',
      locale: 'bots',
      inject: () => controller.face(),
    }, BotsRoster))
    const disposeChanged = ctx.remote.$on('bots/changed', () => { void controller.load() })
    void controller.load()
    return () => {
      disposeChanged()
      disposeSidebar()
      disposeConversation()
      disposeMain()
      controller.dispose()
    }
  }, 'ui-bots: panel registrations')
}
