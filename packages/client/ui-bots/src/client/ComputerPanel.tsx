/** Session-scoped Computer viewer and human-control surface. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import {
  Button, IconCloseOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, Input, StateDot, Switch, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { randomUUID } from '@yharness/util-crypto'
import {
  ComputerApiError, type ComputerClient, type ComputerFrame, type ComputerInputAction, type ComputerMode, type ComputerStatus,
} from './computer-client.ts'
import css from './ComputerPanel.module.css'

/** Private desktop client and panel dismissal. */
interface ComputerPanelProps extends PropsLocale<'bots'> {
  readonly computer: ComputerClient
  readonly sessionId?: string
  /** Roster Bot id returned by Computer status for the selected Session. */
  readonly botId?: string
  readonly close: () => void
  readonly refreshAvailability?: (sessionId?: string) => void
  readonly local?: { readonly checkSharing: () => void }
  readonly signIn?: {
    readonly requestId: string
    readonly attempt: number
    readonly targetSessionId?: string
    readonly origin?: string
  } | undefined
}

type PanelPhase = 'loading' | 'ready' | 'disconnected' | 'unavailable'
type BusyAction = 'take' | 'release' | undefined
type FeedbackKey = 'computerControlBusy' | 'computerInputRejected' | 'computerPasteFailed' | 'computerTextTrimmed' | 'computerSignInError' | 'computerNavigationFailed' | 'computerNetworkBusy' | 'computerNetworkError' | 'computerRestartBusy' | 'computerRestartError' | 'computerSharedWorkspaceBusy' | 'computerSharedWorkspaceError'

const FRAME_POLL_MS = 300
const MAX_TEXT_LENGTH = 4_096
const DRAG_THRESHOLD = 4
const MAX_QUEUED_INPUTS = 64

const X11_KEY_NAMES: Readonly<Record<string, string>> = {
  ' ': 'space',
  '+': 'plus',
  '"': 'quotedbl',
  '{': 'braceleft',
  '}': 'braceright',
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
  if (event.shiftKey && (event.key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey)) modifiers.push('Shift')
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
    signal.addEventListener('abort', onAbort, { once: true })
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

/**
 * Render the live Computer with input scoped to its current client and Session.
 * @param props - The Computer client, selected Session, and localized controls.
 * @returns The Computer panel.
 */
export function ComputerPanel({ computer, signIn, ...props }: ComputerPanelProps): ReactNode {
  const [view, setView] = useState<ComputerView>()
  const desktop = view === 'desktop' && signIn === undefined ? computer.desktop : undefined
  const select = computer.desktop === undefined || signIn !== undefined ? undefined : setView
  const surface = desktop === undefined ? 'browser' : 'desktop'
  const sessionId = signIn?.targetSessionId ?? props.sessionId
  return <ComputerViewer key={`${surface}:${sessionId ?? ''}`} {...props}
    computer={desktop ?? computer} signIn={signIn} view={surface}
    restoreFocus={view !== undefined}
    {...(select === undefined ? {} : { select })} />
}

type ComputerView = 'browser' | 'desktop'

interface ComputerViewerProps extends ComputerPanelProps {
  readonly view: ComputerView
  readonly restoreFocus: boolean
  readonly select?: (view: ComputerView) => void
}

function ComputerViewer({
  computer, sessionId, botId, close, refreshAvailability, local, signIn, view, restoreFocus, select, t,
}: ComputerViewerProps): ReactNode {
  const viewerIdRef = useRef<string>()
  if (viewerIdRef.current === undefined) viewerIdRef.current = randomUUID()
  const viewerId = viewerIdRef.current
  const frameRef = useRef<ComputerFrame>()
  const modeRef = useRef<ComputerMode>('watching')
  const disposedRef = useRef<boolean>(false)
  const isDisposed = (): boolean => disposedRef.current
  const requestEpochRef = useRef(0)
  const operationRef = useRef(0)
  const claimedSignIn = useRef<string>()
  const inputQueue = useRef({ tail: Promise.resolve(), pending: 0 })
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
  const [computerStatus, setComputerStatus] = useState<ComputerStatus>()
  const [busy, setBusy] = useState<BusyAction>()
  const [feedback, setFeedback] = useState<FeedbackKey>()
  const [retryNonce, setRetryNonce] = useState(0)
  const [website, setWebsite] = useState('')
  const [navigating, setNavigating] = useState(false)
  const [networkBusy, setNetworkBusy] = useState(false)
  const [restartBusy, setRestartBusy] = useState(false)
  const [sharedWorkspaceBusy, setSharedWorkspaceBusy] = useState(false)
  const [restartConfirmOpen, setRestartConfirmOpen] = useState(false)
  const navigation = useRef<AbortController>()
  const networkController = useRef<AbortController>()
  const networkOperationRef = useRef(0)
  const restartController = useRef<AbortController>()
  const restartOperationRef = useRef(0)
  const sharedWorkspaceController = useRef<AbortController>()
  const sharedWorkspaceOperationRef = useRef(0)
  const signInApi = computer.signIn
  const frameSessionId = signIn?.targetSessionId ?? sessionId
  const sharedSignIn = signIn?.targetSessionId !== undefined

  frameRef.current = frame

  useEffect(() => {
    setWebsite('')
    setNavigating(false)
    setNetworkBusy(false)
    setRestartBusy(false)
    setSharedWorkspaceBusy(false)
    setRestartConfirmOpen(false)
    networkController.current?.abort()
    networkController.current = undefined
    ++networkOperationRef.current
    restartController.current?.abort()
    restartController.current = undefined
    ++restartOperationRef.current
    sharedWorkspaceController.current?.abort()
    sharedWorkspaceController.current = undefined
    ++sharedWorkspaceOperationRef.current
    return () => {
      navigation.current?.abort()
      navigation.current = undefined
      networkController.current?.abort()
      networkController.current = undefined
      ++networkOperationRef.current
      restartController.current?.abort()
      restartController.current = undefined
      ++restartOperationRef.current
      sharedWorkspaceController.current?.abort()
      sharedWorkspaceController.current = undefined
      ++sharedWorkspaceOperationRef.current
    }
  }, [botId, computer, frameSessionId, sessionId])

  useEffect(() => {
    if (local !== undefined) return
    let disposed = false
    const controller = new AbortController()
    setComputerStatus(undefined)
    void computer.status(controller.signal, sessionId).then((status) => {
      if (!disposed && !controller.signal.aborted) setComputerStatus(status)
    }).catch((error: unknown) => {
      if (!disposed && !controller.signal.aborted) setComputerStatus(undefined)
      void error
    })
    return () => { disposed = true; controller.abort() }
  }, [botId, computer, local, sessionId])

  const applyMode = useCallback((next: ComputerMode): void => {
    modeRef.current = next
    setMode(next)
  }, [])

  useEffect(() => {
    disposedRef.current = false
    frameRef.current = undefined
    pointerRef.current = undefined
    claimedSignIn.current = undefined
    applyMode('watching')
    setFrame(undefined)
    setBotActive(false)
    setPhase('loading')
    setBusy(undefined)
    setFeedback(undefined)
    const release = (): void => {
      disposedRef.current = true
      ++requestEpochRef.current
      ++operationRef.current
      inputQueue.current = { tail: Promise.resolve(), pending: 0 }
      if (modeRef.current !== 'controlling') return
      modeRef.current = 'watching'
      void computer.releaseControl(viewerId, { keepalive: true }, frameSessionId).catch((error: unknown) => {
        console.warn('Computer lease release failed:', error)
      })
    }
    return release
  }, [applyMode, computer, frameSessionId, viewerId])

  useEffect(() => {
    if (networkBusy || restartBusy || sharedWorkspaceBusy) return
    const controller = new AbortController()
    const { signal } = controller
    const poll = async (): Promise<void> => {
      if (frameRef.current === undefined) setPhase('loading')
      while (true) {
        const requestEpoch = requestEpochRef.current
        try {
          signal.throwIfAborted()
          const next = await computer.frame(viewerId, signal, frameSessionId)
          signal.throwIfAborted()
          if (requestEpoch !== requestEpochRef.current) continue
          // Arm the delay before publishing a frame so a synchronous cleanup can cancel it.
          const nextFrame = waitForNextFrame(signal)
          setFrame(next)
          frameRef.current = next
          if (next.signIn === undefined || next.mode !== 'controlling') claimedSignIn.current = undefined
          applyMode(next.mode)
          setBotActive(next.botActive)
          setPhase('ready')
          if (!await nextFrame) return
        } catch (error: unknown) {
          if (signal.aborted || isAbortError(error)) return
          if (requestEpoch !== requestEpochRef.current) continue
          if (sharedSignIn || frameRef.current?.signIn !== undefined || claimedSignIn.current !== undefined) {
            setFrame(undefined)
            frameRef.current = undefined
          }
          setPhase(imageErrorPhase(error))
          local?.checkSharing()
          return
        }
      }
    }
    void poll()
    return () => { controller.abort() }
  }, [applyMode, computer, frameSessionId, local, networkBusy, restartBusy, retryNonce, sharedSignIn, sharedWorkspaceBusy, viewerId])

  const alive = (operation: number): boolean => !disposedRef.current && operation === operationRef.current

  const networkIdentity = computerStatus?.computer
  const networkActionDisabled = networkBusy || restartBusy || sharedWorkspaceBusy
  const networkControlAvailable = local === undefined && !sharedSignIn && sessionId !== undefined && botId !== undefined
    && computer.network !== undefined && networkIdentity?.id === botId
    && networkIdentity.location === 'vps' && networkIdentity.permissionScope === 'bot'
    && networkIdentity.networkControl === true && networkIdentity.terminal === true
    && typeof networkIdentity.terminalInternet === 'boolean'

  const changeNetworkAccess = useCallback((enabled: boolean): void => {
    if (!networkControlAvailable || networkActionDisabled) return
    const targetSessionId = sessionId
    const operation = ++networkOperationRef.current
    const controller = new AbortController()
    networkController.current?.abort()
    networkController.current = controller
    setNetworkBusy(true)
    setFeedback(undefined)
    void computer.network(targetSessionId, enabled, controller.signal).then((result) => {
      if (disposedRef.current || operation !== networkOperationRef.current || controller.signal.aborted) return
      setComputerStatus((current) => {
        if (current?.computer?.id !== botId) return current
        return { ...current, computer: { ...current.computer, terminalInternet: result.enabled } }
      })
      setNetworkBusy(false)
      if (networkController.current === controller) networkController.current = undefined
      refreshAvailability?.(targetSessionId)
    }).catch((error: unknown) => {
      if (disposedRef.current || operation !== networkOperationRef.current || controller.signal.aborted) return
      setNetworkBusy(false)
      if (networkController.current === controller) networkController.current = undefined
      setFeedback(error instanceof ComputerApiError && error.status === 409
        ? 'computerNetworkBusy' : 'computerNetworkError')
    })
  }, [botId, computer, networkActionDisabled, networkControlAvailable, refreshAvailability, sessionId])

  const privateSignIn = frame?.signIn ?? claimedSignIn.current
  const sharedWorkspaceIdentity = computerStatus?.computer
  const sharedWorkspaceControlAvailable = computerStatus?.available === true && local === undefined && !sharedSignIn
    && sessionId !== undefined && botId !== undefined
    && computer.sharedWorkspace !== undefined && sharedWorkspaceIdentity?.id === botId
    && sharedWorkspaceIdentity.location === 'vps' && sharedWorkspaceIdentity.permissionScope === 'bot'
    && sharedWorkspaceIdentity.sharedWorkspaceControl === true
  const sharedWorkspaceActionDisabled = sharedWorkspaceBusy || networkBusy || restartBusy
    || mode !== 'watching' || botActive || signIn !== undefined || privateSignIn !== undefined

  const changeSharedWorkspace = useCallback((enabled: boolean): void => {
    if (!sharedWorkspaceControlAvailable || sharedWorkspaceActionDisabled) return
    const targetSessionId = sessionId
    const operation = ++sharedWorkspaceOperationRef.current
    ++requestEpochRef.current
    const controller = new AbortController()
    sharedWorkspaceController.current?.abort()
    sharedWorkspaceController.current = controller
    setSharedWorkspaceBusy(true)
    setFeedback(undefined)
    void computer.sharedWorkspace(targetSessionId, enabled, controller.signal).then((result) => {
      if (disposedRef.current || operation !== sharedWorkspaceOperationRef.current || controller.signal.aborted) return
      setComputerStatus((current) => {
        if (current?.computer?.id !== botId) return current
        if (result.enabled) return { ...current, computer: { ...current.computer, sharedFiles: true } }
        const { sharedFiles: ignoredSharedFiles, ...withoutSharedFiles } = current.computer
        void ignoredSharedFiles
        return { ...current, computer: withoutSharedFiles }
      })
      setSharedWorkspaceBusy(false)
      if (sharedWorkspaceController.current === controller) sharedWorkspaceController.current = undefined
      refreshAvailability?.(targetSessionId)
    }).catch((error: unknown) => {
      if (disposedRef.current || operation !== sharedWorkspaceOperationRef.current || controller.signal.aborted) return
      setSharedWorkspaceBusy(false)
      if (sharedWorkspaceController.current === controller) sharedWorkspaceController.current = undefined
      setFeedback(error instanceof ComputerApiError && error.status === 409
        ? 'computerSharedWorkspaceBusy' : 'computerSharedWorkspaceError')
    })
  }, [botId, computer, refreshAvailability, sessionId, sharedWorkspaceActionDisabled, sharedWorkspaceControlAvailable])

  const restartIdentity = computerStatus?.computer
  const restartControlAvailable = computerStatus?.available === true && local === undefined && !sharedSignIn
    && sessionId !== undefined && botId !== undefined
    && computer.restart !== undefined && restartIdentity?.id === botId
    && restartIdentity.location === 'vps' && restartIdentity.permissionScope === 'bot'
    && restartIdentity.restart === true
  const restartActionAvailable = restartControlAvailable && (phase === 'ready' || phase === 'disconnected')
    && signIn === undefined && privateSignIn === undefined
  const restartActionDisabled = restartBusy || networkBusy || sharedWorkspaceBusy || mode !== 'watching' || botActive

  const restartComputer = useCallback((): void => {
    if (!restartActionAvailable || restartActionDisabled) return
    const targetSessionId = sessionId
    const operation = ++restartOperationRef.current
    ++requestEpochRef.current
    const controller = new AbortController()
    restartController.current?.abort()
    restartController.current = controller
    setRestartBusy(true)
    setRestartConfirmOpen(false)
    setFeedback(undefined)
    void computer.restart(targetSessionId, controller.signal).then(() => {
      if (disposedRef.current || operation !== restartOperationRef.current || controller.signal.aborted) return
      frameRef.current = undefined
      setFrame(undefined)
      setPhase('loading')
      setRestartBusy(false)
      if (restartController.current === controller) restartController.current = undefined
    }).catch((error: unknown) => {
      if (disposedRef.current || operation !== restartOperationRef.current || controller.signal.aborted) return
      setRestartBusy(false)
      if (restartController.current === controller) restartController.current = undefined
      setFeedback(error instanceof ComputerApiError && error.status === 409
        ? 'computerRestartBusy' : 'computerRestartError')
    })
  }, [computer, networkBusy, restartActionAvailable, restartActionDisabled, restartBusy, sessionId, sharedWorkspaceBusy])

  const takeControl = useCallback((requestId?: string): void => {
    if (requestId !== undefined && (signInApi === undefined || frameSessionId === undefined)) return
    const operation = ++operationRef.current
    ++requestEpochRef.current
    setBusy('take')
    setFeedback(undefined)
    const request = requestId === undefined || signInApi === undefined || frameSessionId === undefined
      ? computer.takeControl(viewerId, undefined, frameSessionId)
      : signInApi.take(frameSessionId, requestId, viewerId)
    void request.then((result) => {
      if (disposedRef.current || operation !== operationRef.current) {
        if (disposedRef.current && result.mode === 'controlling') {
          void computer.releaseControl(viewerId, { keepalive: true }, frameSessionId).catch((error: unknown) => { void error })
        }
        return
      }
      ++requestEpochRef.current
      claimedSignIn.current = requestId
      applyMode(result.mode)
      setBusy(undefined)
      if (requestId !== undefined) setRetryNonce(value => value + 1)
      if (result.mode !== 'controlling') setFeedback('computerControlBusy')
    }).catch((error: unknown) => {
      if (disposedRef.current || operation !== operationRef.current) return
      setBusy(undefined)
      if (error instanceof ComputerApiError && error.status === 409) {
        applyMode('other')
        setFeedback('computerControlBusy')
        return
      }
      if (sharedSignIn) {
        frameRef.current = undefined
        setFrame(undefined)
      }
      setPhase(error instanceof ComputerApiError && error.status === 404 ? 'unavailable' : 'disconnected')
    })
  }, [applyMode, computer, frameSessionId, sharedSignIn, signInApi, viewerId])

  useEffect(() => {
    if (signIn !== undefined) takeControl(signIn.requestId)
  }, [signIn, takeControl])

  const releaseControl = (cancel = false): void => {
    if (busy !== undefined || modeRef.current !== 'controlling') return
    const operation = ++operationRef.current
    ++requestEpochRef.current
    setBusy('release')
    setFeedback(undefined)
    const requestId = claimedSignIn.current
    const queue = inputQueue.current
    void queue.tail.then(async () => {
      if (inputQueue.current !== queue || !alive(operation)) return undefined
      if (requestId !== undefined && signInApi !== undefined && frameSessionId !== undefined) {
        return cancel ? signInApi.cancel(frameSessionId, requestId, viewerId) : signInApi.complete(frameSessionId, requestId, viewerId)
      }
      return computer.releaseControl(viewerId, undefined, frameSessionId)
    }).then((result) => {
      if (result === undefined || !alive(operation)) return
      ++requestEpochRef.current
      claimedSignIn.current = undefined
      if (requestId !== undefined) {
        frameRef.current = undefined
        setFrame(undefined)
        setRetryNonce(value => value + 1)
      }
      applyMode(result.mode)
      setBusy(undefined)
      if (sharedSignIn) close()
    }).catch((error: unknown) => {
      if (!alive(operation)) return
      setBusy(undefined)
      if (sharedSignIn && error instanceof ComputerApiError && error.status === 404) {
        frameRef.current = undefined
        setFrame(undefined)
        setPhase('unavailable')
      }
      setFeedback(requestId !== undefined ? 'computerSignInError'
        : error instanceof ComputerApiError && error.status === 404 ? 'computerInputRejected' : 'computerControlBusy')
    })
  }

  const sendAction = (action: ComputerInputAction): void => {
    const queue = inputQueue.current
    const browserOrigin = sharedSignIn ? frame?.browserOrigin ?? undefined : undefined
    if (local !== undefined || busy !== undefined || modeRef.current !== 'controlling' || phase !== 'ready'
      || queue.pending >= MAX_QUEUED_INPUTS || (sharedSignIn && browserOrigin === undefined)) return
    setFeedback(undefined)
    queue.pending++
    queue.tail = queue.tail.then(async () => {
      if (inputQueue.current !== queue || modeRef.current !== 'controlling') return
      try {
        await computer.input(viewerId, action, undefined, frameSessionId, browserOrigin)
      } catch (error: unknown) {
        if (inputQueue.current !== queue) return
        if (error instanceof ComputerApiError && error.status === 409) {
          applyMode('other')
          setFeedback('computerControlBusy')
          return
        }
        if (sharedSignIn) {
          frameRef.current = undefined
          setFrame(undefined)
        }
        if (error instanceof ComputerApiError && error.status === 404) setPhase('unavailable')
        else setFeedback('computerInputRejected')
      }
    }).finally(() => { queue.pending-- })
  }

  const sendText = (value: string): void => {
    if (value === '') return
    const bounded = value.slice(0, MAX_TEXT_LENGTH)
    sendAction({ kind: 'text', text: bounded })
    if (bounded.length !== value.length) setFeedback('computerTextTrimmed')
  }

  const openWebsite = (): void => {
    const address = website.trim()
    const navigate = computer.navigate
    if (address === '' || frameSessionId === undefined || navigate === undefined || navigation.current !== undefined
      || modeRef.current !== 'controlling' || busy !== undefined) return
    const controller = new AbortController()
    const isAborted = (): boolean => controller.signal.aborted
    navigation.current = controller
    setFeedback(undefined)
    setNavigating(true)
    const queue = inputQueue.current
    queue.tail = queue.tail.then(async () => {
      if (controller.signal.aborted || inputQueue.current !== queue || modeRef.current !== 'controlling') return
      try {
        await navigate(viewerId, address, frameSessionId, controller.signal)
        if (!isAborted() && !isDisposed()) imageRef.current?.focus()
      } catch (error: unknown) {
        if (!isAborted() && !isDisposed()) {
          if (sharedSignIn && error instanceof ComputerApiError && error.status === 404) {
            frameRef.current = undefined
            setFrame(undefined)
            setPhase('unavailable')
          } else {
            setFeedback('computerNavigationFailed')
          }
        }
        void error
      }
    }).finally(() => {
      if (navigation.current !== controller) return
      navigation.current = undefined
      setNavigating(false)
    })
  }

  const paste = (): void => {
    const source: { readonly clipboard?: Clipboard } = navigator
    const { clipboard } = source
    if (modeRef.current !== 'controlling' || clipboard === undefined) {
      setFeedback('computerPasteFailed')
      return
    }
    const operation = operationRef.current
    void clipboard.readText().then((text) => {
      if (alive(operation)) sendText(text)
    }).catch((error: unknown) => {
      if (!alive(operation)) return
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

  const status = privateSignIn !== undefined && phase === 'ready'
    ? t('computerSignInPrivate')
    : phase === 'loading'
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
  const frameSource = frame === undefined || frame.jpeg === '' ? undefined : `data:image/jpeg;base64,${frame.jpeg}`
  const currentBrowserOrigin = sharedSignIn && frame?.browserOrigin !== null ? frame?.browserOrigin : undefined
  const inputReady = mode === 'controlling' && busy === undefined
    && (!sharedSignIn || (phase === 'ready' && currentBrowserOrigin !== undefined))
  const scopeMeta = computerStatus?.computer?.permissionScope === 'bot'
    ? t('computerScopeBotMeta')
    : computerStatus?.computer?.permissionScope === 'workspace'
      ? t('computerScopeWorkspaceMeta')
      : undefined

  const canSelectView = local === undefined && select !== undefined && computerStatus?.computer?.desktop === true
    && computerStatus.computer.id === botId && computerStatus.computer.location === 'vps'
    && computerStatus.computer.permissionScope === 'bot' && privateSignIn === undefined
  const viewLocked = busy !== undefined || mode === 'controlling' || networkActionDisabled || restartConfirmOpen
  const restartingBrowser = computerStatus?.computer?.desktop === true && computerStatus.computer.browser === true

  return (
    <section className={css.root} aria-label={t('computerTitle')} data-computer-panel>
      <header className={css.toolbar}>
        <div className={css.status} role="status" aria-live="polite">
          <StateDot state={stateFor(phase, mode, botActive)} size={8} />
          <span className={css.statusCopy}>
            <span>{status}</span>
            {scopeMeta !== undefined && <span className={css.statusMeta}>{scopeMeta}</span>}
          </span>
        </div>
        <div className={css.controls}>
          {phase === 'disconnected' && <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { setRetryNonce(value => value + 1) }}>{t('computerRetry')}</Button>}
          {mode === 'controlling'
            ? <Button variant={privateSignIn === undefined ? 'outline' : 'primary'} size="sm" disabled={busy !== undefined}
              icon={<IconStopFillRegular size={14} />} onClick={() => { releaseControl() }}>{t(privateSignIn === undefined ? 'computerHandBack' : 'computerSignInDone')}</Button>
            : <Button variant="primary" size="sm" disabled={busy !== undefined || phase === 'unavailable'}
              onClick={() => { takeControl(privateSignIn) }}>{t(privateSignIn === undefined ? 'computerTakeControl' : 'computerSignInTake')}</Button>}
          {mode === 'controlling' && privateSignIn !== undefined && (
            <Button variant="ghost" size="sm" disabled={busy !== undefined} onClick={() => { releaseControl(true) }}>{t('cancel')}</Button>
          )}
          {local !== undefined
            ? <Button variant="ghost" size="sm" icon={<IconStopFillRegular size={14} />} onClick={close}>{t('macComputerStop')}</Button>
            : <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={14} />} aria-label={t('computerClose')} onClick={close} />}
        </div>
      </header>
      {canSelectView && (
        <div className={css.viewSwitch} role="group" aria-label={t('computerView')}>
          {(['browser', 'desktop'] as const).map(option => (
            <Button key={option} size="sm" variant="toolbar" aria-pressed={option === view}
              autoFocus={restoreFocus && option === view} disabled={viewLocked} onClick={() => { select(option) }}>
              {t(option === 'browser' ? 'computerViewBrowser' : 'computerViewDesktop')}
            </Button>
          ))}
        </div>
      )}
      {networkControlAvailable && (
        <div className={css.networkControl} data-computer-network-control>
          <span className={css.networkCopy}>
            <span className={css.networkLabel}>{t('computerNetworkLabel')}</span>
            <span className={css.networkHint}>{t('computerNetworkHint')}</span>
          </span>
          <Switch checked={networkIdentity.terminalInternet} onChange={changeNetworkAccess}
            disabled={networkActionDisabled} label={t('computerNetworkToggle')} />
        </div>
      )}
      {sharedWorkspaceControlAvailable && (
        <div className={css.networkControl} data-computer-shared-workspace-control>
          <span className={css.networkCopy}>
            <span className={css.networkLabel}>{t('computerSharedWorkspaceLabel')}</span>
            <span className={css.networkHint}>{t('computerSharedWorkspaceHint')}</span>
          </span>
          <Switch checked={sharedWorkspaceIdentity.sharedFiles === true} onChange={changeSharedWorkspace}
            disabled={sharedWorkspaceActionDisabled} label={t('computerSharedWorkspaceToggle')} />
        </div>
      )}
      {computerStatus?.computer?.browser === true && mode === 'controlling' && (
        <form className={css.browserAddress} onSubmit={(event) => { event.preventDefault(); openWebsite() }}>
          <Input type="url" inputMode="url" aria-label={t('computerWebsiteAddress')} placeholder={t('computerWebsitePlaceholder')}
            value={website} onChange={(event) => { setWebsite(event.currentTarget.value) }} maxLength={4096}
            disabled={navigating || busy !== undefined} autoComplete="off" />
          <Button type="submit" variant="outline" size="sm" disabled={website.trim() === '' || navigating || busy !== undefined}>
            {t('computerOpenWebsite')}
          </Button>
        </form>
      )}
      {sharedSignIn && (
        <div className={css.browserOrigin} data-computer-browser-origin>
          <span>{t('computerBrowserOrigin')}</span>
          <code>{currentBrowserOrigin ?? t('computerBrowserOriginUnavailable')}</code>
        </div>
      )}
      {privateSignIn !== undefined && mode === 'controlling' && (
        <div className={css.signInNotice}>{t('computerSignInHint')} {t('computerSignInReturn')}</div>
      )}
      {feedback !== undefined && <div className={css.notice} role="alert">{t(feedback)}</div>}
      {restartConfirmOpen && restartActionAvailable && (
        <div className={css.restartConfirm} data-computer-restart-confirm>
          <p>{t(restartingBrowser ? 'computerRestartBrowserConfirm' : 'computerRestartConfirm')}</p>
          <div className={css.restartConfirmActions}>
            <Button variant="ghost" size="sm" disabled={restartBusy} onClick={() => { setRestartConfirmOpen(false) }}>
              {t('cancel')}
            </Button>
            <Button variant="primary" size="sm" disabled={restartActionDisabled} onClick={restartComputer}>
              {t('computerRestartAction')}
            </Button>
          </div>
        </div>
      )}
      <div className={css.viewport} data-computer-viewport>
        {frameSource !== undefined
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
            <StateDot state={phase === 'loading' || privateSignIn !== undefined ? 'ongoing' : 'error'} size={14} />
            <p>{privateSignIn !== undefined && phase === 'ready' ? t('computerSignInWaiting') : status}</p>
            {phase === 'disconnected' && <Button variant="outline" size="sm" onClick={() => { setRetryNonce(value => value + 1) }}>{t('computerRetry')}</Button>}
          </div>}
      </div>
      <footer className={css.footer}>
        <span>{local !== undefined
          ? t(mode === 'controlling' ? 'macComputerPaused' : 'macComputerShared')
          : t(mode === 'controlling' ? 'computerInputHint' : 'computerWatchHint')}</span>
        <div className={css.footerActions}>
          {restartActionAvailable && !restartConfirmOpen && (
            <Button data-computer-restart variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={14} />}
              disabled={restartActionDisabled} onClick={() => { setRestartConfirmOpen(true) }}>
              {restartingBrowser
                ? t(restartBusy ? 'computerRestartingBrowser' : 'computerRestartBrowser')
                : t(restartBusy ? 'computerRestarting' : 'computerRestart')}
            </Button>
          )}
          {local === undefined && <Tooltip label={t('computerPaste')} side="top" delayMs={500}>
            <Button variant="ghost" size="sm" disabled={!inputReady} onClick={paste}>{t('computerPaste')}</Button>
          </Tooltip>}
        </div>
      </footer>
    </section>
  )
}

type ReactClipboardEvent<T> = import('react').ClipboardEvent<T>
