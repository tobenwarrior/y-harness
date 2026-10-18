import { describe, expect, it } from 'vitest'
import { compareReleases, recordVendoredRelease, recordVendoredVersion } from './vendor-compound.ts'

describe('release comparison', () => {
  it('orders dot-separated parts numerically, not as text', () => {
    expect(compareReleases('0.11.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareReleases('0.9.0', '0.11.0')).toBeLessThan(0)
    expect(compareReleases('1.0.0', '1.0.0')).toBe(0)
    expect(compareReleases('1.0', '1.0.0')).toBe(0)
  })
})

describe('upstream record', () => {
  const source = [
    '# Vendored upstream',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Upstream repository | `https://github.com/tobenwarrior/compound-skills` |',
    '| Vendored version | `0.11.0` (upstream `plugin.json`) |',
    '| Vendored commit | `a9e2e9ef5f76d68089034522b89b8330a2c49d4d` (2026-10-17) |',
    '| Vendored on | 2026-10-18 |',
    '| Upstream license | MIT, `Copyright (c) 2026 tobenwarrior` |',
  ].join('\n')

  it('records the release, commit, and date without touching other rows', () => {
    const next = recordVendoredRelease(source, '0.12.0', 'b'.repeat(40), '2026-10-19')
    expect(next).toContain('| Vendored version | `0.12.0` (upstream `plugin.json`) |')
    expect(next).toContain(`| Vendored commit | \`${'b'.repeat(40)}\` (2026-10-19) |`)
    expect(next).toContain('| Vendored on | 2026-10-19 |')
    expect(next).toContain('| Upstream repository | `https://github.com/tobenwarrior/compound-skills` |')
    expect(next).toContain('| Upstream license | MIT, `Copyright (c) 2026 tobenwarrior` |')
  })

  it('replaces the version constant and nothing else', () => {
    const module = [
      '/** Release of the vendored content. */',
      "export const VENDORED_VERSION = '0.11.0'",
      '',
      "export const UPSTREAM_REPOSITORY = 'tobenwarrior/compound-skills'",
    ].join('\n')
    const next = recordVendoredVersion(module, '0.12.0')
    expect(next).toContain("export const VENDORED_VERSION = '0.12.0'")
    expect(next).toContain("export const UPSTREAM_REPOSITORY = 'tobenwarrior/compound-skills'")
  })
})
