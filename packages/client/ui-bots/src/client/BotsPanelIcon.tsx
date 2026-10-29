/** Bot workspace glyph for the existing global sidebar panel list. */
import type { ReactNode } from 'react'
import { IconAgentPresetOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the agent glyph at the sidebar-requested size.
 * @param props - framework-provided size and selection state.
 * @returns the bot workspace glyph.
 */
export function BotsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconAgentPresetOutlineRegular size={size} />
}
