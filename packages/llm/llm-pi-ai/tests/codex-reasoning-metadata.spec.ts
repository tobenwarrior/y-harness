/** Resolve the native catalog through the real LLM metadata validator without requesting a turn. */
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CodexBackendAdapter, CodexBackendRuntime } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

const catalogCases = [
  { name: 'empty native effort list', row: { supportedReasoningEfforts: [] }, reasoning: undefined },
  { name: 'omitted native effort list', row: {}, reasoning: undefined },
  { name: 'native effort vocabulary and default', row: {
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'ultra', description: 'Ultra' }],
    defaultReasoningEffort: 'ultra',
  }, reasoning: { efforts: [{ id: 'low', name: 'low', description: 'Low' }, { id: 'ultra', name: 'ultra', description: 'Ultra' }],
    defaultEffort: 'ultra' } },
]

describe('native Codex reasoning metadata at the LLM seam', () => {
  it.each(catalogCases)('resolves $name without synthesizing reasoning choices', async ({ row, reasoning }) => {
    const ctx = new Context(); await ctx.plugin(Llm)
    const request = vi.fn<CodexPeer['request']>(async (method) => {
      if (method === 'initialize') return {}
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture',
        inputModalities: ['text'], serviceTiers: [{ id: 'priority', name: 'Fast' }], ...row }] }
      throw new Error(`Unexpected native method: ${method}`)
    })
    const close = vi.fn(); const access = vi.fn(() => { throw new Error('Metadata reads must not resolve execution access') })
    const peer: CodexPeer = { request, notify() {}, subscribe: () => () => {}, close }
    const runtime = new CodexBackendRuntime({ connect: async () => peer, resolveAccess: access,
      preferences: { enabled: false, models: [], tiers: {}, auto: false }, persist: async () => {} })
    onTestFinished(async () => { runtime.close(); await ctx.fiber.dispose() })
    await runtime.refresh()
    const owner = ctx.llm.registerAdapter(['codex-backend'], new CodexBackendAdapter(runtime))
    const info = await ctx.llm.resolveModelInfo('codex-backend', 'fixture-model')
    expect(info).toMatchObject({ provider: 'codex-backend', id: 'fixture-model', inputModalities: ['text'],
      serviceTiers: { tiers: [{ id: 'default', name: 'Standard' }, { id: 'priority', name: 'Fast' }], defaultTier: 'default' } })
    expect(info.reasoning).toEqual(reasoning)
    if (reasoning === undefined) expect(Object.hasOwn(info, 'reasoning')).toBe(false)
    expect(access).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([method]) => method)).toEqual(['initialize', 'account/read', 'model/list'])
    owner()
    expect(ctx.llm.listProviders()).toEqual([])
  })
})
