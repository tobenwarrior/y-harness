import { beforeAll, afterEach, expect, it, vi } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { exchangeGrant } from '../src/chatgpt-protocol.ts'

// Ephemeral mock keys sign test tokens; no provider grants are requested.
let signing: CryptoKey
let jwk: Awaited<ReturnType<typeof exportJWK>>
beforeAll(async () => { const keys = await generateKeyPair('RS256'); signing = keys.privateKey; jwk = { ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' } })
afterEach(() => vi.unstubAllGlobals())
const attempt = { state: 'mock-state', nonce: 'mock-nonce', verifier: 'mock-verifier', hostId: 'urn:uuid:mock-host', redirectUri: 'http://127.0.0.1:23456/auth/callback' }
const callback = new URLSearchParams('state=mock-state&code=mock-code&client_id=oaiapp_test')
async function mockIssuer(overrides: { nonce?: string; audience?: string; issuer?: string; expires?: number; scopes?: string } = {}) {
  const idToken = await new SignJWT({ nonce: overrides.nonce ?? attempt.nonce, email: 'user@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(overrides.issuer ?? 'https://auth.openai.com')
    .setAudience(overrides.audience ?? 'oaiapp_test').setSubject('mock-user').setIssuedAt()
    .setExpirationTime(overrides.expires ?? Math.floor(Date.now() / 1000) + 300).sign(signing)
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const request = new Request(url, init); requests.push(request)
    if (request.url.endsWith('/api/accounts/oauth/token')) return Response.json({ access_token: 'mock-access', refresh_token: 'mock-refresh', id_token: idToken, scope: overrides.scopes ?? 'chatgpt.tokens.use.direct offline_access openid', token_type: 'Bearer', expires_in: 3600 })
    if (request.url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/mock-jwks' })
    if (request.url.endsWith('/mock-jwks')) return Response.json({ keys: [jwk] })
    throw new Error('Unexpected mock endpoint')
  })
  return requests
}
it('verifies signature and identity and exchanges the code with exact redirect URI and PKCE', async () => {
  const requests = await mockIssuer()
  expect(await exchangeGrant(callback, attempt, new AbortController().signal)).toMatchObject({ clientId: 'oaiapp_test', subject: 'mock-user', email: 'user@example.test', access: 'mock-access' })
  expect(Object.fromEntries(new URLSearchParams(await requests[0]!.text()))).toEqual({ grant_type: 'authorization_code', client_id: 'oaiapp_test', code: 'mock-code', code_verifier: 'mock-verifier', redirect_uri: attempt.redirectUri, resource: 'https://api.openai.com/v1' })
})
it.each([{ nonce: 'wrong' }, { audience: 'other' }, { issuer: 'https://other.example' }, { expires: 1 }])('rejects mismatched signed identity claims %j', async overrides => {
  await mockIssuer(overrides)
  await expect(exchangeGrant(callback, attempt, new AbortController().signal)).rejects.toThrow('identity')
})
it('rejects returning-account identity changes and missing plan permission', async () => {
  await mockIssuer()
  await expect(exchangeGrant(callback, { ...attempt, clientId: 'oaiapp_test', subject: 'other-user' }, new AbortController().signal)).rejects.toThrow('identity')
  await mockIssuer({ scopes: 'openid profile email' })
  await expect(exchangeGrant(callback, attempt, new AbortController().signal)).rejects.toThrow('plan use')
})
