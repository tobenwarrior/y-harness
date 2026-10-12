/** Provider, effort, and processing-tier radio rows share selection and pending feedback. */
import type { ReactNode, Ref } from 'react'
import clsx from 'clsx'
import { IconCheckOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ModelSelect.module.css'

/**
 * Render a selectable value without owning its submission or focus ordering.
 * @param props - localized label, selection state, busy policy, ordered button ref, and selection callback.
 * @returns one radio menu item with pending feedback taking precedence over its check mark.
 */
export function SelectionOption({ buttonRef, label, selected, pending, disabled, onChoose }: {
  buttonRef: Ref<HTMLButtonElement>
  label: string
  selected: boolean
  pending: boolean
  disabled: boolean
  onChoose: () => void
}): ReactNode {
  return <button ref={buttonRef} type="button" role="menuitemradio" aria-checked={selected} title={label}
    className={clsx(css.option, selected && css.selected)} disabled={disabled} onClick={onChoose}>
    <span className={css.optionCopy}><span className={css.modelName}>{label}</span></span>
    <span className={css.check}>
      {pending ? <StateDot state="ongoing" /> : selected ? <IconCheckOutlineRegular /> : null}
    </span>
  </button>
}
