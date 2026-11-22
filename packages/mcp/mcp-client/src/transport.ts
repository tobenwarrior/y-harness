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
import { GITHUB_MCP_URL } from '@yharness/github-app-auth'
import type GitHubAppAuth from '@yharness/github-app-auth'
import type { Config, StreamableHttpConfig } from './index.ts'

type GitHubAppAuthService = Pick<GitHubAppAuth, 'status' | 'tokenFor'>
type GitHubAppTokenProvider = Pick<GitHubAppAuthService, 'tokenFor'>

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/** Return whether a case-insensitive Authorization header was configured. */
function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return headers !== undefined && new Headers(headers).has('Authorization')
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
  if (hasAuthorizationHeader(config.headers)) {
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

/** Bind the Host-owned GitHub App grant to the one official MCP endpoint. */
function githubAppAuthentication(endpoint: URL, config: StreamableHttpConfig, auth: GitHubAppTokenProvider | undefined): AuthProvider {
  if (endpoint.href !== GITHUB_MCP_URL) {
    throw new Error(`githubAppAuthorization requires the exact official endpoint ${GITHUB_MCP_URL}`)
  }
  if (hasAuthorizationHeader(config.headers)) {
    throw new Error('Configure either githubAppAuthorization or an Authorization header')
  }
  if (config.bearerTokenRef !== undefined) {
    throw new Error('Configure either githubAppAuthorization or bearerTokenRef')
  }
  if (auth === undefined) throw new Error('githubAppAuthorization requires the host github-app-auth service')
  return {
    async token() {
      const token = await auth.tokenFor(endpoint)
      if (token === undefined) throw new Error('GitHub App authorization needs authentication')
      // RFC 6750 token characters can be placed in an HTTP header without escaping.
      if (!/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) throw new Error('Invalid GitHub App access token')
      return token
    },
  }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on transport.
 * @param credentials - Host credential service for reference-backed HTTP authentication.
 * @param githubAppAuth - Optional Host-owned GitHub App authorization service.
 * @returns A connected-ready MCP Transport.
 */
export function createTransport(
  config: Config,
  credentials?: Pick<CredentialProvider, 'resolve'>,
  githubAppAuth?: GitHubAppTokenProvider,
): Transport {
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
      if (config.githubAppAuthorization === true) {
        return new StreamableHTTPClientTransport(endpoint, {
          requestInit: { ...requestInit, redirect: 'error' },
          authProvider: githubAppAuthentication(endpoint, config, githubAppAuth),
        })
      }
      if (config.bearerTokenRef === undefined) {
        return new StreamableHTTPClientTransport(endpoint, { requestInit })
      }
      return new StreamableHTTPClientTransport(endpoint, {
        requestInit: { ...requestInit, redirect: 'error' },
        authProvider: bearerAuthentication(endpoint, config, config.bearerTokenRef, credentials),
      })
    }
  }
}
