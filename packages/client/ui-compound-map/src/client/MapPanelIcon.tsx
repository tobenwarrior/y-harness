/** Code-map glyph; the sidebar owns navigation and selected state. */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render a dependency-graph mark at the sidebar's requested size.
 * @param props - framework-owned sidebar icon inputs.
 * @returns the code-map glyph.
 */
export function MapPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="M4.2 4.6 7.8 6.2M4.6 5.4l3.2 4.1M11.4 6.6 8.4 10.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    <circle cx="3.6" cy="4.2" r="1.7" fill="currentColor" />
    <circle cx="12.4" cy="5.8" r="1.7" fill="currentColor" />
    <circle cx="7.9" cy="11" r="1.7" fill="currentColor" />
  </svg>
}
