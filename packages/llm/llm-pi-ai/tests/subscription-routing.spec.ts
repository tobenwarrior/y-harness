import { afterEach, expect, it, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { catalogModels } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
afterEach(() => { vi.unstubAllGlobals(); seen.splice(0) })
function captureRequests(): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init)
    seen.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) as Record<string, unknown> })
    return Response.json({ error: { message: 'Mock authorization refusal', type: 'authentication_error' } }, { status: 401 })
  })
}
it.each([
  ['openai-completions', '/zen/go/v1/chat/completions'],
  ['openai-responses', '/zen/go/v1/responses'],
  ['anthropic-messages', '/zen/go/v1/messages'],
])('sends OpenCode Go %s with its own endpoint and conversation attribution', async (api, path) => {
  captureRequests()
  const model = [...catalogModels('opencode-go').values()].find(model => model.api === api)!
  expect(model).toBeDefined()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ 'opencode-go': {} }), resolveApiKey: async () => 'mock-go-key', auth: memoryAuth() })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'opencode-go', model: model.id, messages: [], sessionId: 'mock-conversation' as never })) chunks.push(chunk)
  expect(seen).toHaveLength(1)
  const target = new URL(seen[0]!.url)
  expect(target.origin + target.pathname).toBe(`https://opencode.ai${path}`)
  // The native Anthropic beta client adds its standard query flag; routing
  // is defined by the origin/path, while the installed SDK owns this flag.
  expect(target.searchParams.get('beta')).toBe(api === 'anthropic-messages' ? 'true' : null)
  expect(seen[0]!.headers.get('x-opencode-session')).toBe('mock-conversation')
  expect(seen[0]!.headers.get('user-agent')).toMatch(/deepseek|dsh/i)
  expect(seen[0]!.body.model).toBe(model.id)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})
it.each(['minimax-m2.7', 'qwen3.7-plus', 'qwen3.8-max'])('routes OpenCode Go %s through the advertised Messages endpoint', async (model) => {
  captureRequests()
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ 'opencode-go': {} }), resolveApiKey: async () => 'mock-go-key', auth: memoryAuth() })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'opencode-go', model, messages: [], sessionId: 'mock-conversation' as never })) chunks.push(chunk)
  expect(seen).toHaveLength(1)
  const target = new URL(seen[0]!.url)
  expect(target.origin + target.pathname).toBe('https://opencode.ai/zen/go/v1/messages')
  expect(seen[0]!.headers.get('x-api-key')).toBe('mock-go-key')
  expect(seen[0]!.headers.get('x-opencode-session')).toBe('mock-conversation')
  expect(seen[0]!.body.model).toBe(model)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})
