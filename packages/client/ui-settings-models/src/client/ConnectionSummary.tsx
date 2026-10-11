/** Collapsed native-provider cards expose identity and connection status without actions. */
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './ModelsSection.module.css'

/**
 * Render a native provider's collapsed connection summary.
 * @param props - localized provider and status labels plus the observed connection state.
 * @returns a non-interactive row with the corresponding status tone.
 */
export function ConnectionSummary({ title, connected, status }: {
  title: string
  connected: boolean
  status: string
}): ReactNode {
  return <div className={styles['rowCard']}>
    <div className={styles['rowHead']}>
      <span className={styles['rowIdentity']}>
        <span className={styles['rowName']}>{title}</span>
        <Tag tone={connected ? 'success' : 'outline'}>{status}</Tag>
      </span>
    </div>
  </div>
}
