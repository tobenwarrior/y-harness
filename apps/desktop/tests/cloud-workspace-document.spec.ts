import { expect, it } from 'vitest'
import { cloudAction, cloudDocument, cloudRequestAllowed, cloudSignInCookie, cloudVaultRequestId, cloudWebsiteLoginUseRequestId } from '../src/cloud-workspace-document.ts'
import { en } from '../src/locale.ts'

it('accepts workspace actions only from the private control document', () => {
  expect(cloudAction('https://workspace.invalid/connect?target=fixture-host')).toEqual({
    type: 'connect', target: 'fixture-host',
  })
  expect(cloudAction('https://workspace.invalid/mac')).toEqual({ type: 'mac' })
  expect(cloudAction('https://workspace.invalid/vault')).toEqual({ type: 'vault' })
  expect(cloudAction('https://workspace.invalid/online')).toBeUndefined()
  expect(cloudAction('https://other.invalid/connect?target=fixture-host')).toBeUndefined()
  expect(cloudAction('https://name@workspace.invalid/mac')).toBeUndefined()
})

it('presents a workspace switch without a browser address or a server identifier', () => {
  const url = cloudDocument(en, 'online')
  const markup = decodeURIComponent(url.split(',')[1]!)
  expect(markup).toContain('>Mac<')
  expect(markup).toContain('>Cloud<')
  expect(markup).toContain('Connected')
  expect(markup).toContain('href="https://workspace.invalid/vault"')
  expect(markup).toContain('aria-label="Vault"')
  expect(markup).not.toMatch(/127\.0\.0\.1|token=|name="target"/u)
})

it('limits remote traffic to the tunnel and its matching WebSocket port', () => {
  const origin = 'http://127.0.0.1:1234'
  expect(cloudRequestAllowed(origin, origin + '/')).toBe(true)
  expect(cloudRequestAllowed(origin, 'ws://127.0.0.1:1234/api')).toBe(true)
  expect(cloudRequestAllowed(origin, 'http://127.0.0.1:1235/')).toBe(false)
  expect(cloudRequestAllowed(origin, 'https://example.invalid/')).toBe(false)
  expect(cloudRequestAllowed(origin, 'http://user@127.0.0.1:1234/')).toBe(false)
})

it('accepts only an exact authenticated Cloud Vault request link', () => {
  const origin = 'http://127.0.0.1:1234'
  const id = 'a'.repeat(32)
  expect(cloudVaultRequestId(origin, `${origin}/__yharness/vault-request/${id}`)).toBe(id)
  for (const suffix of [
    '?next=/vault', '#request',
    `/${id}`,
  ]) {
    expect(cloudVaultRequestId(origin, `${origin}/__yharness/vault-request/${id}${suffix}`)).toBeUndefined()
  }
  expect(cloudVaultRequestId(origin, `http://user@127.0.0.1:1234/__yharness/vault-request/${id}`)).toBeUndefined()
  expect(cloudVaultRequestId(origin, `${origin}/__yharness/vault-request/${id.toUpperCase()}`)).toBeUndefined()
  expect(cloudVaultRequestId(origin, `${origin}/__yharness/vault-request/${'b'.repeat(31)}`)).toBeUndefined()
  expect(cloudVaultRequestId(origin, `http://127.0.0.1:1235/__yharness/vault-request/${id}`)).toBeUndefined()
})

it('accepts only an exact authenticated website-login approval link', () => {
  const origin = 'http://127.0.0.1:1234'
  const id = 'a'.repeat(32)
  expect(cloudWebsiteLoginUseRequestId(origin, `${origin}/__yharness/vault-login-use/${id}`)).toBe(id)
  for (const suffix of [
    '?next=/vault', '#request', `/${id}`,
  ]) {
    expect(cloudWebsiteLoginUseRequestId(origin, `${origin}/__yharness/vault-login-use/${id}${suffix}`)).toBeUndefined()
  }
  expect(cloudWebsiteLoginUseRequestId(origin, `http://user@127.0.0.1:1234/__yharness/vault-login-use/${id}`)).toBeUndefined()
  expect(cloudWebsiteLoginUseRequestId(origin, `${origin}/__yharness/vault-login-use/${id.toUpperCase()}`)).toBeUndefined()
})

it('accepts only a Y Harness login cookie from a redirect to the clean workspace', () => {
  const origin = 'http://127.0.0.1:1234'
  const name = 'dsh-auth-' + 'a'.repeat(43)
  const value = 'v1.fixture.signed'
  const headers = { location: './', 'set-cookie': name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' }
  expect(cloudSignInCookie(origin, new Response(null, { status: 303, headers }))).toEqual({
    url: origin, name, value, path: '/', httpOnly: true, sameSite: 'strict',
  })
  expect(cloudSignInCookie(origin, new Response(null, { status: 401, headers }))).toBeUndefined()
  expect(cloudSignInCookie(origin, new Response(null, {
    status: 303, headers: { ...headers, location: 'https://example.invalid/' },
  }))).toBeUndefined()
})
