// @vitest-environment jsdom
import type { ComponentType } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IconSidebarAutomationOutlineMedium, IconSidebarAutomationOutlineRegular,
  IconSidebarBotAddOutlineMedium, IconSidebarBotAddOutlineRegular,
  IconSidebarBotsOutlineMedium, IconSidebarBotsOutlineRegular,
  IconSidebarCodeMapOutlineMedium, IconSidebarCodeMapOutlineRegular,
  IconSidebarCodeOutlineMedium, IconSidebarCodeOutlineRegular,
  IconSidebarCollapseOutlineMedium, IconSidebarCollapseOutlineRegular,
  IconSidebarFilterOutlineMedium, IconSidebarFilterOutlineRegular,
  IconSidebarNewSessionOutlineMedium, IconSidebarNewSessionOutlineRegular,
  IconSidebarPluginsOutlineMedium, IconSidebarPluginsOutlineRegular,
  IconSidebarSearchOutlineMedium, IconSidebarSearchOutlineRegular,
  IconSidebarSettingsOutlineMedium, IconSidebarSettingsOutlineRegular,
  IconSidebarSkillsOutlineMedium, IconSidebarSkillsOutlineRegular,
  IconSidebarWorkspaceAddOutlineMedium, IconSidebarWorkspaceAddOutlineRegular,
  IconSidebarWorkspaceFolderOpenOutlineMedium, IconSidebarWorkspaceFolderOpenOutlineRegular,
  IconSidebarWorkspaceFolderOutlineMedium, IconSidebarWorkspaceFolderOutlineRegular,
} from '../src/icons/sidebar-artwork.tsx'
import type { IconProps } from '../src/icons/props.ts'

afterEach(cleanup)

describe('sidebar artwork icon family', () => {
  it('keeps every primary mark distinct on the shared 16-unit grid', () => {
    const regularIcons: readonly ComponentType<IconProps>[] = [
      IconSidebarCodeOutlineRegular, IconSidebarBotsOutlineRegular, IconSidebarPluginsOutlineRegular,
      IconSidebarSkillsOutlineRegular, IconSidebarAutomationOutlineRegular, IconSidebarCodeMapOutlineRegular,
      IconSidebarNewSessionOutlineRegular, IconSidebarCollapseOutlineRegular, IconSidebarSearchOutlineRegular,
      IconSidebarFilterOutlineRegular, IconSidebarWorkspaceFolderOutlineRegular,
      IconSidebarWorkspaceFolderOpenOutlineRegular, IconSidebarWorkspaceAddOutlineRegular,
      IconSidebarBotAddOutlineRegular, IconSidebarSettingsOutlineRegular,
    ]
    const mediumIcons: readonly ComponentType<IconProps>[] = [
      IconSidebarCodeOutlineMedium, IconSidebarBotsOutlineMedium, IconSidebarPluginsOutlineMedium,
      IconSidebarSkillsOutlineMedium, IconSidebarAutomationOutlineMedium, IconSidebarCodeMapOutlineMedium,
      IconSidebarNewSessionOutlineMedium, IconSidebarCollapseOutlineMedium, IconSidebarSearchOutlineMedium,
      IconSidebarFilterOutlineMedium, IconSidebarWorkspaceFolderOutlineMedium,
      IconSidebarWorkspaceFolderOpenOutlineMedium, IconSidebarWorkspaceAddOutlineMedium,
      IconSidebarBotAddOutlineMedium, IconSidebarSettingsOutlineMedium,
    ]
    const variants = [
      ...regularIcons.map(Icon => ({ Icon, strokeWidth: '1' })),
      ...mediumIcons.map(Icon => ({ Icon, strokeWidth: '1.3' })),
    ]
    const { container } = render(<>{variants.map(({ Icon }, index) => <Icon key={index} size={18} />)}</>)
    const svgs = [...container.querySelectorAll('svg')]
    expect(svgs).toHaveLength(variants.length)
    expect(new Set(svgs.slice(0, regularIcons.length).map(svg => svg.innerHTML)).size).toBe(regularIcons.length)
    for (const [index, svg] of svgs.entries()) {
      expect(svg.getAttribute('width')).toBe('18')
      expect(svg.getAttribute('height')).toBe('18')
      expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
      expect(svg.getAttribute('stroke-width')).toBe(variants[index]?.strokeWidth)
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('focusable')).toBe('false')
    }
  })
})
