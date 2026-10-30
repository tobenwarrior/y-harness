/** The sidebar's Plugins entry icon; the sidebar owns the button, label, and selected state around it. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@yharness/client-ui-slots'
import { IconSidebarPluginsOutlineRegular } from '@yharness/client-ui-primitives'
import type {} from '@yharness/client-ui-sidebar/client'

/**
 * Render the plugin glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function PluginsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSidebarPluginsOutlineRegular size={size} />
}
