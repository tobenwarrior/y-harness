/**
 * Visual body of one inline reference chip: the DecoratorNode's React
 * face. Pure display — identity, invalidation, and lifecycle live on the
 * ReferenceChipNode; this component renders whatever the node carries.
 */
import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ReferenceIconRegular } from '@yharness/client-ui-primitives'
import type { ReferenceIconKind } from '@yharness/client-ui-primitives'
import css from './ReferenceChip.module.css'
import referenceCss from './composer-editor.module.css'

/** Display inputs of one chip (the node's cached owner projections). */
export interface ReferenceChipProps {
  readonly label: string
  /** Domain glyph; absent renders the trigger marker instead of an icon. */
  readonly appearance?: ReferenceIconKind | undefined
  /** Source-owned icon displayed in place of the domain glyph. */
  readonly icon?: ReactNode
  /** Owner-resolution failure styling bit. */
  readonly invalid: boolean
}

/**
 * Render one inline reference chip.
 * @param props - label, optional domain glyph, and the invalid bit.
 * @returns the chip body (icon + truncating label).
 */
export function ReferenceChip({ label, appearance, icon, invalid }: ReferenceChipProps): ReactNode {
  return (
    <span className={clsx(referenceCss.reference, css.chip, appearance === 'file' && !invalid && referenceCss.openable, invalid && css.invalid)} title={label}>
      {icon === undefined
        ? appearance === undefined
          ? <span className={css.marker} aria-hidden>@</span>
          : <ReferenceIconRegular kind={appearance} size={14} className={css.icon} />
        : <span className={css.icon} aria-hidden>{icon}</span>}
      <span className={css.label}>{label}</span>
    </span>
  )
}
