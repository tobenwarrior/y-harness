import { afterEach, expect, it, vi } from 'vitest'
import { catalogProvider } from '../src/catalog.ts'

// A subscription route must not reuse pi/Codex's registered OAuth identity.
it('offers a distinct ChatGPT subscription provider on the public Responses API', () => {
  const provider = catalogProvider('chatgpt')
  expect(provider?.name).toBe('ChatGPT')
  expect(provider?.baseUrl).toBe('https://api.openai.com/v1')
  expect(provider?.auth.oauth?.isSubscription).toBe(true)
  expect(provider?.auth.apiKey).toBeUndefined()
})

afterEach(() => vi.unstubAllGlobals())
