// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en } from '../src/client/locales.ts'
import { MacComputerPanel } from '../src/client/MacComputerPanel.tsx'

const t = makeTranslate(en)

const SETUP_PENDING = { screenRecording: false, accessibility: false, shared: false }
const SETUP_SCREEN_GRANTED = { screenRecording: true, accessibility: false, deviceControlLabel: true, shared: false }
const SETUP_READY = { screenRecording: true, accessibility: true, deviceControlLabel: true, shared: false }
const SETUP_SHARED = { screenRecording: true, accessibility: true, deviceControlLabel: true, shared: true }
const SHARED_FRAME = { jpeg: 'shared-screen', width: 100, height: 50, mode: 'watching', botActive: false }

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('Computer request did not carry a JSON body')
  const value: unknown = JSON.parse(init.body)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Computer request body is not an object')
  return value as Record<string, unknown>
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MacComputerPanel', () => {
  it('checks permissions, opens both settings, starts sharing, and releases the local lease', async () => {
    const screenSettings = Promise.withResolvers<Response>()
    let settingsCalls = 0
    const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input === 'api/computer/mac/setup') {
        return response(settingsCalls === 0 ? SETUP_PENDING : SETUP_READY)
      }
      if (input === 'api/computer/mac/settings') {
        const permission = bodyOf(init).permission
        if (permission === 'screenRecording') {
          settingsCalls += 1
          return screenSettings.promise
        }
        if (permission === 'accessibility') {
          settingsCalls += 1
          return response(SETUP_READY)
        }
        throw new Error('Unexpected Mac permission')
      }
      if (input === 'api/computer/mac/start') return response(SETUP_SHARED)
      if (input === 'api/computer/mac/frame') return response(SHARED_FRAME)
      if (input === 'api/computer/mac/take-control') return response({ mode: 'controlling' })
      if (input === 'api/computer/mac/release-control') return response({ mode: 'watching' })
      if (input === 'api/computer/mac/stop') return response(SETUP_READY)
      throw new Error(`Unexpected Mac Computer route: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const close = vi.fn()
    const view = render(<MacComputerPanel sessionId="mac-session" close={close} t={t} />)

    expect(screen.getByText(en.macComputerSetupTitle)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.macComputerStart })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.computerClose })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.computerClose }))
    expect(close).toHaveBeenCalledOnce()

    await waitFor(() => { expect(screen.getAllByRole('button', { name: /Open settings/u })).toHaveLength(2) })
    const screenButton = screen.getByRole('button', { name: `${en.macComputerScreen} · ${en.macComputerSettings}` })
    fireEvent.click(screenButton)
    expect(screen.getAllByRole('button', { name: /Open settings/u }).every(button => button.hasAttribute('disabled'))).toBe(true)
    screenSettings.resolve(response(SETUP_SCREEN_GRANTED))
    await waitFor(() => { expect(screen.getByText(en.macComputerGranted)).toBeTruthy() })
    expect(screen.getByText(en.macComputerDeviceControl)).toBeTruthy()
    expect(settingsCalls).toBe(1)

    const accessibilityButton = screen.getByRole('button', { name: `${en.macComputerDeviceControl} · ${en.macComputerSettings}` })
    fireEvent.click(accessibilityButton)
    await waitFor(() => { expect(screen.getAllByText(en.macComputerGranted)).toHaveLength(2) })

    fireEvent.click(screen.getByRole('button', { name: en.macComputerCheck }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.macComputerStart })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: en.macComputerStart }))
    await screen.findByRole('img', { name: en.computerScreenAlt })
    expect(screen.getByText(en.macComputerShared)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.computerTakeControl }))
    await screen.findByText(en.macComputerPaused)
    fireEvent.click(screen.getByRole('button', { name: en.macComputerStop }))
    expect(close).toHaveBeenCalledTimes(2)

    const setupCall = fetchMock.mock.calls.find(([input, init]) => input === 'api/computer/mac/settings' && bodyOf(init).permission === 'accessibility')
    expect(setupCall).toBeDefined()
    expect(bodyOf(setupCall?.[1])).toMatchObject({ sessionId: 'mac-session', permission: 'accessibility' })
    view.unmount()
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => input === 'api/computer/mac/stop')).toBe(true)
      expect(fetchMock.mock.calls.some(([input]) => input === 'api/computer/mac/release-control')).toBe(true)
    })
  })

  it('reports action and focus-refresh failures, then aborts the pending refresh on dispose', async () => {
    let setupCalls = 0
    let pendingSignal: RequestInit['signal']
    let finishPending: ((value: Response) => void) | undefined
    let rejectPending: ((reason?: unknown) => void) | undefined
    const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      if (input === 'api/computer/mac/setup') {
        setupCalls += 1
        if (bodyOf(init).permission !== undefined) throw new Error('settings could not open')
        if (setupCalls === 1) return response(SETUP_PENDING)
        if (setupCalls === 2) throw new Error('permission refresh failed')
        pendingSignal = init?.signal
        if (setupCalls === 3) return new Promise<Response>((resolve) => { finishPending = resolve })
        return new Promise<Response>((_resolve, reject) => { rejectPending = reject })
      }
      if (input === 'api/computer/mac/stop') throw new Error('stop already expired')
      throw new Error(`Unexpected Mac Computer route: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<MacComputerPanel sessionId="mac-session" close={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: `${en.macComputerScreen} · ${en.macComputerSettings}` })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: `${en.macComputerScreen} · ${en.macComputerSettings}` }))
    await screen.findByRole('alert')

    fireEvent.focus(window)
    await waitFor(() => { expect(setupCalls).toBe(2) })
    expect(screen.getByRole('alert').textContent).toBe(en.macComputerSetupError)

    fireEvent.focus(window)
    await waitFor(() => { expect(setupCalls).toBe(3) })
    expect(pendingSignal?.aborted).toBe(false)
    fireEvent.focus(window)
    await waitFor(() => { expect(setupCalls).toBe(4) })
    view.unmount()
    expect(pendingSignal?.aborted).toBe(true)
    finishPending?.(response(SETUP_READY))
    rejectPending?.(new Error('aborted refresh'))
    await Promise.resolve()
    await Promise.resolve()
    await waitFor(() => { expect(fetchMock.mock.calls.some(([input]) => input === 'api/computer/mac/stop')).toBe(true) })
    const callsAfterUnmount = setupCalls
    fireEvent.focus(window)
    expect(setupCalls).toBe(callsAfterUnmount)
  })

  it('rechecks sharing after a disconnected native display and preserves the failure notice', async () => {
    let setupCalls = 0
    let frameCalls = 0
    const fetchMock = vi.fn(async (input: string): Promise<Response> => {
      if (input === 'api/computer/mac/setup') {
        setupCalls += 1
        if (setupCalls === 1) return response(SETUP_SHARED)
        if (setupCalls === 2) throw new Error('sharing check failed')
        return response({ ...SETUP_READY, deviceControlLabel: false })
      }
      if (input === 'api/computer/mac/frame') {
        frameCalls += 1
        throw new Error(`display frame ${frameCalls} failed`)
      }
      if (input === 'api/computer/mac/stop') return response(SETUP_READY)
      throw new Error(`Unexpected Mac Computer route: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<MacComputerPanel sessionId="mac-session" close={vi.fn()} t={t} />)

    const retries = await screen.findAllByRole('button', { name: en.computerRetry })
    const retry = retries.at(-1)
    if (retry === undefined) throw new Error('The Mac Computer retry control is unavailable.')
    expect(frameCalls).toBe(1)
    fireEvent.click(retry)
    await screen.findByText(en.macComputerSetupTitle)
    expect(screen.getByRole('alert').textContent).toBe(en.macComputerSetupError)
    expect(setupCalls).toBe(3)
    expect(screen.getByText(en.macComputerAccess)).toBeTruthy()
    view.unmount()
  })
})
