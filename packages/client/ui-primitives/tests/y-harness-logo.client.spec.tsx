// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { YHarnessLogo } from '../src/YHarnessLogo.tsx'

afterEach(cleanup)

it('keeps the Y artwork and both original circles from the verified native vector', () => {
  const source = new DOMParser().parseFromString(readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/desktop/resources/icon.svg'), 'utf8',
  ), 'image/svg+xml')
  const { container } = render(<YHarnessLogo />)
  expect(container.querySelector('path')?.getAttribute('d')).toBe(source.querySelector('path')?.getAttribute('d'))
  expect(container.querySelector('path')?.getAttribute('fill')).toBe('currentColor')
  const circles = (node: ParentNode) => Array.from(node.querySelectorAll('circle'), circle =>
    ['cx', 'cy', 'r', 'fill'].map(attribute => circle.getAttribute(attribute)))
  expect(circles(container)).toEqual(circles(source))
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
})

it('honors the host width and layout class while preserving the original proportions', () => {
  const { container, rerender } = render(<YHarnessLogo size={34} className="hero-mark" />)
  const svg = container.querySelector('svg')
  expect(svg?.getAttribute('width')).toBe('34')
  expect(Number(svg?.getAttribute('height'))).toBeCloseTo(28.18, 2)
  expect(svg?.getAttribute('class')).toBe('hero-mark')
  rerender(<YHarnessLogo size={24} />)
  expect(svg?.getAttribute('width')).toBe('24')
})
