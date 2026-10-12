/** Operation feedback hosted outside the Skills panel lifetime. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillLibraryFace } from './controller.ts'

/** Only notices and their dismissal are exposed to the shell overlay. */
export type SkillLibraryToastFace = Pick<SkillLibraryFace, 'hooks' | 'dismissNotice'>

/**
 * Display a successful or refused operation after navigation leaves the panel.
 * @param props - controller notice hook, dismissal callback, and localized copy.
 * @returns the shared toast or nothing when no operation has settled.
 */
export function SkillLibraryToast({ useLibrary, dismissNotice, t }: InjectFace<SkillLibraryToastFace> & PropsLocale<'skillLibrary'>): ReactNode {
  const notice = useLibrary(state => state.notice)
  if (notice === null) return null
  const text = t(notice.kind)
  return notice.kind === 'actionError'
    ? <Toast key={notice.seq} text={text} icon={<IconWarningOutlineRegular />} onDone={dismissNotice} />
    : <Toast key={notice.seq} text={text} tone="success" onDone={dismissNotice} />
}
