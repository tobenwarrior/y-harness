import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconClockOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconTrashOutlineRegular,
  Modal, StateDot, Tag,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotRoutineHistory, BotRoutineManagerActions, BotSummary, BotWorkspaceProps } from './types.ts'
import type { BotEventRoutineResult, BotRoutineView } from '@yharness/bots/client'

type Translate = PropsLocale<'bots'>['t']
type RoutineFilter = 'all' | 'active' | 'paused'
type RoutineTab = 'rule' | 'results'
type HistoryCursor = Extract<BotRoutineHistory, { readonly kind: 'schedule' }>['nextBefore']

/** Props for the selected Bot's routine manager. */
export interface BotRoutineManagerProps {
  /** Selected Bot whose routines are shown. */
  readonly bot: BotSummary
  /** Host-backed owner-scoped routine actions. */
  readonly actions: BotRoutineManagerActions
  /** Whether the manager modal is visible. */
  readonly open: boolean
  /** Close the manager without changing the selected Bot. */
  readonly onClose: () => void
  /** Locale-owned Bot workspace translator. */
  readonly t: Translate
  /** Optional catalog revision emitted by the Host. */
  readonly revision?: number
  /** Optional Bot-owned image loader for the manager identity chip. */
  readonly loadAvatar?: BotWorkspaceProps['loadAvatar']
}

function routineStatus(routine: BotRoutineView): 'active' | 'paused' | 'inactive' {
  return routine.status
}

function statusTone(status: ReturnType<typeof routineStatus>): 'info' | 'neutral' | 'warning' {
  if (status === 'active') return 'info'
  if (status === 'paused') return 'warning'
  return 'neutral'
}

function statusLabel(status: ReturnType<typeof routineStatus>, t: Translate): string {
  switch (status) {
    case 'active': return t('routineActive')
    case 'paused': return t('routinePaused')
    case 'inactive': return t('routineEnded')
  }
}

function sourceLabel(source: 'bot' | 'user', t: Translate): string {
  return source === 'bot' ? t('routineSourceBot') : t('routineSourceUser')
}

function resultStatusLabel(status: BotEventRoutineResult['status'], t: Translate): string {
  switch (status) {
    case 'completed': return t('routineResultCompleted')
    case 'error': return t('routineResultError')
    case 'aborted': return t('routineResultAborted')
    case 'blocked': return t('routineResultBlocked')
    case 'max-tokens': return t('routineResultMaxTokens')
    case 'interrupted': return t('routineResultInterrupted')
    case 'forked': return t('routineResultForked')
    case 'other': return t('routineResultOther')
  }
}

function weekdayLabel(day: number, t: Translate): string {
  switch (day) {
    case 1: return t('routineWeekdayMonday')
    case 2: return t('routineWeekdayTuesday')
    case 3: return t('routineWeekdayWednesday')
    case 4: return t('routineWeekdayThursday')
    case 5: return t('routineWeekdayFriday')
    case 6: return t('routineWeekdaySaturday')
    case 7: return t('routineWeekdaySunday')
    default: return String(day)
  }
}

type RoutineDurationUnit = {
  readonly seconds: number
  readonly singularKey: 'routineDurationDay' | 'routineDurationHour' | 'routineDurationMinute' | 'routineDurationSecond'
  readonly pluralKey: 'routineDurationDays' | 'routineDurationHours' | 'routineDurationMinutes' | 'routineDurationSeconds'
}

const routineDurationUnits: readonly RoutineDurationUnit[] = [
  { seconds: 86_400, singularKey: 'routineDurationDay', pluralKey: 'routineDurationDays' },
  { seconds: 3_600, singularKey: 'routineDurationHour', pluralKey: 'routineDurationHours' },
  { seconds: 60, singularKey: 'routineDurationMinute', pluralKey: 'routineDurationMinutes' },
  { seconds: 1, singularKey: 'routineDurationSecond', pluralKey: 'routineDurationSeconds' },
]

function durationNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const rounded = Number(value.toFixed(12))
  return String(rounded)
}

function formatRoutineInterval(seconds: number, t: Translate, omitSingleUnit: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) return t('routineDurationSeconds', { count: durationNumber(seconds) })
  const parts: string[] = []
  let remaining = seconds
  for (const unit of routineDurationUnits) {
    const count = Math.floor(remaining / unit.seconds)
    if (count === 0) continue
    if (count === 1 && omitSingleUnit && remaining === seconds && seconds === unit.seconds) {
      return t(unit.singularKey)
    }
    parts.push(count === 1
      ? t('routineDurationCount', { count: '1', unit: t(unit.singularKey) })
      : t(unit.pluralKey, { count: durationNumber(count) }))
    remaining = Number((remaining - count * unit.seconds).toFixed(12))
  }
  if (remaining > 0 || parts.length === 0) {
    parts.push(remaining === 1
      ? t('routineDurationCount', { count: '1', unit: t('routineDurationSecond') })
      : t('routineDurationSeconds', { count: durationNumber(remaining) }))
  }
  return parts.join(t('routineDurationJoin'))
}

function scheduleRule(routine: Extract<BotRoutineView, { kind: 'schedule' }>, t: Translate): string {
  switch (routine.scheduleKind) {
    case 'after': return t('routineAfterRule', { interval: formatRoutineInterval(routine.afterSeconds ?? 0, t, false) })
    case 'at': return t('routineAtRule', { value: formatDate(routine.scheduledAt) })
    case 'every': return t('routineEveryRule', { interval: formatRoutineInterval(routine.everySeconds ?? 0, t, true) })
    case 'daily': return t('routineDailyRule', { time: routine.time ?? '', zone: routine.timeZone ?? '' })
    case 'weekly': return t('routineWeeklyRule', {
      days: ('weekdays' in routine ? routine.weekdays as readonly number[] : []).map(day => weekdayLabel(day, t)).join(', '),
      time: routine.time ?? '',
      zone: routine.timeZone ?? '',
    })
    case 'cron': return t('routineCronRule', { expression: routine.expression ?? '', zone: routine.timeZone ?? '' })
    default: return t('routineRuleUnknown')
  }
}

function routineRule(routine: BotRoutineView, t: Translate): string {
  return routine.kind === 'schedule'
    ? scheduleRule(routine, t)
    : t('routineEventRule', { source: sourceLabel(routine.trigger.source, t) })
}

function formatDate(value: string | number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function historyDate(value: string): string {
  return formatDate(value)
}

interface HistoryRowsOptions {
  readonly loadingOlder: boolean
  readonly olderError: boolean
  readonly onLoadOlder: () => void
}

function scheduleHistoryMeta(
  history: Extract<BotRoutineHistory, { readonly kind: 'schedule' }>,
  t: Translate,
  options: HistoryRowsOptions,
): ReactNode {
  return (
    <div className={css.routineHistoryMeta}>
      <span>{t('routineHistoryRetention', { days: String(history.retention.days), records: String(history.retention.records) })}</span>
      {history.earlierRecordsUnavailable && <span>{t('routineHistoryEarlierUnavailable')}</span>}
      {history.earlierRecordsPruned && <span>{t('routineHistoryEarlierPruned')}</span>}
      {options.olderError && <span role="alert">{t('routineHistoryFailed')}</span>}
      {history.nextBefore !== undefined && (
        <Button variant="outline" size="sm" onClick={options.onLoadOlder} disabled={options.loadingOlder}>
          {options.loadingOlder ? t('routineHistoryLoadingOlder') : t('routineHistoryLoadOlder')}
        </Button>
      )}
    </div>
  )
}

function historyRows(history: BotRoutineHistory, t: Translate, options: HistoryRowsOptions): ReactNode {
  if (history.kind === 'schedule') {
    return (
      <div className={css.routineHistoryContent}>
        {history.records.length === 0
          ? <p className={css.routineHistoryEmpty}>{t('routineNoResults')}</p>
          : (
            <ul className={css.routineHistoryList} aria-label={t('routineHistoryLabel')}>
              {history.records.map(record => (
                <li key={String(record.messageId)} className={css.routineHistoryRow}>
                  <strong>{historyDate(record.deliveredAt)}</strong>
                  <span>{record.prompt ?? t('routineLegacyDelivery')}</span>
                </li>
              ))}
            </ul>
          )}
        {scheduleHistoryMeta(history, t, options)}
      </div>
    )
  }
  return (
    <div className={css.routineHistoryContent}>
      <div className={css.routineHistorySection}>
        <strong className={css.routineHistorySectionTitle}>{t('routineHistoryDeliveries')}</strong>
        {history.deliveries.length === 0
          ? <p className={css.routineHistoryEmpty}>{t('routineHistoryNoDeliveries')}</p>
          : (
            <ul className={css.routineHistoryList} aria-label={t('routineHistoryDeliveries')}>
              {history.deliveries.map(delivery => (
                <li key={`delivery:${String(delivery.messageId)}`} className={css.routineHistoryRow}>
                  <strong>{historyDate(delivery.deliveredAt ?? delivery.createdAt)}</strong>
                  <span>{delivery.status === 'delivered' ? t('routineDeliveryDelivered') : t('routineDeliveryPending')}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
      <div className={css.routineHistorySection}>
        <strong className={css.routineHistorySectionTitle}>{t('routineHistoryResults')}</strong>
        {history.results.length === 0
          ? <p className={css.routineHistoryEmpty}>{t('routineHistoryNoResults')}</p>
          : (
            <ul className={css.routineHistoryList} aria-label={t('routineHistoryResults')}>
              {history.results.map(result => (
                <li key={`result:${String(result.messageId)}`} className={css.routineHistoryRow}>
                  <strong>{historyDate(result.completedAt)}</strong>
                  <span>{result.output ?? result.error ?? t('routineNoOutput')}</span>
                  <Tag tone={result.status === 'completed' ? 'success' : 'warning'}>{resultStatusLabel(result.status, t)}</Tag>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

function mergeHistory(current: BotRoutineHistory | null, next: BotRoutineHistory): BotRoutineHistory {
  if (current === null || current.kind !== 'schedule' || next.kind !== 'schedule' || String(current.id) !== String(next.id)) return next
  const seen = new Set(current.records.map(record => String(record.messageId)))
  return {
    ...next,
    records: [...current.records, ...next.records.filter(record => !seen.has(String(record.messageId)))],
    earlierRecordsUnavailable: current.earlierRecordsUnavailable || next.earlierRecordsUnavailable,
    earlierRecordsPruned: current.earlierRecordsPruned || next.earlierRecordsPruned,
  }
}

/** Render a Bot-scoped routine catalog with lifecycle controls and bounded history. */
export function BotRoutineManager({ bot, actions, open, onClose, t, revision = 0, loadAvatar }: BotRoutineManagerProps): ReactNode {
  const [routines, setRoutines] = useState<readonly BotRoutineView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<RoutineFilter>('all')
  const [tab, setTab] = useState<RoutineTab>('rule')
  const [loading, setLoading] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [mutationError, setMutationError] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [history, setHistory] = useState<BotRoutineHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingOlder, setHistoryLoadingOlder] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [historyOlderError, setHistoryOlderError] = useState(false)
  const selectedIdRef = useRef<string | null>(null)
  const filterRef = useRef<RoutineFilter>('all')
  const historyGenerationRef = useRef(0)
  const historyTargetRef = useRef<{ readonly botId: string; readonly routineId: string } | null>(null)
  const openBotIdRef = useRef<string | null>(null)
  const openRef = useRef(false)
  const revisionRef = useRef(revision)
  const tabRef = useRef<RoutineTab>('rule')
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  filterRef.current = filter
  tabRef.current = tab

  const showHistory = async (routine: BotRoutineView, before?: HistoryCursor): Promise<void> => {
    const routineId = String(routine.id)
    const generation = ++historyGenerationRef.current
    historyTargetRef.current = { botId: bot.id, routineId }
    selectedIdRef.current = routineId
    setSelectedId(routineId)
    setTab('results')
    if (before === undefined) {
      setHistory(null)
      setHistoryLoading(true)
      setHistoryError(false)
      setHistoryOlderError(false)
    } else {
      setHistoryLoadingOlder(true)
      setHistoryOlderError(false)
    }
    const isCurrent = (): boolean => historyGenerationRef.current === generation
      && historyTargetRef.current?.botId === bot.id
      && historyTargetRef.current.routineId === routineId
    try {
      const next = before === undefined
        ? await actionsRef.current.history(bot.id, routineId)
        : await actionsRef.current.history(bot.id, routineId, before)
      if (!isCurrent()) return
      setHistory(current => before === undefined ? next : mergeHistory(current, next))
    } catch {
      if (!isCurrent()) return
      if (before === undefined) {
        setHistory(null)
        setHistoryError(true)
      } else {
        setHistoryOlderError(true)
      }
    } finally {
      if (!isCurrent()) return
      if (before === undefined) setHistoryLoading(false)
      else setHistoryLoadingOlder(false)
    }
  }

  useEffect(() => {
    const revisionRefresh = openRef.current && openBotIdRef.current === bot.id && revisionRef.current !== revision
    revisionRef.current = revision
    if (!open) {
      openRef.current = false
      return
    }
    let live = true
    const resetHistory = !openRef.current || openBotIdRef.current !== bot.id
    openRef.current = true
    openBotIdRef.current = bot.id
    if (resetHistory) {
      historyGenerationRef.current++
      historyTargetRef.current = null
      setHistory(null)
      setHistoryError(false)
      setHistoryOlderError(false)
      setHistoryLoading(false)
      setHistoryLoadingOlder(false)
      setTab('rule')
    }
    setLoading(true)
    setLoadError(false)
    setMutationError(false)
    setHistoryError(false)
    setHistoryLoading(false)
    setHistoryLoadingOlder(false)
    setHistoryOlderError(false)
    void actionsRef.current.list(bot.id).then((next) => {
      if (!live) return
      setRoutines(next)
      const current = selectedIdRef.current
      const nextVisible = next.filter(routine => filterRef.current === 'all' || routineStatus(routine) === filterRef.current)
      const nextId = current !== null && nextVisible.some(routine => String(routine.id) === current)
        ? current
        : nextVisible[0]?.id === undefined ? null : String(nextVisible[0].id)
      if (current !== null && current !== nextId) {
        historyGenerationRef.current++
        historyTargetRef.current = null
        setHistory(null)
        setHistoryError(false)
        setHistoryOlderError(false)
        setHistoryLoading(false)
        setHistoryLoadingOlder(false)
        setTab('rule')
      }
      selectedIdRef.current = nextId
      setSelectedId(nextId)
      if (revisionRefresh && current === nextId && nextId !== null && tabRef.current === 'results') {
        const nextRoutine = next.find(routine => String(routine.id) === nextId)
        if (nextRoutine !== undefined) void showHistory(nextRoutine)
      }
    }).catch(() => {
      if (live) {
        setRoutines([])
        selectedIdRef.current = null
        setSelectedId(null)
        historyGenerationRef.current++
        historyTargetRef.current = null
        setHistory(null)
        setHistoryError(false)
        setHistoryOlderError(false)
        setHistoryLoading(false)
        setHistoryLoadingOlder(false)
        setTab('rule')
        setLoadError(true)
      }
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => {
      live = false
      historyGenerationRef.current++
      historyTargetRef.current = null
    }
  }, [bot.id, loadAttempt, open, revision])

  const visible = useMemo(() => routines.filter((routine) => {
    if (filter === 'all') return true
    return routineStatus(routine) === filter
  }), [filter, routines])
  const selected = routines.find(routine => String(routine.id) === selectedId)

  const invalidateHistory = (resetTab = false): void => {
    historyGenerationRef.current++
    historyTargetRef.current = null
    setHistory(null)
    setHistoryError(false)
    setHistoryOlderError(false)
    setHistoryLoading(false)
    setHistoryLoadingOlder(false)
    if (resetTab) setTab('rule')
  }

  useEffect(() => {
    const current = selectedIdRef.current
    const nextId = current !== null && visible.some(routine => String(routine.id) === current)
      ? current
      : visible[0] === undefined ? null : String(visible[0].id)
    if (selectedIdRef.current === nextId) return
    selectedIdRef.current = nextId
    setSelectedId(nextId)
    invalidateHistory(true)
  }, [visible])

  const selectRoutine = (id: string): void => {
    selectedIdRef.current = id
    setSelectedId(id)
    invalidateHistory(true)
  }

  const selectFilter = (nextFilter: RoutineFilter): void => {
    setFilter(nextFilter)
    const nextVisible = routines.filter(routine => nextFilter === 'all' || routineStatus(routine) === nextFilter)
    const currentId = selectedIdRef.current
    if (currentId !== null && nextVisible.some(routine => String(routine.id) === currentId)) return
    const nextId = nextVisible[0] === undefined ? null : String(nextVisible[0].id)
    selectedIdRef.current = nextId
    setSelectedId(nextId)
    invalidateHistory(true)
  }

  const changeStatus = async (routine: BotRoutineView): Promise<void> => {
    if (working !== null || routineStatus(routine) === 'inactive') return
    setWorking(String(routine.id))
    setMutationError(false)
    try {
      const next = routineStatus(routine) === 'active'
        ? await actions.pause(bot.id, String(routine.id))
        : await actions.resume(bot.id, String(routine.id))
      setRoutines(current => current.map(candidate => String(candidate.id) === String(next.id) ? next : candidate))
    } catch {
      setMutationError(true)
    } finally {
      setWorking(current => current === String(routine.id) ? null : current)
    }
  }

  const remove = async (): Promise<void> => {
    if (confirmingId === null || working !== null) return
    const id = confirmingId
    setWorking(id)
    setMutationError(false)
    try {
      await actions.remove(bot.id, id)
      setRoutines(current => current.filter(routine => String(routine.id) !== id))
      if (selectedIdRef.current === id) {
        selectedIdRef.current = null
        setSelectedId(null)
        invalidateHistory(true)
      }
      setConfirmingId(null)
    } catch {
      setMutationError(true)
    } finally {
      setWorking(current => current === id ? null : current)
    }
  }

  const loadOlder = (): void => {
    if (selected?.kind !== 'schedule' || history?.kind !== 'schedule' || history.nextBefore === undefined) return
    void showHistory(selected, history.nextBefore)
  }

  const closeManager = (): void => {
    invalidateHistory()
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        onClose={closeManager}
        title={t('routineManagerTitle')}
        description={t('routineManagerDescription')}
        closeLabel={t('close')}
        className={css.memoryModal as string}
        contentClassName={css.memoryModalContent as string}
        footer={<Button variant="ghost" onClick={closeManager}>{t('close')}</Button>}
      >
        <div className={css.memoryManagerHeading}>
          <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="small" />
          <span><strong>{bot.name}</strong><span>{t('routinePrivateHint')}</span></span>
        </div>
        <div className={css.routineFilters} role="tablist" aria-label={t('routineFiltersLabel')}>
          {(['all', 'active', 'paused'] as const).map(value => (
            <button key={value} type="button" role="tab" aria-selected={filter === value} className={filter === value ? css.routineFilterSelected : css.routineFilter} onClick={() => { selectFilter(value) }}>
              {value === 'all' ? t('routineFilterAll') : value === 'active' ? t('routineFilterActive') : t('routineFilterPaused')}
            </button>
          ))}
        </div>
        {mutationError && <div className={css.memoryNotice} role="alert">{t('routineActionFailed')}</div>}
        {loading && <div className={css.memoryLoading} role="status"><StateDot state="ongoing" size={13} />{t('routineLoading')}</div>}
        {!loading && loadError && (
          <div className={css.memoryEmpty}>
            <p>{t('routineLoadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => { setLoadAttempt(value => value + 1) }}>{t('retry')}</Button>
          </div>
        )}
        {!loading && !loadError && routines.length === 0 && (
          <div className={css.memoryEmpty} role="status"><strong>{t('routineEmptyTitle')}</strong><span>{t('routineEmptyDescription')}</span></div>
        )}
        {!loading && !loadError && routines.length > 0 && visible.length === 0 && (
          <div className={css.memoryEmpty} role="status"><strong>{t('routineFilterEmptyTitle')}</strong><span>{t('routineFilterEmptyDescription')}</span></div>
        )}
        {!loading && !loadError && visible.length > 0 && (
          <div className={css.routineLayout}>
            <ul className={css.routineList} aria-label={t('routineListLabel')}>
              {visible.map((routine) => {
                const id = String(routine.id)
                const status = routineStatus(routine)
                const busy = working === id
                return (
                  <li key={id} className={id === selectedId ? css.routineRowSelected : css.routineRow}>
                    <button type="button" className={css.routineRowSelect} aria-pressed={id === selectedId} onClick={() => { selectRoutine(id) }}>
                      <span className={css.routineRowIcon} aria-hidden="true"><IconClockOutlineRegular size={14} /></span>
                      <span className={css.routineRowCopy}><strong>{routine.title}</strong><span>{routine.kind === 'schedule' ? t('routineTimed') : t('routineEvent')}</span></span>
                      <Tag tone={statusTone(status)}>{statusLabel(status, t)}</Tag>
                    </button>
                    <div className={css.routineRowActions}>
                      {status !== 'inactive' && <Button variant="ghost" size="sm" aria-label={`${status === 'active' ? t('routinePause') : t('routineResume')} ${routine.title}`} icon={status === 'active' ? <IconPauseOutlineRegular size={13} /> : <IconPlayOutlineRegular size={13} />} disabled={busy} onClick={() => { void changeStatus(routine) }} />}
                      <Button variant="ghost" size="sm" aria-label={`${t('routineDelete')} ${routine.title}`} icon={<IconTrashOutlineRegular size={13} />} disabled={busy} onClick={() => { setConfirmingId(id); setMutationError(false) }} />
                      <Button variant="ghost" size="sm" aria-label={`${t('routineViewResults')} ${routine.title}`} onClick={() => { void showHistory(routine) }}>{t('routineResults')}</Button>
                    </div>
                  </li>
                )
              })}
            </ul>
            {selected !== undefined && (
              <section className={css.routineDetail} aria-label={t('routineDetailLabel')}>
                <div className={css.routineDetailTabs} role="tablist" aria-label={t('routineDetailTabsLabel')}>
                  <button type="button" role="tab" aria-selected={tab === 'rule'} className={tab === 'rule' ? css.routineTabSelected : css.routineTab} onClick={() => { setTab('rule') }}>{t('routineRuleTab')}</button>
                  <button type="button" role="tab" aria-selected={tab === 'results'} className={tab === 'results' ? css.routineTabSelected : css.routineTab} onClick={() => { void showHistory(selected) }}>{t('routineResultsTab')}</button>
                </div>
                {tab === 'rule' && <div className={css.routineRule}><strong>{selected.title}</strong><p>{selected.prompt}</p><span>{routineRule(selected, t)}</span></div>}
                {tab === 'results' && (
                  historyLoading
                    ? <div className={css.memoryLoading} role="status"><StateDot state="ongoing" size={13} />{t('routineHistoryLoading')}</div>
                    : historyError
                      ? <div className={css.memoryEmpty} role="alert"><p>{t('routineHistoryFailed')}</p><Button variant="outline" size="sm" onClick={() => { void showHistory(selected) }}>{t('retry')}</Button></div>
                      : history === null ? <div className={css.routineHistoryEmpty}>{t('routineHistoryEmpty')}</div> : historyRows(history, t, {
                        loadingOlder: historyLoadingOlder,
                        olderError: historyOlderError,
                        onLoadOlder: loadOlder,
                      })
                )}
              </section>
            )}
          </div>
        )}
      </Modal>
      <Modal
        open={confirmingId !== null}
        onClose={() => { if (working === null) setConfirmingId(null) }}
        title={t('routineDeleteTitle')}
        description={t('routineDeleteDescription')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setConfirmingId(null) }} disabled={working !== null}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { void remove() }} disabled={working !== null}>
              {working !== null ? t('routineDeleting') : t('routineDeleteConfirm')}
            </Button>
          </>
        )}
      >
        {mutationError && <div className={css.memoryNotice} role="alert">{t('routineDeleteFailed')}</div>}
      </Modal>
    </>
  )
}
