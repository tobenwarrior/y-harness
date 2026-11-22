/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  calls: string[]
  authorization: Array<string | undefined>
  close: () => Promise<void>
}

/**
 * Start a local stateless MCP endpoint.
 * @param toolNames - Names to advertise, each returning the same fixture response.
 * @returns The fixture URL, observed requests, and teardown.
 */
export async function startHttpMcpFixture(toolNames: readonly string[] = ['ping']): Promise<HttpMcpFixture> {
  const calls: string[] = []
  const authorization: Array<string | undefined> = []
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    for (const name of toolNames) {
      mcp.registerTool(name, { description: 'Replies pong.', inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
        calls.push(name)
        return { content: [{ type: 'text', text: 'pong' }] }
      })
    }
    return mcp
  })
  const handle = toNodeHandler(handler)
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    // The adapter excludes explicit undefined on Node's optional HTTP fields.
    await handle(request as NodeIncomingMessageLike, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    calls,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
