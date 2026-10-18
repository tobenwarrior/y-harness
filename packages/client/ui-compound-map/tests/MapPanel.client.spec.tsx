// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

describe('compound code map glyph', () => {
  it('renders at the sidebar size the framework requests', () => {
    const { container } = render(<MapPanelIcon {...{ size: 20 } as ComponentProps<typeof MapPanelIcon>} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
