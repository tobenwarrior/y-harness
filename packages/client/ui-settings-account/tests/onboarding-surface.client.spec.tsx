// @vitest-environment jsdom
import { cleanup, render, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformOverlay } from '../src/client/PlatformOverlay.tsx'
import { acquireOverlayInert } from '../src/client/overlay-inert.ts'
import { OnboardingSurface } from '../src/client/OnboardingSurface.tsx'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { readFileSync } from 'node:fs'

let appRoot: HTMLDivElement

beforeEach(() => {
  appRoot = document.createElement('div')
  appRoot.id = 'root'
  appRoot.inert = false
  document.body.appendChild(appRoot)
})

afterEach(() => {
  cleanup()
  appRoot.remove()
})

describe('OnboardingSurface', () => {
  it('portals the overlay chrome to document.body around its content', () => {
    const view = render(<OnboardingSurface><p>step content</p></OnboardingSurface>)
    // Portaled: the overlay is a body child, not inside the render container.
    expect(view.container.querySelector('[class*="onboardingOverlay"]')).toBeNull()
    const overlay = document.body.querySelector('[class*="onboardingOverlay"]')
    expect(overlay).not.toBeNull()
    expect(overlay!.firstElementChild).toBe(overlay!.querySelector('[class*="dragBand"]'))
    const stage = overlay!.querySelector('[class*="onboardingStage"]')
    expect(stage).not.toBeNull()
    expect(stage!.textContent).toBe('step content')
  })

  it('holds #root inert for exactly its own lifetime', () => {
    const view = render(<OnboardingSurface>x</OnboardingSurface>)
    expect(appRoot.inert).toBe(true)
    expect(appRoot.style.opacity).toBe('0')
    view.unmount()
    expect(appRoot.inert).toBe(false)
    expect(appRoot.style.opacity).toBe('')
  })

  it('restores the root state owned by an earlier overlay', () => {
    appRoot.inert = true
    appRoot.style.opacity = '0.5'
    const view = render(<OnboardingSurface>x</OnboardingSurface>)
    view.unmount()
    expect(appRoot.inert).toBe(true)
    expect(appRoot.style.opacity).toBe('0.5')
  })

  it('renders without an #root element (compositions that mount elsewhere)', () => {
    appRoot.remove()
    const view = render(<OnboardingSurface>x</OnboardingSurface>)
    expect(document.body.querySelector('[class*="onboardingStage"]')!.textContent).toBe('x')
    view.unmount()
  })

  it('reveals the root during exit but keeps it inert until unmount', () => {
    appRoot.style.opacity = '0.8'
    const view = render(<OnboardingSurface>x</OnboardingSurface>)
    view.rerender(<OnboardingSurface exiting>x</OnboardingSurface>)
    expect(appRoot.style.opacity).toBe('0.8')
    expect(appRoot.inert).toBe(true)
    expect(document.querySelector('[data-exiting]')).not.toBeNull()
    view.unmount()
    expect(appRoot.inert).toBe(false)
    expect(appRoot.style.opacity).toBe('0.8')
  })

  it('hides the root again if the owner cancels an exit', () => {
    const view = render(<OnboardingSurface exiting>x</OnboardingSurface>)
    expect(appRoot.style.opacity).toBe('')
    view.rerender(<OnboardingSurface>x</OnboardingSurface>)
    expect(appRoot.style.opacity).toBe('0')
    expect(appRoot.inert).toBe(true)
    view.unmount()
    expect(appRoot.style.opacity).toBe('')
    expect(appRoot.inert).toBe(false)
  })
})

it('restores interaction when onboarding and its recharge overlay unmount together', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  try {
    const bridge = { open: async () => {}, close: async () => {}, setBounds: async () => {} }
    const view = render(<><OnboardingSurface>onboarding</OnboardingSurface>
      <PlatformOverlay bridge={bridge} page="top-up" backLabel="Back" loadingLabel="Loading" failureLabel="Failed" retryLabel="Retry" onClose={() => {}} /></>)
    expect(appRoot.inert).toBe(true)
    view.unmount()
    expect(appRoot.inert).toBe(false)
    expect(appRoot.style.opacity).toBe('')
  } finally { vi.unstubAllGlobals() }
})

it('keeps a portaled Settings draft inert and traps focus during onboarding', () => {
  const settings = render(<Modal open title="Settings" closeLabel="Close" shortcutModal="settings" onClose={() => {}}>
    <input aria-label="Draft" defaultValue="keep this" />
  </Modal>)
  const dialog = screen.getByRole('dialog', { name: 'Settings' }) as HTMLElement
  dialog.inert = false
  dialog.parentElement!.style.visibility = 'visible'
  const draft = screen.getByRole<HTMLInputElement>('textbox', { name: 'Draft' })
  const onboarding = render(<OnboardingSurface label="Introduction"><button>Continue</button><button>Later</button></OnboardingSurface>)
  expect(screen.getByRole('dialog', { name: 'Introduction' }).getAttribute('aria-modal')).toBe('true')
  const first = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' })
  const last = screen.getByRole<HTMLButtonElement>('button', { name: 'Later' })
  expect(dialog.inert).toBe(true)
  expect(dialog.parentElement!.style.visibility).toBe('hidden')
  expect(document.activeElement).toBe(first)
  last.focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(document.activeElement).toBe(first)
  onboarding.unmount()
  expect(dialog.inert).toBe(false)
  expect(dialog.parentElement!.style.visibility).toBe('visible')
  expect(draft.value).toBe('keep this')
  settings.unmount()
})

it('tolerates a Settings dialog that has detached before onboarding claims it', () => {
  const dialog = document.createElement('div')
  const lookup = vi.spyOn(document, 'querySelector').mockReturnValueOnce(dialog)
  try {
    const view = render(<OnboardingSurface label="Introduction">ready</OnboardingSurface>)
    expect(appRoot.inert).toBe(true)
    view.unmount()
    expect(appRoot.inert).toBe(false)
  } finally { lookup.mockRestore() }
})

it('layers onboarding above Settings while allowing subsequent dialogs above it', () => {
  const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const zIndex = (text: string, selector: string) => {
    const match = text.match(new RegExp(`\\.${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`, 'u'))
    if (match === null) throw new Error(`missing z-index for ${selector}`)
    return Number(match[1])
  }
  const onboarding = zIndex(css('../src/client/OnboardingSurface.module.css'), 'onboardingOverlay')
  const settings = zIndex(css('../../ui-settings-general/src/client/SettingsRoot.module.css'), 'overlay')
  const dialog = zIndex(css('../../ui-primitives/src/Modal.module.css'), 'root')
  expect(onboarding).toBeGreaterThanOrEqual(settings)
  expect(dialog).toBeGreaterThanOrEqual(onboarding)
})




it('releasing one overlay twice cannot release a different active overlay', () => {
  const first = acquireOverlayInert(appRoot)
  const second = acquireOverlayInert(appRoot)
  first()
  first()
  expect(appRoot.inert).toBe(true)
  second()
  expect(appRoot.inert).toBe(false)
})
