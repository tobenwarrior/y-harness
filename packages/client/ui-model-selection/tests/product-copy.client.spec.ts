import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Model selection session-lock copy', () => {
  it.each([undefined, 'Y Harness', 'Atlas', '星图 $& $`'])('uses the public display name %s while preserving commands and providers', async (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    vi.resetModules()
    const { en, zh } = await import('../src/client/locales.ts')
    const name = displayName ?? 'Y Harness'

    expect(en['error.sessionInUse']).toBe(`This session is already in use, possibly by another running ${name} instance (such as dsh web or the desktop app). Quit other running ${name} instances and try again.`)
    expect(zh['error.sessionInUse']).toBe(`当前会话已被占用，可能是其他正在运行的 ${name} 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 ${name} 后重试。`)
    expect(en['provider.account']).toBe('DeepSeek Account')
    expect(zh['provider.account']).toBe('DeepSeek 账号')
    expect(en['command.label']).toBe('Model')
    expect(zh['command.label']).toBe('模型')
    expect(en['command.description']).toBe('Select the model for this conversation')
    expect(zh['command.description']).toBe('选择本会话使用的模型')
  })
})
