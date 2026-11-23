/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL.
 *
 * @module
 */

import type { AuthProvider, Transport } from '@modelcontextprotocol/client'
import { credentialRef, isCredentialRefName, type CredentialProvider } from '@yharness/credentials'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@yharness/subprocess'
import type { Config, StreamableHttpConfig } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/** Bind host credentials to one HTTPS origin and resolve them for each request. */
function bearerAuthentication(
  endpoint: URL,
  config: StreamableHttpConfig,
  refName: string,
  credentials: Pick<CredentialProvider, 'resolve'> | undefined,
): AuthProvider {
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new Error('bearerTokenRef requires an HTTPS endpoint without URL credentials')
  }
  if (new Headers(config.headers).has('Authorization')) {
    throw new Error('Configure either bearerTokenRef or an Authorization header')
  }
  if (!isCredentialRefName(refName)) throw new Error('bearerTokenRef must name a credential reference')
  if (credentials === undefined) throw new Error('bearerTokenRef requires the host credential service')
  const ref = credentialRef(refName)
  return {
    async token() {
      const credential = await credentials.resolve(ref)
      if (credential === undefined) throw new Error('No credential is set for bearerTokenRef')
      // RFC 6750 token characters can be placed in an HTTP header without escaping.
      if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(credential.value)) throw new Error('Invalid bearer token')
      return credential.value
    },
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on transport.
 * @param credentials - Host credential service for reference-backed HTTP authentication.
 * @returns A connected-ready MCP Transport.
 */
export function createTransport(config: Config, credentials?: Pick<CredentialProvider, 'resolve'>): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const endpoint = new URL(config.url)
      const requestInit = { headers: config.headers }
      if (config.bearerTokenRef === undefined) return new StreamableHTTPClientTransport(endpoint, { requestInit })
      return new StreamableHTTPClientTransport(endpoint, {
        requestInit: { ...requestInit, redirect: 'error' },
        authProvider: bearerAuthentication(endpoint, config, config.bearerTokenRef, credentials),
      })
    }
  }
}
