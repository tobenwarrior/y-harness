/** Native coding-session Settings registration owns its source operations and copy. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CodingSessionsController } from './controller.ts'
import { CodingSessionsSection } from './CodingSessionsSection.tsx'
import { CodingSessionsToast } from './CodingSessionsToast.tsx'
import { en, zh, type CodingSessionsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { codingSessions: CodingSessionsKey } }
/** Services for source actions and settings-slot registration. */
export const inject = ['slots', 'locale', 'remote', 'remote.codingSessions']
/** @param ctx - owning browser plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('codingSessions', { en, zh }), 'ui-settings-coding-sessions: dictionaries')
  const t = ctx.locale.bind('codingSessions')
  const controller = new CodingSessionsController(ctx.remote.codingSessions)
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-coding-sessions: controller')
  ctx.effect(() => ctx.on('connection/reset', () => { controller.reconnect() }), 'ui-settings-coding-sessions: reconnect')
  const face = controller.face()
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'coding-sessions', order: 18, label: () => t('nav'), locale: 'codingSessions', inject: () => face }, CodingSessionsSection))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'coding-sessions.notice', locale: 'codingSessions', inject: () => ({ hooks: face.hooks, dismissNotice: () => { face.dismissNotice() } }) }, CodingSessionsToast))
}
