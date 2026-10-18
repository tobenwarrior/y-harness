/** Compound skills update indicator: sidebar badge and update steps panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { CompoundUpdateController } from './controller.ts'
import { en, zh, type CompoundUpdateKey } from './locales.ts'
import { UpdateBadge } from './UpdateBadge.tsx'
import { UpdatePanel } from './UpdatePanel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Compound skills update indicator copy. */
    compoundUpdate: CompoundUpdateKey
  }
}

/** Framework services used by the badge and its panel. */
export const inject = ['slots', 'locale']

/**
 * Register the sidebar-foot badge and the update steps panel.
 * @param ctx - browser plugin context supplied by Cordis.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('compoundUpdate', { en, zh }), 'ui-compound-update: dictionaries')
  const controller = new CompoundUpdateController()
  // Read once per session so the badge is present without a user gesture; the
  // Host caches the reading, so this is one request per app start.
  ctx.effect(() => {
    void controller.refresh()
    return () => { controller.dispose() }
  }, 'ui-compound-update: initial read')
  const face = controller.face()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'compound-update', order: 50, locale: 'compoundUpdate', inject: () => face,
  }, UpdateBadge))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'compound-update.steps', locale: 'compoundUpdate', inject: () => face,
  }, UpdatePanel))
}
