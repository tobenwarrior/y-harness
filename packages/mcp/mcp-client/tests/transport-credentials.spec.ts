/** Credential-backed Streamable HTTP requests through the MCP transport. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '@modelcontextprotocol/client'
import { Context } from '@yharness/cordis'
import type { CredentialProvider } from '@yharness/credentials'
import { GITHUB_MCP_URL } from '@yharness/github-app-auth'
import { ToolCallId } from '@yharness/llm'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { apply, inject, type StreamableHttpConfig, Config } from '../src/index.ts'
import { createTransport } from '../src/transport.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

const config: StreamableHttpConfig = {
  transport: 'streamable-http',
  serverName: 'github',
  url: 'https://connector.example.test/mcp',
  headers: { 'X-MCP-Toolsets': 'repos,issues,pull_requests' },
  bearerTokenRef: 'GITHUB_MCP_TOKEN',
  toolCallTimeoutMs: 1_000,
  failOnStartupError: true,
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' } as const

const githubAppConfig: StreamableHttpConfig = {
  transport: 'streamable-http',
  serverName: 'github-app',
  url: GITHUB_MCP_URL,
  headers: { 'X-MCP-Toolsets': 'repos,issues,pull_requests' },
  githubAppAuthorization: true,
  toolCallTimeoutMs: 1_000,
  failOnStartupError: true,
}

afterEach(() => { vi.unstubAllGlobals() })

describe('credential-backed MCP transport', () => {
  it('reads the current host token for each request without storing it in the config', async () => {
    const resolve = vi.fn<CredentialProvider['resolve']>()
      .mockResolvedValueOnce({ value: 'first-token.fixture', source: 'fixture' })
      .mockResolvedValueOnce({ value: 'rotated-token.fixture', source: 'fixture' })
    const send = vi.fn<FetchLike>(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }))
    vi.stubGlobal('fetch', send)

    const transport = createTransport(config, { resolve })
    await transport.start()
    try {
      await transport.send(ping)
      await transport.send(ping)
    } finally {
      await transport.close()
    }

    expect(resolve.mock.calls).toEqual([['GITHUB_MCP_TOKEN'], ['GITHUB_MCP_TOKEN']])
    const headers = send.mock.calls.map(([, options]) => new Headers(options?.headers))
    expect(headers.map(request => request.get('Authorization')))
      .toEqual(['Bearer first-token.fixture', 'Bearer rotated-token.fixture'])
    expect(headers.map(request => request.get('X-MCP-Toolsets')))
      .toEqual(['repos,issues,pull_requests', 'repos,issues,pull_requests'])
    expect(send.mock.calls.map(([url, options]) => [String(url), options?.redirect])).toEqual([
      [config.url, 'error'], [config.url, 'error'],
    ])
    expect(config.headers).toEqual({ 'X-MCP-Toolsets': 'repos,issues,pull_requests' })
  })

  it.each([
    { url: 'http://connector.example.test/mcp', message: /HTTPS endpoint/ },
    { url: 'https://someone:credential@connector.example.test/mcp', message: /HTTPS endpoint/ },
    { headers: { authorization: 'Bearer other-fixture' }, message: /Authorization header/ },
    { bearerTokenRef: 'not a reference', message: /credential reference/ },
  ])('rejects invalid connection configuration before a request', ({ message, ...changes }) => {
    const resolve = vi.fn<CredentialProvider['resolve']>()
    expect(() => createTransport({ ...config, ...changes }, { resolve })).toThrow(message)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('registers and calls an authenticated tool through the running plugin', async () => {
    const server = await startHttpMcpFixture()
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt).await()
      await ctx.plugin(ToolRuntime).await()
      let token = 'initial-bearer.fixture'
      ctx.provide('credentials', { resolve: async () => ({ value: token, source: 'fixture' }) })
      const fetchLocal = globalThis.fetch
      vi.stubGlobal('fetch', (target: URL | string, init?: RequestInit) => {
        if (String(target) !== config.url) throw new Error('Unexpected request outside the test connector')
        return fetchLocal(server.url, init)
      })

      const resolved = Config({ ...config, reconnect: { enabled: false } })
      await ctx.plugin({ apply, inject }, resolved).await()
      expect(ctx.tools.get('mcp__github__ping')?.source).toEqual({ kind: 'mcp', serverName: 'github' })
      expect(server.authorization.length).toBeGreaterThan(0)
      expect([...new Set(server.authorization)]).toEqual(['Bearer initial-bearer.fixture'])

      const before = server.authorization.length
      token = 'rotated-bearer.fixture'
      const result = await ctx.tools.execute({
        name: 'mcp__github__ping', callId: ToolCallId('connector-check'),
        arguments: {}, signal: new AbortController().signal,
      })
      expect(result).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'pong' }] } })
      expect(server.calls).toEqual(['ping'])
      expect(server.authorization.slice(before)).toEqual(['Bearer rotated-bearer.fixture'])
    } finally {
      await ctx.fiber.dispose()
      await server.close()
    }
  })

  it('requires the host credential service only when a reference is configured', () => {
    expect(() => createTransport(config)).toThrow(/credential service/)
    const { bearerTokenRef: _ref, ...legacy } = config
    expect(() => createTransport(legacy)).not.toThrow()
  })

  it.each([
    [undefined, /No credential is set/],
    [{ value: 'private-looking.fixture\nvalue', source: 'fixture' }, /Invalid bearer token/],
  ])('stops a request when its credential is missing or malformed', async (credential, message) => {
    const send = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', send)
    const transport = createTransport(config, { resolve: vi.fn<CredentialProvider['resolve']>().mockResolvedValue(credential) })
    await transport.start()
    try {
      await expect(transport.send(ping)).rejects.toThrow(message)
      await expect(transport.send(ping)).rejects.not.toThrow('private-looking.fixture')
    } finally {
      await transport.close()
    }
    expect(send).not.toHaveBeenCalled()
  })
})

describe('GitHub App-authorized MCP transport', () => {
  it('requests a current provider token for each request and refuses redirects', async () => {
    const tokenFor = vi.fn<(endpoint: URL) => Promise<string | undefined>>()
      .mockResolvedValueOnce('github-first.fixture')
      .mockResolvedValueOnce('github-rotated.fixture')
    const send = vi.fn<FetchLike>(async () => Response.json({ jsonrpc: '2.0', id: 1, result: {} }))
    vi.stubGlobal('fetch', send)

    const transport = createTransport(githubAppConfig, undefined, { tokenFor })
    await transport.start()
    try {
      await transport.send(ping)
      await transport.send(ping)
    } finally {
      await transport.close()
    }

    expect(tokenFor.mock.calls.map(([endpoint]) => endpoint.href)).toEqual([GITHUB_MCP_URL, GITHUB_MCP_URL])
    const headers = send.mock.calls.map(([, options]) => new Headers(options?.headers))
    expect(headers.map(request => request.get('Authorization')))
      .toEqual(['Bearer github-first.fixture', 'Bearer github-rotated.fixture'])
    expect(headers.map(request => request.get('X-MCP-Toolsets')))
      .toEqual(['repos,issues,pull_requests', 'repos,issues,pull_requests'])
    expect(send.mock.calls.map(([url, options]) => [String(url), options?.redirect])).toEqual([
      [GITHUB_MCP_URL, 'error'], [GITHUB_MCP_URL, 'error'],
    ])
  })

  it.each([
    { url: 'https://api.githubcopilot.com/mcp', message: /exact official endpoint/ },
    { url: 'https://api.githubcopilot.com/mcp/?fixture=1', message: /exact official endpoint/ },
    { headers: { Authorization: 'Bearer fixture' }, message: /Authorization header/ },
    { bearerTokenRef: 'GITHUB_MCP_TOKEN', message: /bearerTokenRef/ },
  ])('rejects unsafe GitHub App configuration before a request', ({ message, ...changes }) => {
    const tokenFor = vi.fn<(endpoint: URL) => Promise<string | undefined>>()
    expect(() => createTransport({ ...githubAppConfig, ...changes }, undefined, { tokenFor })).toThrow(message)
    expect(tokenFor).not.toHaveBeenCalled()
  })

  it('requires the optional provider service', () => {
    expect(() => createTransport(githubAppConfig)).toThrow(/github-app-auth service/)
  })

  it('does not send a request when the provider has no usable grant', async () => {
    const send = vi.fn<FetchLike>()
    vi.stubGlobal('fetch', send)
    const transport = createTransport(githubAppConfig, undefined, {
      tokenFor: vi.fn<(endpoint: URL) => Promise<string | undefined>>().mockResolvedValue(undefined),
    })
    await transport.start()
    try {
      await expect(transport.send(ping)).rejects.toThrow(/needs authentication/)
    } finally {
      await transport.close()
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a malformed provider token before sending it', async () => {
    const send = vi.fn<FetchLike>()
    vi.stubGlobal('fetch', send)
    const transport = createTransport(githubAppConfig, undefined, {
      tokenFor: vi.fn<(endpoint: URL) => Promise<string | undefined>>().mockResolvedValue('token.fixture\nleak'),
    })
    await transport.start()
    try {
      await expect(transport.send(ping)).rejects.toThrow(/Invalid GitHub App access token/)
    } finally {
      await transport.close()
    }
    expect(send).not.toHaveBeenCalled()
  })
})
