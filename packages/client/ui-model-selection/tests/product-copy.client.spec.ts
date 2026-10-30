import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Model selection session-lock copy', () => {
  it.each([undefined, 'Y Harness', 'Atlas', 'Star Chart $& $`'])('uses the public display name %s while preserving commands and providers', async (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    vi.resetModules()
    const { en, zh } = await import('../src/client/locales.ts')
    const name = displayName ?? 'Y Harness'

    expect(en['error.sessionInUse']).toBe(`This session is already in use, possibly by another running ${name} instance (such as yharness web or the desktop app). Quit other running ${name} instances and try again.`)
    expect(zh['error.sessionInUse']).toBe(en['error.sessionInUse'])
    expect(en['provider.account']).toBe('DeepSeek Account')
    expect(zh['provider.account']).toBe(en['provider.account'])
    expect(en['command.label']).toBe('Model')
    expect(zh['command.label']).toBe(en['command.label'])
    expect(en['command.description']).toBe('Select the model for this conversation')
    expect(zh['command.description']).toBe(en['command.description'])
  })
})
