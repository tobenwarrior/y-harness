/** Session ownership guidance uses the public app label while keeping command identities. */
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each([undefined, 'Y Harness', 'Atlas', '\u{661F}\u{56FE} $& $`'])('names the application in session ownership guidance for %s', async (displayName) => {
  vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
  vi.resetModules()
  const { en, zh } = await import('../src/client/locales.ts')
  const name = displayName ?? 'Y Harness'
  expect(en['error.sessionInUse']).toBe(`This session is already in use, possibly by another running ${name} instance (such as yharness web or the desktop app). Quit other running ${name} instances and try again.`)
  expect(zh['error.sessionInUse']).toBe(en['error.sessionInUse'])
  expect(en['error.sessionInUse']).toContain('yharness web')
  expect(zh['error.sessionInUse']).toContain('yharness web')
})
