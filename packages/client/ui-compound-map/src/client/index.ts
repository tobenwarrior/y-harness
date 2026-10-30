/** Compound code-map panel and its sidebar entry. */
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/client-locale/client'
import type { MainPanelId } from '@yharness/client-ui-layout/client'
import type {} from '@yharness/client-ui-renderer/client'
import type {} from '@yharness/client-ui-sidebar/client'
import { MapPanel } from './MapPanel.tsx'
import { MapPanelIcon } from './MapPanelIcon.tsx'
import { en, type CompoundMapKey } from './locales.ts'

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Compound code-map copy. */
    compoundMap: CompoundMapKey
  }
}

/** Framework services used by the panel and its sidebar entry. */
export const inject = ['slots', 'locale']

/**
 * Register the code map below the Skills panel and the panel body it opens.
 * @param ctx - browser plugin context supplied by Cordis.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('compoundMap', { en }), 'ui-compound-map: dictionaries')
  const t = ctx.locale.bind('compoundMap')
  const panelId = 'code-map' as MainPanelId
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: 'compoundMap',
  }, MapPanel))
  // Skills registers at 10; the map sits directly below it.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 11, label: () => t('panel'), locale: 'compoundMap',
  }, MapPanelIcon))
}
