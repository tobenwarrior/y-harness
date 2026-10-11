/** The 24-hour clock button used by direct rules and cron builders. */
import type { ReactNode, Ref } from 'react'
import clsx from 'clsx'
import { IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './TaskManagerPage.module.css'

/**
 * Render a clock dialog trigger while its parent owns the picker and focus return.
 * @param props - button identity and ref, localized label, staged time, dialog state, optional hint, and toggle callback.
 * @returns the terminal-marked clock control.
 */
export function ClockTrigger({ buttonRef, id, disabled, label, expanded, descriptionId, value, onToggle }: {
  buttonRef: Ref<HTMLButtonElement>
  id: string
  disabled: boolean
  label: string
  expanded: boolean
  descriptionId?: string | undefined
  value: string
  onToggle: () => void
}): ReactNode {
  return <button ref={buttonRef} id={id} type="button"
    className={clsx(css.ruleInput, css.ruleControl, css.pickerTrigger)} data-yh-terminal="control"
    disabled={disabled} aria-label={label} aria-haspopup="dialog" aria-expanded={expanded}
    aria-describedby={descriptionId} onClick={onToggle}>
    <span>{value}</span>
    <IconClockOutlineRegular className={css.pickerIcon} />
  </button>
}
