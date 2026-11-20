/** Test one saved routine from its details and follow the exact run in its Bot chat. */

import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@yharness/util-crypto'
import { Button } from '@yharness/client-ui-primitives'
import type { BotRoutineTestRun, BotRoutineTestStatus } from '@yharness/bots/client'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './BotWorkspace.module.css'
import type { BotRoutineTestActions } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

interface BotRoutineTestProps {
  readonly botId: string
  readonly routineId: string
  readonly actions: BotRoutineTestActions
  readonly onViewChat: () => void
  readonly t: Translate
}

const STATUS_POLL_MS = 1_000

const testStatusLabel = {
  queued: 'routineTestQueued',
  running: 'routineTestRunning',
  completed: 'routineTestCompleted',
  failed: 'routineTestFailed',
  canceled: 'routineTestCanceled',
  interrupted: 'routineTestInterrupted',
} as const satisfies Record<BotRoutineTestStatus, string>

function activeStatus(run: BotRoutineTestRun | undefined): 'queued' | 'running' | undefined {
  const status = run?.status
  return status === 'queued' || status === 'running' ? status : undefined
}

/**
 * Render the test action and the latest durable attempt for a selected routine.
 * @param props - The selected routine, its owner, and the mounted Host actions.
 * @returns The controls and status for one routine test.
 */
export function BotRoutineTest({ botId, routineId, actions, onViewChat, t }: BotRoutineTestProps) {
  const actionsRef = useRef(actions)
  const [run, setRun] = useState<BotRoutineTestRun>()
  const [checking, setChecking] = useState(true)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(false)
  const [statusError, setStatusError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const pendingRequest = useRef<string | undefined>(undefined)
  const mounted = useRef(false)
  const watch = useRef(false)

  useEffect(() => { actionsRef.current = actions }, [actions])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      try {
        const value = await actionsRef.current.status(botId, routineId)
        if (!current) return
        setRun(value)
        setStatusError(false)
        watch.current = activeStatus(value) !== undefined
      } catch {
        if (!current) return
        setStatusError(true)
      }
      setChecking(false)
      if (watch.current) timer = setTimeout(() => { void read() }, STATUS_POLL_MS)
    }
    void read()
    return () => {
      current = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [botId, routineId, refresh])

  const start = async (): Promise<void> => {
    setStarting(true)
    setStartError(false)
    const requestId = pendingRequest.current ?? randomUUID()
    pendingRequest.current = requestId
    try {
      const value = await actionsRef.current.start(botId, routineId, requestId)
      if (!mounted.current) return
      setRun(value)
      watch.current = activeStatus(value) !== undefined
      pendingRequest.current = undefined
    } catch {
      if (mounted.current) setStartError(true)
    } finally {
      if (mounted.current) {
        setStarting(false)
        setRefresh(value => value + 1)
      }
    }
  }

  const active = activeStatus(run)
  return (
    <div className={css.routineTest}>
      <div className={css.routineTestActions} aria-live="polite">
        <Button variant="outline" size="sm" disabled={checking || starting || active !== undefined} onClick={() => { void start() }}>
          {starting ? t('routineTestStarting') : t(active === undefined ? 'routineTestRun' : testStatusLabel[active])}
        </Button>
        {run !== undefined && <Button variant="ghost" size="sm" onClick={onViewChat}>{t('routineTestViewChat')}</Button>}
      </div>
      {startError && active === undefined
        ? <span role="alert">{t('routineTestStartError')}</span>
        : statusError
          ? <span role="status">{t('routineTestStatusError')}</span>
          : run !== undefined && active === undefined
            ? <span role="status">{t(testStatusLabel[run.status])}</span>
            : <span>{t('routineTestPermissions')}</span>}
    </div>
  )
}
