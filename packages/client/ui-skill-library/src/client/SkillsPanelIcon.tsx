/** Skill library glyph; the sidebar owns navigation and selected state. */
import type { ReactNode } from 'react'
import { IconSkillOutlineRegular } from '@yharness/client-ui-primitives'
import type { PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-sidebar/client'

/**
 * Render the established skill icon at the sidebar's requested size.
 * @param props - framework-owned sidebar icon inputs.
 * @returns the skill glyph.
 */
export function SkillsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode { return <IconSkillOutlineRegular size={size} /> }
