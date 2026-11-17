// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { BotsPanelIcon } from '../src/client/BotsPanelIcon.tsx'

afterEach(cleanup)

it('renders a decorative glyph at the size requested by the sidebar', () => {
  const props = { size: 20, active: false } as ComponentProps<typeof BotsPanelIcon>
  const { container } = render(<BotsPanelIcon {...props} />)
  const svg = container.querySelector('svg')
  expect(svg?.getAttribute('width')).toBe('20')
  expect(svg?.getAttribute('aria-hidden')).toBe('true')
})
