/** Session-scoped Computer viewer and human-control surface. */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import {
  Button, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, StateDot, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { randomUUID } from '@yharness/util-crypto'
import { ComputerApiError, type ComputerClient, type ComputerFrame, type ComputerInputAction, type ComputerMode } from './computer-client.ts'
import css from './ComputerPanel.module.css'

/** Private desktop client and panel dismissal. */
interface ComputerPanelProps extends PropsLocale<'bots'> {
  readonly computer: ComputerClient
  readonly close: () => void
  readonly local?: { readonly checkSharing: () => void }
}

type PanelPhase = 'loading' | 'ready' | 'disconnected' | 'unavailable'
type BusyAction = 'take' | 'release' | undefined
type FeedbackKey = 'computerControlBusy' | 'computerInputRejected' | 'computerPasteFailed' | 'computerTextTrimmed'

const FRAME_POLL_MS = 300
const MAX_TEXT_LENGTH = 4_096
const DRAG_THRESHOLD = 4
const MAX_QUEUED_INPUTS = 64

const X11_KEY_NAMES: Readonly<Record<string, string>> = {
  ' ': 'space',
  Enter: 'Return',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  CapsLock: 'Caps_Lock',
  NumLock: 'Num_Lock',
  ScrollLock: 'Scroll_Lock',
  PrintScreen: 'Print',
  ContextMenu: 'Menu',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function x11Key(event: ReactKeyboardEvent<HTMLImageElement>): string | undefined {
  if (event.key === 'Dead' || event.key === 'Unidentified') return event.code || undefined
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.metaKey) modifiers.push('Super')
  const key = X11_KEY_NAMES[event.key] ?? event.key
  return [...modifiers, key].join('+')
}

function pointerButton(button: number): 1 | 2 | 3 {
  if (button === 0) return 1
  if (button === 1) return 2
  return 3
}

function coordinateOf(
  clientX: number,
  clientY: number,
  element: HTMLImageElement,
  frame: ComputerFrame,
): { readonly x: number; readonly y: number } | undefined {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  if (!Number.isFinite(scale) || scale <= 0) return undefined
  const insetX = (rect.width - frame.width * scale) / 2
  const insetY = (rect.height - frame.height * scale) / 2
  return {
    x: clamp(Math.round((clientX - rect.left - insetX) / scale), 0, frame.width - 1),
    y: clamp(Math.round((clientY - rect.top - insetY) / scale), 0, frame.height - 1),
  }
}

function waitForNextFrame(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => { finish(false) }
    const timer = setTimeout(() => { finish(true) }, FRAME_POLL_MS)
    if (signal.aborted) finish(false)
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function stateFor(phase: PanelPhase, mode: ComputerMode, botActive: boolean): 'ongoing' | 'idle' | 'done' | 'warning' | 'error' {
  if (phase === 'loading') return 'ongoing'
  if (phase === 'disconnected' || phase === 'unavailable') return 'error'
  if (botActive || mode === 'other') return 'warning'
  if (mode === 'controlling') return 'done'
  return 'idle'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function imageErrorPhase(error: unknown): PanelPhase {
  return error instanceof ComputerApiError && error.status === 404 ? 'unavailable' : 'disconnected'
}

/** Render the Computer tab's image, lease controls, and bounded input affordances. */
export function ComputerPanel({ computer, close, local, t }: ComputerPanelProps): ReactNode {
  const viewerIdRef = useRef<string>()
  if (viewerIdRef.current === undefined) viewerIdRef.current = randomUUID()
  const viewerId = viewerIdRef.current
  const frameRef = useRef<ComputerFrame>()
  const modeRef = useRef<ComputerMode>('watching')
  const disposedRef = useRef(false)
  const requestEpochRef = useRef(0)
  const operationRef = useRef(0)
  const inputQueue = useRef(Promise.resolve())
  const queuedInputs = useRef(0)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const pointerRef = useRef<{
    readonly pointerId: number
    readonly button: 1 | 2 | 3
    readonly x: number
    readonly y: number
    readonly clientX: number
    readonly clientY: number
  }>()
  const [frame, setFrame] = useState<ComputerFrame>()
  const [mode, setMode] = useState<ComputerMode>('watching')
  const [botActive, setBotActive] = useState(false)
  const [phase, setPhase] = useState<PanelPhase>('loading')
  const [busy, setBusy] = useState<BusyAction>()
  const [feedback, setFeedback] = useState<FeedbackKey>()
  const [retryNonce, setRetryNonce] = useState(0)

  frameRef.current = frame

  const applyMode = (next: ComputerMode): void => {
    modeRef.current = next
    setMode(next)
  }

  useEffect(() => {
    disposedRef.current = false
    const release = (): void => {
      disposedRef.current = true
      ++requestEpochRef.current
      ++operationRef.current
      if (modeRef.current !== 'controlling') return
      modeRef.current = 'watching'
      void computer.releaseControl(viewerId, { keepalive: true }).catch((error: unknown) => {
        console.warn('Computer lease release failed:', error)
      })
    }
    return release
  }, [computer, viewerId])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const poll = async (): Promise<void> => {
      if (frameRef.current === undefined) setPhase('loading')
      while (!disposed && !controller.signal.aborted) {
        const requestEpoch = requestEpochRef.current
        try {
          const next = await computer.frame(viewerId, controller.signal)
          if (disposed || controller.signal.aborted || requestEpoch !== requestEpochRef.current) continue
          setFrame(next)
          frameRef.current = next
          applyMode(next.mode)
          setBotActive(next.botActive)
          setPhase('ready')
          setFeedback(undefined)
        } catch (error: unknown) {
          if (disposed || controller.signal.aborted || isAbortError(error)) return
          if (requestEpoch !== requestEpochRef.current) continue
          setPhase(imageErrorPhase(error))
          local?.checkSharing()
          return
        }
        if (!await waitForNextFrame(controller.signal)) return
      }
    }
    void poll()
    return () => { disposed = true; controller.abort() }
  }, [computer, local, retryNonce, viewerId])

  const alive = (operation: number): boolean => !disposedRef.current && operation === operationRef.current

  const takeControl = (): void => {
    if (busy !== undefined || phase === 'unavailable') return
    const operation = ++operationRef.current
    ++requestEpochRef.current
    setBusy('take')
    setFeedback(undefined)
    void computer.takeControl(viewerId).then((result) => {
      if (!alive(operation)) {
        if (result.mode === 'controlling') void computer.releaseControl(viewerId, { keepalive: true }).catch((error: unknown) => { void error })
        return
      }
      applyMode(result.mode)
      setBusy(undefined)
      if (result.mode !== 'controlling') setFeedback('computerControlBusy')
    }).catch((error: unknown) => {
      if (!alive(operation)) return
      setBusy(undefined)
      if (error instanceof ComputerApiError && error.status === 409) {
        applyMode('other')
        setFeedback('computerControlBusy')
      } else if (error instanceof ComputerApiError && error.status === 404) {
        setPhase('unavailable')
      } else {
        setPhase('disconnected')
      }
    })
  }

  const releaseControl = (): void => {
    if (busy !== undefined || modeRef.current !== 'controlling') return
    const operation = ++operationRef.current
    ++requestEpochRef.current
    setBusy('release')
    setFeedback(undefined)
    void inputQueue.current.then(() => computer.releaseControl(viewerId)).then((result) => {
      if (!alive(operation)) return
      applyMode(result.mode)
      setBusy(undefined)
    }).catch((error: unknown) => {
      if (!alive(operation)) return
      setBusy(undefined)
      setFeedback(error instanceof ComputerApiError && error.status === 404 ? 'computerInputRejected' : 'computerControlBusy')
    })
  }

  const sendAction = (action: ComputerInputAction): void => {
    if (local !== undefined || busy !== undefined || modeRef.current !== 'controlling' || phase !== 'ready'
      || queuedInputs.current >= MAX_QUEUED_INPUTS) return
    queuedInputs.current++
    inputQueue.current = inputQueue.current.then(async () => {
      if (disposedRef.current || modeRef.current !== 'controlling') return
      try {
        await computer.input(viewerId, action)
      } catch (error: unknown) {
        if (disposedRef.current) return
        if (error instanceof ComputerApiError && error.status === 409) {
          applyMode('other')
          setFeedback('computerControlBusy')
        } else if (error instanceof ComputerApiError && error.status === 404) {
          setPhase('unavailable')
        } else {
          setFeedback('computerInputRejected')
        }
      }
    }).finally(() => { queuedInputs.current-- })
  }

  const sendText = (value: string): void => {
    if (value === '') return
    const bounded = value.slice(0, MAX_TEXT_LENGTH)
    sendAction({ kind: 'text', text: bounded })
    if (bounded.length !== value.length) setFeedback('computerTextTrimmed')
  }

  const paste = (): void => {
    if (modeRef.current !== 'controlling' || navigator.clipboard === undefined) {
      setFeedback('computerPasteFailed')
      return
    }
    void navigator.clipboard.readText().then(sendText).catch((error: unknown) => {
      console.warn('Computer clipboard read failed:', error)
      setFeedback('computerPasteFailed')
    })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const current = frameRef.current
    if (current === undefined || modeRef.current !== 'controlling' || busy !== undefined) return
    const point = coordinateOf(event.clientX, event.clientY, event.currentTarget, current)
    if (point === undefined) return
    event.preventDefault()
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = {
      pointerId: event.pointerId, button: pointerButton(event.button), ...point,
      clientX: event.clientX, clientY: event.clientY,
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const start = pointerRef.current
    const current = frameRef.current
    pointerRef.current = undefined
    if (start === undefined || current === undefined || start.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const point = coordinateOf(event.clientX, event.clientY, event.currentTarget, current)
    if (point === undefined) return
    const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > DRAG_THRESHOLD
    if (moved) sendAction({ kind: 'drag', x: start.x, y: start.y, toX: point.x, toY: point.y })
    else sendAction({ kind: 'click', x: point.x, y: point.y, button: start.button })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLImageElement>): void => {
    if (modeRef.current !== 'controlling' || busy !== undefined || (event.key.toLowerCase() === 'v' && (event.ctrlKey || event.metaKey))) return
    const key = x11Key(event)
    if (key === undefined) return
    event.preventDefault()
    sendAction({ kind: 'key', key })
  }

  const onPaste = (event: ReactClipboardEvent<HTMLImageElement>): void => {
    if (modeRef.current !== 'controlling') return
    event.preventDefault()
    sendText(event.clipboardData.getData('text'))
  }

  const onWheel = (event: ReactWheelEvent<HTMLImageElement>): void => {
    const current = frameRef.current
    if (current === undefined || modeRef.current !== 'controlling' || busy !== undefined) return
    const point = coordinateOf(event.clientX, event.clientY, event.currentTarget, current)
    if (point === undefined) return
    const raw = Math.round(event.deltaY / 100)
    const delta = clamp(raw === 0 ? Math.sign(event.deltaY) : raw, -10, 10)
    if (delta === 0) return
    event.preventDefault()
    sendAction({ kind: 'scroll', x: point.x, y: point.y, delta })
  }

  const status = phase === 'loading'
    ? t('computerLoading')
    : phase === 'unavailable'
      ? t('computerUnavailable')
      : phase === 'disconnected'
        ? t('computerDisconnected')
        : botActive
          ? t('computerBotActive')
          : mode === 'controlling'
            ? t('computerControlling')
            : mode === 'other'
              ? t('computerOtherController')
              : t('computerWatching')
  const hasFrame = frame !== undefined
  const frameSource = frame === undefined ? undefined : `data:image/jpeg;base64,${frame.jpeg}`

  return (
    <section className={css.root} aria-label={t('computerTitle')} data-computer-panel>
      <header className={css.toolbar}>
        <div className={css.status} role="status" aria-live="polite">
          <StateDot state={stateFor(phase, mode, botActive)} size={8} />
          <span>{status}</span>
        </div>
        <div className={css.controls}>
          {phase === 'disconnected' && <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { setRetryNonce(value => value + 1) }}>{t('computerRetry')}</Button>}
          {mode === 'controlling'
            ? <Button variant="outline" size="sm" disabled={busy !== undefined} icon={<IconStopFillRegular size={14} />} onClick={releaseControl}>{t('computerHandBack')}</Button>
            : <Button variant="primary" size="sm" disabled={busy !== undefined || phase === 'unavailable'} onClick={takeControl}>{t('computerTakeControl')}</Button>}
          {local !== undefined
            ? <Button variant="ghost" size="sm" icon={<IconStopFillRegular size={14} />} onClick={close}>{t('macComputerStop')}</Button>
            : <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={14} />} aria-label={t('computerClose')} onClick={close} />}
        </div>
      </header>
      {feedback !== undefined && <div className={css.notice} role="alert">{t(feedback)}</div>}
      <div className={css.viewport} data-computer-viewport>
        {hasFrame && frameSource !== undefined
          ? <img
            ref={imageRef}
            className={css.screen}
            src={frameSource}
            alt={t('computerScreenAlt')}
            draggable={false}
            tabIndex={local === undefined ? 0 : undefined}
            onContextMenu={(event: ReactMouseEvent<HTMLImageElement>) => { if (local === undefined && modeRef.current === 'controlling') event.preventDefault() }}
            onPointerDown={local === undefined ? onPointerDown : undefined}
            onPointerUp={local === undefined ? onPointerUp : undefined}
            onKeyDown={local === undefined ? onKeyDown : undefined}
            onPaste={local === undefined ? onPaste : undefined}
            onWheel={local === undefined ? onWheel : undefined}
          />
          : <div className={css.empty}>
            <StateDot state={phase === 'loading' ? 'ongoing' : 'error'} size={14} />
            <p>{status}</p>
            {phase === 'disconnected' && <Button variant="outline" size="sm" onClick={() => { setRetryNonce(value => value + 1) }}>{t('computerRetry')}</Button>}
          </div>}
      </div>
      <footer className={css.footer}>
        <span>{local !== undefined
          ? t(mode === 'controlling' ? 'macComputerPaused' : 'macComputerShared')
          : t(mode === 'controlling' ? 'computerInputHint' : 'computerWatchHint')}</span>
        {local === undefined && <Tooltip label={t('computerPaste')} side="top" delayMs={500}>
          <Button variant="ghost" size="sm" disabled={mode !== 'controlling' || busy !== undefined} onClick={paste}>{t('computerPaste')}</Button>
        </Tooltip>}
      </footer>
    </section>
  )
}

type ReactClipboardEvent<T> = import('react').ClipboardEvent<T>
