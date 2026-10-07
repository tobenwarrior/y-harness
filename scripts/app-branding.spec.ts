import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { readAppDisplayName } from './app-branding.mjs'

function fixture(displayName: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-app-branding-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'app-branding.json'), JSON.stringify({ displayName }))
  return root
}

it('retains existing labels until a public display name is configured', () => {
  expect(readAppDisplayName(fixture(null))).toBeUndefined()
  expect(readAppDisplayName(fixture('  Atlas & Co.  '))).toBe('Atlas & Co.')
  expect(readAppDisplayName(fixture('星 Atlas'))).toBe('星 Atlas')
})

it.each(['', '  ', 'Atlas\nNext', 'Atlas\u2028Next', 42, {}, undefined])('rejects an unusable display label %j', (value) => {
  expect(() => readAppDisplayName(fixture(value))).toThrow(/displayName/)
})

it.each([null, [], 'Atlas'])('rejects a configuration without the displayName field %j', (value) => {
  const root = fixture(null)
  writeFileSync(join(root, 'app-branding.json'), JSON.stringify(value))
  expect(() => readAppDisplayName(root)).toThrow(/displayName/)
})
