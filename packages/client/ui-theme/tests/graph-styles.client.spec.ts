/** Graph canvases remain dark and readable across independent style and color preferences. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRules } from './stylesheet-scan.ts'

const platform = readFileSync(new URL('../src/styles/design-platform.css', import.meta.url), 'utf8')
const terminal = readFileSync(new URL('../src/styles/terminal.css', import.meta.url), 'utf8')

function tokensFor(dark: boolean, terminalStyle: boolean): Map<string, string> {
  const selectors = new Set(['body'])
  if (dark) selectors.add('body[data-ds-dark-theme]')
  if (terminalStyle) selectors.add("body[data-yh-style='terminal']")
  return new Map(parseRules(platform + '\n' + terminal)
    .filter(rule => rule.selectors.some(selector => selectors.has(selector)))
    .flatMap(rule => rule.declarations))
}

function rgb(tokens: Map<string, string>, name: string): readonly number[] {
  const value = tokens.get(name)
  if (value === undefined) throw new Error(`missing graph token ${name}`)
  const reference = /^var\((--[\w-]+)\)$/.exec(value)
  if (reference !== null) return rgb(tokens, reference[1]!)
  const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(value)
  if (channels === null) throw new Error(`expected opaque palette color for ${name}: ${value}`)
  return channels.slice(1).map(Number)
}

function luminance(channels: readonly number[]): number {
  const linear = channels.map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
}

function contrast(first: readonly number[], second: readonly number[]): number {
  const a = luminance(first); const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('graph palette roles', () => {
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('keeps charcoal and readable graph roles (dark=%s, terminal=%s)', (dark, terminalStyle) => {
    const tokens = tokensFor(dark, terminalStyle)
    const colors = {
      bg: rgb(tokens, '--yh-alias-graph-bg'), ink: rgb(tokens, '--yh-alias-graph-ink'),
      muted: rgb(tokens, '--yh-alias-graph-muted'), edge: rgb(tokens, '--yh-alias-graph-edge'),
      accent: rgb(tokens, '--yh-alias-graph-accent'),
    }
    expect(Math.max(...colors.bg)).toBeLessThanOrEqual(40)
    expect(contrast(colors.ink, colors.bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.muted, colors.bg)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.edge, colors.bg)).toBeGreaterThanOrEqual(3)
    expect(contrast(colors.accent, colors.bg)).toBeGreaterThanOrEqual(3)
    expect(tokens.get('--yh-alias-graph-accent')).toBe(terminalStyle
      ? 'var(--yh-terminal-accent)' : 'var(--yh-static-blue-450)')
  })
})
