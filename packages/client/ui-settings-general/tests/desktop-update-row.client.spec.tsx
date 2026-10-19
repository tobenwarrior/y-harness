// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdateRowProps } from '../src/client/DesktopUpdateRow.tsx'
import { DesktopUpdateRow } from '../src/client/DesktopUpdateRow.tsx'
import type { DesktopUpdateView } from '../src/types.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function translate(key: string, params?: Record<string, string | number>): string {
  return Object.entries(params ?? {}).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    (en as Readonly<Record<string, string>>)[key] ?? key,
  )
}

const t = translate as DesktopUpdateRowProps['t']

function show(hasBridge: boolean, view: DesktopUpdateView) {
  const openDesktopUpdate = vi.fn()
  const props = {
    hasUpdateBridge: hasBridge,
    useDesktopUpdate: bindSnapshotSelector(createSnapshotStore<DesktopUpdateView>(view)),
    openDesktopUpdate,
    t,
  } as DesktopUpdateRowProps
  const rendered = render(<DesktopUpdateRow {...props} />)
  return { openDesktopUpdate, container: rendered.container }
}

const idle: DesktopUpdateView = { failed: false, opening: false }

describe('DesktopUpdateRow', () => {
  it('renders nothing outside Desktop', () => {
    const { container } = show(false, idle)
    expect(container.innerHTML).toBe('')
  })

  it('offers a check from idle and drives the shell chain', () => {
    const { openDesktopUpdate } = show(true, idle)
    expect(screen.getByText('You are up to date')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }))
    expect(openDesktopUpdate).toHaveBeenCalledOnce()
  })

  it('offers the update when one is available', () => {
    const { openDesktopUpdate } = show(true, {
      failed: false, opening: false, presentation: { phase: 'available', version: '1.0.1' },
    })
    expect(screen.getByText('Update: 1.0.1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(openDesktopUpdate).toHaveBeenCalledOnce()
  })

  it('disables the action while busy and shows progress', () => {
    show(true, {
      failed: false, opening: false, presentation: { phase: 'downloading', version: '1.0.1', percent: 58 },
    })
    expect(screen.getByText('Downloading update: 58% Target version: 1.0.1')).toBeTruthy()
    const action = screen.getByRole('button', { name: '58%' }) as HTMLButtonElement
    expect(action.disabled).toBe(true)
  })

  it('offers installation once ready', () => {
    const { openDesktopUpdate } = show(true, {
      failed: false, opening: false, presentation: { phase: 'ready', version: '1.0.1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Install and Restart' }))
    expect(openDesktopUpdate).toHaveBeenCalledOnce()
  })

  it('offers a retry after failures', () => {
    const { openDesktopUpdate } = show(true, {
      failed: false, opening: false, presentation: { phase: 'error', version: '1.0.1', failure: 'download' },
    })
    expect(screen.getByText('Could not download the update. Please try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry update' }))
    expect(openDesktopUpdate).toHaveBeenCalledOnce()
  })
})
