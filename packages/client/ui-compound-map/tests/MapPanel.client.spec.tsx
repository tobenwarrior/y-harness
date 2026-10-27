// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { MapPanelIcon } from '../src/client/MapPanelIcon.tsx'
import { MapPanel, VIEWER_ROUTE } from '../src/client/MapPanel.tsx'

afterEach(cleanup)

const t = makeTranslate(en)

/**
 * Render the panel with its locale seat.
 * @returns the render result.
 */
function renderPanel() {
  return render(<MapPanel t={t} />)
}

describe('compound code map panel', () => {
  it('frames the viewer this build serves', () => {
    renderPanel()
    const frame = screen.getByTitle(en.frameTitle)
    expect(frame.getAttribute('src')).toBe(VIEWER_ROUTE)
    expect(screen.getByRole('region', { name: en.title })).toBeTruthy()
  })

  it('states that the map is served locally', () => {
    renderPanel()
    expect(screen.getByText(en.hint)).toBeTruthy()
  })

  it('reloads the viewer on request', () => {
    renderPanel()
    const before = screen.getByTitle(en.frameTitle)
    fireEvent.click(screen.getByRole('button', { name: en.reload }))
    const after = screen.getByTitle(en.frameTitle)
    expect(after.getAttribute('src')).toBe(VIEWER_ROUTE)
    expect(after).not.toBe(before)
  })
})

describe('viewer appearance', () => {
  afterEach(() => {
    document.body.removeAttribute('data-ds-dark-theme')
    document.body.removeAttribute('data-yh-style')
    document.body.style.removeProperty('--yh-alias-label-primary')
  })

  it('copies and updates the host theme inside the viewer', async () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    document.body.setAttribute('data-yh-style', 'terminal')
    document.body.style.setProperty('--yh-alias-label-primary', 'rgb(1, 2, 3)')
    renderPanel()
    const frame = screen.getByTitle(en.frameTitle) as HTMLIFrameElement
    const viewer = document.implementation.createHTMLDocument('viewer')
    Object.defineProperty(frame, 'contentDocument', { configurable: true, value: viewer })
    fireEvent.load(frame)
    const root = viewer.documentElement
    expect(root?.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(root?.getAttribute('data-yh-style')).toBe('terminal')
    expect(root?.style.getPropertyValue('--yh-alias-label-primary')).toBe('rgb(1, 2, 3)')
    document.body.removeAttribute('data-ds-dark-theme')
    document.body.setAttribute('data-yh-style', 'default')
    document.body.style.setProperty('--yh-alias-label-primary', 'rgb(4, 5, 6)')
    await waitFor(() => {
      expect(root?.hasAttribute('data-ds-dark-theme')).toBe(false)
      expect(root?.getAttribute('data-yh-style')).toBe('default')
      expect(root?.style.getPropertyValue('--yh-alias-label-primary')).toBe('rgb(4, 5, 6)')
    })
  })
})


describe('compound code map glyph', () => {
  it('renders at the sidebar size the framework requests', () => {
    const { container } = render(<MapPanelIcon {...{ size: 20 } as ComponentProps<typeof MapPanelIcon>} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
