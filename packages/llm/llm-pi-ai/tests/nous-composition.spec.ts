/** Native Nous routes boot through Loader and use only the selected public client identity. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import * as LlmPiAi from '../src/index.ts'
import { credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import type { NousGrant } from '../src/nous-protocol.ts'

const approvedClientId = 'approved-test-client'
const contexts: Context[] = []
const directories: string[] = []
const fetchRequests: Request[] = []
const syntheticFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init)
  fetchRequests.push(request)
  if (request.url !== 'https://inference-api.nousresearch.com/v1/chat/completions') {
    throw new Error('This composition test accepts only the synthetic inference request.')
  }
  return new Response([
    'data: {"id":"composition-test","object":"chat.completion.chunk","created":1,"model":"account/model","choices":[{"index":0,"delta":{"role":"assistant","content":"Native Nous response"},"finish_reason":null}]}',
    'data: {"id":"composition-test","object":"chat.completion.chunk","created":1,"model":"account/model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
})

beforeEach(() => {
  vi.stubGlobal('fetch', syntheticFetch)
  vi.stubEnv('DSH_CODEX_BINARY', '')
})
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
  fetchRequests.splice(0)
  syntheticFetch.mockClear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function grant(expires = Date.now() + 3_600_000): NousGrant {
  return { type: 'oauth', access: 'synthetic-composition-access', refresh: 'synthetic-composition-refresh', expires,
    clientId: approvedClientId, scope: 'inference:invoke', inferenceBaseURL: 'https://inference-api.nousresearch.com/v1' }
}

async function loadComposition(clientId?: string, existingDirectory?: string): Promise<{ ctx: Context; dir: string }> {
  const dir = existingDirectory ?? await mkdtemp(join(tmpdir(), 'dsh-nous-composition-'))
  if (existingDirectory === undefined) directories.push(dir)
  const configPath = join(dir, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(dir, '.credentials.yaml'))}`,
    '    watch: false',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    ...clientId === undefined ? [] : [`    nousClientId: ${JSON.stringify(clientId)}`],
    '    providers:',
    '      nous:',
    '        models:',
    '          - id: account/model',
    '            name: Account model',
    '            contextWindow: 32768',
    '            maxTokens: 2048',
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-authorization', AuthorizationService],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error(`Unexpected composition module: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('Unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
    resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
    load(): never { throw new Error('Unexpected module load') },
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)).toEqual([])
  await expect.poll(() => ctx.get('nousConnection') !== undefined).toBe(true)
  return { ctx, dir }
}

async function inference(ctx: Context) {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'nous', model: 'account/model', messages: [] })) assembler.push(chunk)
  return { finish: assembler.finish, message: assembler.message({ provider: 'nous', model: 'account/model' }) }
}

describe('native Nous Loader composition', () => {
  it('applies the default hermes-cli client identity and keeps a grant issued to another client dormant', async () => {
    const first = await loadComposition(approvedClientId)
    const expired = grant(Date.now() - 1)
    await credentialStoreFrom(first.ctx).modify('nous', async () => expired)
    await first.ctx.fiber.dispose()
    const { ctx } = await loadComposition(undefined, first.dir)

    expect(await ctx.nousConnection.getState()).toEqual({ configured: true, connected: false, busy: false })
    expect(ctx.authorization.describe(recordKeyFor('nous'))?.methods.map(method => method.id)).toEqual(['oauth'])
    expect(ctx.llm.listProviders()).toEqual([{ id: 'nous', name: 'nous' }])
    const result = await inference(ctx)
    expect(result.finish.kind).toBe('error')
    expect(result.finish.kind === 'error' ? result.finish.failure.message : undefined).toContain('public Nous client ID')
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(expired)
    expect(syntheticFetch).not.toHaveBeenCalled()
  })

  it('authenticates the native route with the default hermes-cli client identity', async () => {
    const { ctx } = await loadComposition(undefined)
    await credentialStoreFrom(ctx).modify('nous', async () => ({ ...grant(), clientId: 'hermes-cli' }))

    expect(await ctx.nousConnection.getState()).toMatchObject({ configured: true, connected: true, busy: false })
    const result = await inference(ctx)
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(fetchRequests[0]!.headers.get('authorization')).toBe('Bearer synthetic-composition-access')
  })

  it('uses a matching persisted OAuth grant for the native Chat Completions route', async () => {
    const { ctx } = await loadComposition(approvedClientId)
    const stored = grant()
    await credentialStoreFrom(ctx).modify('nous', async () => stored)

    expect(await ctx.nousConnection.getState()).toMatchObject({ configured: true, connected: true, busy: false })
    expect(ctx.authorization.describe(recordKeyFor('nous'))?.methods.map(method => method.id)).toEqual(['oauth'])
    expect((await ctx.llm.listModels('nous')).map(model => model.id)).toEqual(['account/model'])
    const result = await inference(ctx)
    expect({ finish: result.finish, content: result.message.content }).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Native Nous response",
            "type": "text",
          },
        ],
        "finish": {
          "kind": "stop",
        },
      }
    `)
    expect(syntheticFetch).toHaveBeenCalledOnce()
    expect(fetchRequests[0]!.headers.get('authorization')).toBe('Bearer synthetic-composition-access')
    expect(await fetchRequests[0]!.json()).toMatchObject({ model: 'account/model', stream: true })
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(stored)
    const authorization = ctx.authorization
    await ctx.fiber.dispose()
    expect(authorization.describe(recordKeyFor('nous'))).toBeUndefined()
  })

  it('refuses the previous grant after a restart changes the deployment client identity', async () => {
    const first = await loadComposition(approvedClientId)
    const expired = grant(Date.now() - 1)
    await credentialStoreFrom(first.ctx).modify('nous', async () => expired)
    await first.ctx.fiber.dispose()
    const { ctx } = await loadComposition('another-approved-test-client', first.dir)

    expect(await ctx.nousConnection.getState()).toMatchObject({ configured: true, connected: false, busy: false })
    const result = await inference(ctx)
    expect(result.finish.kind).toBe('error')
    expect(result.finish.kind === 'error' ? result.finish.failure.message : undefined).toContain('matching the stored connection')
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(expired)
    expect(syntheticFetch).not.toHaveBeenCalled()
  })
})
