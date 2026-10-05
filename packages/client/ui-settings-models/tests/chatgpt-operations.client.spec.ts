/** Optional provider namespace resolution through the production Cordis service proxy. */
import { Context, Service } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ChatGPTView, ModelsOperations } from '../src/client/operations.ts'

class Remote extends Service {
  constructor(ctx: Context) { super(ctx, 'remote') }
}

it('reads the optional ChatGPT namespace without requiring it in the Models plugin inject list', async () => {
  const ctx = new Context()
  new Remote(ctx)
  const state: ChatGPTView = { accounts: [], busy: false }
  const getState = vi.fn(async () => ({ ok: true as const, value: state }))
  await ctx.plugin({ apply: (providerCtx) => { providerCtx.provide('remote.chatGPT', { getState }) } }).await()
  let operations: ModelsOperations | undefined
  try {
    await ctx.plugin({ inject: ['remote'], apply: (pluginCtx) => { operations = createModelsOperations(pluginCtx) } }).await()
    await expect(operations?.chatGPT?.getState()).resolves.toEqual(state)
    expect(getState).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it('keeps the Models page usable when the optional ChatGPT namespace is absent', async () => {
  const ctx = new Context()
  new Remote(ctx)
  let operations: ModelsOperations | undefined
  try {
    await ctx.plugin({ inject: ['remote'], apply: (pluginCtx) => { operations = createModelsOperations(pluginCtx) } }).await()
    expect(operations?.chatGPT).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
