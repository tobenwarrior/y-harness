/** Transient native-session outcomes outlive the Settings page. */
import type { ReactNode } from 'react'
import { Toast, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodingSessionsFace } from './controller.ts'
/** @param props - retained notice, dismissal, and localized copy. @returns settled feedback through the shared shell toast. */
export function CodingSessionsToast({ useSessions, dismissNotice, t }: InjectFace<Pick<CodingSessionsFace, 'hooks' | 'dismissNotice'>> & PropsLocale<'codingSessions'>): ReactNode {
  const notice = useSessions(state => state.notice)
  if (notice === null) return null
  return notice.kind === 'failed' ? <Toast key={notice.seq} text={t(notice.kind)} icon={<IconWarningOutlineRegular />} onDone={dismissNotice} />
    : <Toast key={notice.seq} text={t(notice.kind)} tone="success" onDone={dismissNotice} />
}
