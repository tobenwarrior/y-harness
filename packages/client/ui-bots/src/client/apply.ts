/** Registers the Bot roster panel and its explicitly bound Conversation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { BotWorkspaceController } from './controller.ts'
import { BotsConversation, BotsPanel, BotsRoster } from './panel.tsx'
import { en, zh } from './locales.ts'

/** Stable main-panel identity shared by the sidebar entry and main occupant. */
export const PANEL_ID = 'bots' as MainPanelId

/** Services required by the Bot roster and its Session-backed Conversation. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.bots', 'remote.avatarGeneration', 'sessions',
]

/** Register the Bot workspace, loading one durable roster and one Session per selection. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('bots', { en, zh }), 'ui-bots: dictionaries')
  const controller = new BotWorkspaceController(
    ctx.remote.bots,
    ctx.sessions,
    () => ctx.locale.bind('bots')('unexpectedResponse'),
    ctx.remote.avatarGeneration,
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
