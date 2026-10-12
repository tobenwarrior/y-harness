/** Session ownership guidance uses the public app label while keeping command identities. */
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each([undefined, 'Y Harness', 'Atlas', '星图 $& $`'])('names the application in session ownership guidance for %s', async (displayName) => {
  vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
  vi.resetModules()
  const { en, zh } = await import('../src/client/locales.ts')
  const name = displayName ?? 'Y Harness'
  expect(en['error.sessionInUse']).toBe(`This session is already in use, possibly by another running ${name} instance (such as dsh web or the desktop app). Quit other running ${name} instances and try again.`)
  expect(zh['error.sessionInUse']).toBe(`当前会话已被占用，可能是其他正在运行的 ${name} 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 ${name} 后重试。`)
  expect(en['error.sessionInUse']).toContain('dsh web')
  expect(zh['error.sessionInUse']).toContain('dsh web')
})
