/** Optional appearance rules cannot leak into the default theme or change shell geometry. */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRules } from './stylesheet-scan.ts'

const sheet = new URL('../src/styles/terminal.css', import.meta.url)
const gate = "body[data-yh-style='terminal']"
const gatedSelector = /^(?:html(?:\[data-[^\]]+\])*\s+)?body\[data-yh-style='terminal'\](?:\s|$)/

describe('Terminal appearance isolation', () => {
  it('ships an opt-in stylesheet with every selector behind the appearance gate', () => {
    expect(existsSync(sheet)).toBe(true)
    const rules = parseRules(readFileSync(sheet, 'utf8'))
    expect(rules.length).toBeGreaterThan(0)
    expect(rules.flatMap(rule => rule.selectors).filter(selector => !gatedSelector.test(selector))).toEqual([])
  })

  it('keeps the opt-in cosmetic without importing assets or changing shell sizing and focus', () => {
    expect(existsSync(sheet)).toBe(true)
    const css = readFileSync(sheet, 'utf8')
    expect(css).not.toMatch(/@(?:import|font-face|keyframes)|:has\(|url\(/)
    const forbidden = new Set([
      'animation', 'animation-name', 'outline', 'outline-style', 'display', 'overflow',
      'grid-template-columns', 'grid-template-rows', 'position', 'z-index',
    ])
    expect(parseRules(css).flatMap(rule => rule.declarations
      .filter(([property, value]) => forbidden.has(property)
        && !(property === 'display' && value === 'inline-flex' && rule.selectors.every(selector =>
          selector.endsWith("[aria-selected='true'] [data-yh-part='session-prompt']"))))
      .map(([property]) => `${rule.selectors.join(', ')}: ${property}`))).toEqual([])
  })

  it('reveals the presentational prompt only on the selected Terminal Session', () => {
    const rules = parseRules(readFileSync(sheet, 'utf8'))
    const visiblePrompts = rules.filter(rule => rule.declarations.some(([name, value]) =>
      name === 'display' && value !== 'none'))
    expect(visiblePrompts).toHaveLength(1)
    expect(visiblePrompts[0]?.selectors).toEqual([
      `${gate} [data-yh-part='sidebar'] [data-row-key^='session:'][aria-selected='true'] [data-yh-part='session-prompt']`,
    ])
    const rowStyles = readFileSync(new URL('../../ui-workspace/src/client/rows/Rows.module.css', import.meta.url), 'utf8')
    expect(parseRules(rowStyles).filter(rule => rule.selectors.includes('.terminalPrompt'))
      .flatMap(rule => rule.declarations)).toContainEqual(['display', 'none'])
  })

  it('retains the sans-serif reading font while limiting monospace to interface labels', () => {
    expect(existsSync(sheet)).toBe(true)
    const rules = parseRules(readFileSync(sheet, 'utf8'))
    const monospaceSelectors = rules.filter(rule => rule.declarations.some(([name, value]) =>
      name === 'font-family' && value.includes('--ds-font-family-code'))).flatMap(rule => rule.selectors)
    expect(monospaceSelectors.length).toBeGreaterThan(0)
    expect(monospaceSelectors).not.toContain(gate)
    expect(monospaceSelectors.some(selector => /assistant-prose|user-bubble|contenteditable|(?:^|\s)\*/.test(selector))).toBe(false)
    expect(rules.flatMap(rule => rule.declarations).filter(([name]) =>
      name === '--yh-font-family' || name === '--yh-font-family-brand' || name.startsWith('--yh-font-markdown-'))).toEqual([])
    expect(rules.filter(rule => rule.selectors.some(selector => selector.includes('assistant-prose')))
      .flatMap(rule => rule.declarations).filter(([name]) => name === 'font-family'))
      .toContainEqual(['font-family', 'var(--yh-font-family)'])
  })
})
