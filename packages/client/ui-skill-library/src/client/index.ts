/** Skills main panel and sidebar entry, browser plugin. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SkillLibraryController } from './controller.ts'
import { SkillLibraryPage } from './SkillLibraryPage.tsx'
import { SkillLibraryToast } from './SkillLibraryToast.tsx'
import { SkillsPanelIcon } from './SkillsPanelIcon.tsx'
import { createNavigationStore } from './navigation-store.ts'
import { en, zh, type SkillLibraryKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skill inventory, graph, and maintenance copy. */
    skillLibrary: SkillLibraryKey
  }
}

/** Framework services used by the main panel and Host method callbacks. */
export const inject = ['slots', 'locale', 'remote', 'remote.skillLibrary', 'layout']

/**
 * Register a localized Skills panel without altering session selection.
 * @param ctx - browser plugin context supplied by Cordis.
 */
export function apply(ctx: Context): void {
  const panelId = 'skills' as MainPanelId
  ctx.effect(() => ctx.locale.register('skillLibrary', { en, zh }), 'ui-skill-library: dictionaries')
  const t = ctx.locale.bind('skillLibrary')
  const controller = new SkillLibraryController(ctx.remote.skillLibrary)
  ctx.effect(() => () => { controller.dispose() }, 'ui-skill-library: controller')
  ctx.effect(() => ctx.on('connection/reset', () => {
    if (controller.source.getSnapshot().status !== 'idle') { void controller.refresh(); void controller.refreshLearning() }
  }), 'ui-skill-library: reconnect')
  const face = controller.face()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: 'skillLibrary', store: createNavigationStore(), inject: () => face,
  }, SkillLibraryPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 10, label: () => t('panel'), locale: 'skillLibrary',
  }, SkillsPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'skill-library.notice', locale: 'skillLibrary',
    inject: () => ({ hooks: face.hooks, dismissNotice: face.dismissNotice }),
  }, SkillLibraryToast))
}
