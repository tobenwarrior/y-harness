/** Code-map glyph; the sidebar owns navigation and selected state. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@yharness/client-ui-slots'
import { IconSidebarCodeMapOutlineRegular } from '@yharness/client-ui-primitives'
import type {} from '@yharness/client-ui-sidebar/client'

/**
 * Render a dependency-graph mark at the sidebar's requested size.
 * @param props - framework-owned sidebar icon inputs.
 * @returns the code-map glyph.
 */
export function MapPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconSidebarCodeMapOutlineRegular size={size} />
}
