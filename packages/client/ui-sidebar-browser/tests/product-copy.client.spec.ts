import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Browser application-origin copy', () => {
  it.each([undefined, 'Y Harness', 'Atlas', '星图 $& $`'])('uses the public display name %s without changing browser policy labels', async (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    vi.resetModules()
    const { en, zh } = await import('../src/client/locales.ts')
    const name = displayName ?? 'Y Harness'

    expect(en['error.application-origin']).toBe(`The embedded browser cannot open the ${name} application itself.`)
    expect(zh['error.application-origin']).toBe(`不能在嵌入浏览器中打开 ${name} 应用自身。`)
    expect(en['type.label']).toBe('Browser')
    expect(zh['type.label']).toBe('浏览器')
    expect(en['error.protocol']).toBe('Only HTTP and HTTPS addresses are supported; use Document Preview for local files.')
    expect(zh['error.protocol']).toBe('只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。')
    expect(en['error.credentials']).toBe('Addresses cannot contain a username or password.')
    expect(zh['error.credentials']).toBe('地址不能包含用户名或密码。')
  })
})
