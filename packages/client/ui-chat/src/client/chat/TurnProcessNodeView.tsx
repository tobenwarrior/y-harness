import { memo, useState } from 'react'
import { IconChevronDownOutlineRegular } from '@yharness/client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { formatRunDuration } from './message-chrome.ts'
import a11yCss from './accessibility.module.css'
import css from './TurnProcessNodeView.module.css'

/** Settled Turn duration and process disclosure above its content. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, bot, t,
}: ChatNodeViewProps<'turn-process'>) {
  // A process-less Bot turn still gets a local duration disclosure. It cannot
  // use the shared process owner because there is no hidden process content to
  // drive that owner's open state.
  const [localOpen, setLocalOpen] = useState(false)
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  const open = !turnProcess.foldable || turnProcess.open
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn?.status !== 'closed') return null
  const reason = turn.end?.data.reason.kind
  const elapsedMs = turn.start === undefined || turn.end === undefined ? undefined
    : Math.max(1000, turn.end.time - turn.start.time)
  const duration = elapsedMs === undefined || reason === 'aborted' || reason === 'error' ? undefined
    : formatRunDuration(elapsedMs, t)
  const successful = reason !== 'aborted' && reason !== 'error'
  const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)
  const localDisclosure = bot !== undefined && successful && !canCollapse && duration !== undefined
  const canReveal = canCollapse || localDisclosure
  const expanded = localDisclosure ? localOpen : open
  // Other end reasons retain elapsed time; only cancellation and failure replace it.
  const label = reason === 'aborted' ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : duration === undefined ? t('message.turnProcess.worked')
        : t('message.turnProcess.took')
  const announcement = reason === 'aborted' ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : t('message.turnProcess.worked')
  const compactActivity = bot !== undefined && canReveal && !expanded
  return (
    <>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <button
        type="button"
        className={css.root}
        data-open={expanded || undefined}
        data-turn-process={node.data.turn}
        data-turn-process-messages={node.data.messageCount}
        data-turn-process-tool-calls={node.data.toolCallCount}
        data-turn-process-subagents={node.data.subagentCount}
        disabled={!canReveal}
        aria-expanded={canReveal ? expanded : turnProcess.hasContent ? open : undefined}
        onClick={(event) => {
          event.currentTarget.focus()
          if (canCollapse) turnProcess.setOpen(!open)
          else if (localDisclosure) setLocalOpen(!localOpen)
        }}
      >
        <span className={css.label}>
          {compactActivity ? t('message.turnProcess.activity') : label}
          {!compactActivity && duration?.map((part, index) => (
            <span key={index} className={part.numeric ? css.durationNumber : undefined}>{part.text}</span>
          ))}
        </span>
        {canReveal && <IconChevronDownOutlineRegular className={css.chevron} />}
      </button>
    </>
  )
})
