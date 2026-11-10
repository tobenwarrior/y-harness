/** Session-header entry point for the Computer side panel. */

import type { ReactNode } from 'react'
import { Button, Tooltip, type IconProps } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'

/** Bot header control for showing or hiding the private desktop. */
interface ComputerActionProps extends PropsLocale<'bots'> {
  readonly expanded: boolean
  readonly toggle: () => void
}

/** Draw the Computer glyph in the toolbar and mention menu. */
export function ComputerGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" aria-hidden="true" className={className}>
      <rect x="1.5" y="2.4" width="13" height="8.8" rx="2" />
      <path d="M8 11.2v2.4m-2.7 0h5.4M4.3 7.5l1.6-1.6 1.2 1.2 1.6-1.6" />
    </svg>
  )
}

/** Render the opener only after the Host has advertised Computer availability. */
export function ComputerAction({ expanded, toggle, t }: ComputerActionProps): ReactNode {
  return (
    <Tooltip label={t(expanded ? 'computerClose' : 'computerOpen')} side="bottom" delayMs={500}>
      <Button
        variant="toolbar"
        size="sm"
        icon={<ComputerGlyph />}
        aria-label={t(expanded ? 'computerClose' : 'computerOpen')}
        aria-pressed={expanded}
        onClick={toggle}
      >
        {t('computerLabel')}
      </Button>
    </Tooltip>
  )
}
