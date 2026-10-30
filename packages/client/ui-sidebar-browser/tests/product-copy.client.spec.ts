import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Browser application-origin copy', () => {
  it.each([undefined, 'Y Harness', 'Atlas', 'Étoile $& $`'])('uses the public display name %s without changing browser policy labels', async (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    vi.resetModules()
    const { en, zh } = await import('../src/client/locales.ts')
    const name = displayName ?? 'Y Harness'

    expect(en['error.application-origin']).toBe(`The embedded browser cannot open the ${name} application itself.`)
    expect(zh['error.application-origin']).toBe(en['error.application-origin'])
    expect(en['type.label']).toBe('Browser')
    expect(zh['type.label']).toBe(en['type.label'])
    expect(en['error.protocol']).toBe('Only HTTP and HTTPS addresses are supported; use Document Preview for local files.')
    expect(zh['error.protocol']).toBe(en['error.protocol'])
    expect(en['error.credentials']).toBe('Addresses cannot contain a username or password.')
    expect(zh['error.credentials']).toBe(en['error.credentials'])
  })
})
