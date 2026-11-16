import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudVaultRequest, isVaultLoginUseRequestId, isVaultRequestId, readCloudVaultBots, vaultRequestAllowed, type VaultExec } from '../src/cloud-vault.ts'

const unit = 'fixture-worker.service'
const value = 'a synthetic value with spaces, quotes and \n a second line'
const signal = new AbortController().signal
const origin = 'http://127.0.0.1:28634'
const browserSession = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const children = new Set<ReturnType<typeof execFile>>()

function managedWorkspace(sharedScopes = false) {
  return {
    origin,
    async fetch(url: string, options: RequestInit) {
      if (url === `${origin}/api/bot-vault-access`) {
        expect(options.method).toBe('GET')
        expect(options.credentials).toBe('include')
        expect(options.redirect).toBe('error')
        expect(options.cache).toBe('no-store')
        return Response.json({ mode: 'managed' }, {
          headers: sharedScopes ? { 'X-YH-Vault-Grant-Scopes': '1' } : {},
        })
      }
      expect(url).toBe(`${origin}/api/bots/list`)
      const call = JSON.parse(String(options.body))
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: {
        bots: [{ id: 'bot-scout', state: 'active', name: 'Scout' }],
      } } })
    },
  }
}

function fixture(script: string): VaultExec {
  return (_file, _args, options, callback) => {
    const child = execFile(process.execPath, ['-e', script], options, callback)
    children.add(child)
    child.once('close', () => { children.delete(child) })
    return child
  }
}

afterEach(async () => {
  await Promise.all([...children].map(child => new Promise<void>((resolve) => {
    child.once('close', () => { resolve() })
    child.kill()
  })))
})

describe('Desktop Vault SSH transport', () => {
  it('loads managed shared-browser access as a credential-free owner projection', async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe(origin + '/api/bot-browser-access')
      expect(options.method).toBe('GET')
      expect(options.credentials).toBe('include')
      expect(options.redirect).toBe('error')
      expect(options.cache).toBe('no-store')
      return Response.json({ mode: 'managed', bots: [{
        id: 'bot-scout', name: 'Scout', sessionId: browserSession, enabled: true,
      }] })
    })
    const execute: VaultExec = () => { throw new Error('Shared-browser listing must not open SSH') }
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-browser-access' }, signal, execute, { origin, fetch }))
      .resolves.toEqual({ ok: true, browserAccess: { mode: 'managed', bots: [{ id: 'bot-scout', name: 'Scout', enabled: true }] } })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'confirms the original owner Session', nextSession: browserSession, succeed: true },
    { label: 'refuses confirmation after the owner Session changes', nextSession: 'bot-session-5f3ec8e4-4c34-4ec6-a38f-aad6d07cb337', succeed: false },
  ])('$label after a browser toggle', async ({ nextSession, succeed }) => {
    let enabled = false
    const fetch = vi.fn(async (url: string, _options: RequestInit) => {
      expect(url).toBe(origin + '/api/bot-browser-access')
      return Response.json({ mode: 'managed', bots: [{
        id: 'bot-scout', name: 'Scout', sessionId: enabled ? nextSession : browserSession, enabled,
      }] })
    })
    const request = { action: 'set-browser-access', bot: 'bot-scout', enabled: true } as const
    const execute = vi.fn(fixture(
      'let body = ""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => {'
      + 'const value = JSON.parse(body);'
      + 'if (value.action !== "set-browser-access" || value.bot !== "bot-scout" || value.session !== ' + JSON.stringify(browserSession) + ' || value.enabled !== true) process.exit(2);'
      + 'process.stdout.write("{\\"ok\\":true}");'
      + '});',
    ))
    const workspace = { origin, fetch: async (url: string, options: RequestInit) => {
      if (url.endsWith('/api/bot-browser-access') && fetch.mock.calls.length > 0) enabled = true
      const response = await fetch(url, options)
      return response
    } }
    await expect(cloudVaultRequest('fixture-vps', request, signal, execute, workspace)).resolves.toEqual(succeed
      ? { ok: true, browserAccess: { mode: 'managed', bots: [{ id: 'bot-scout', name: 'Scout', enabled: true }] } }
      : { ok: false, reason: 'unavailable' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects forged or stale shared-browser roster rows before SSH', async () => {
    const execute = vi.fn(fixture('process.stdout.write("{\\"ok\\":true}");'))
    const request = { action: 'set-browser-access', bot: 'bot-scout', enabled: true } as const
    const missing = { origin, fetch: async () => Response.json({ mode: 'managed', bots: [{
      id: 'bot-other', name: 'Other', sessionId: browserSession, enabled: false,
    }] }) }
    await expect(cloudVaultRequest('fixture-vps', request, signal, execute, missing)).resolves.toEqual({ ok: false, reason: 'unavailable' })
    const stale = { origin, fetch: async () => Response.json({ mode: 'managed', bots: [{
      id: 'bot-scout', name: 'Scout', sessionId: 'bot-session-stale', enabled: false,
    }] }) }
    await expect(cloudVaultRequest('fixture-vps', request, signal, execute, stale)).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns an unavailable browser projection when the Cloud worker is legacy or gated', async () => {
    const workspace = { origin, fetch: async () => Response.json({ mode: 'unavailable', bots: [] }) }
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-browser-access' }, signal,
      () => { throw new Error('Shared-browser listing must not open SSH') }, workspace))
      .resolves.toEqual({ ok: true, browserAccess: { mode: 'unavailable', bots: [] } })
  })

  it('does not acknowledge a failed or unverified shared-browser toggle', async () => {
    const request = { action: 'set-browser-access', bot: 'bot-scout', enabled: true } as const
    const workspace = { origin, fetch: async () => Response.json({ mode: 'managed', bots: [{
      id: 'bot-scout', name: 'Scout', sessionId: browserSession, enabled: false,
    }] }) }
    const failed = vi.fn(fixture('process.stdout.write("{\\"ok\\":false}");'))
    await expect(cloudVaultRequest('fixture-vps', request, signal, failed, workspace))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(failed).toHaveBeenCalledOnce()

    const stale = vi.fn(fixture('process.stdout.write("{\\"ok\\":true}");'))
    await expect(cloudVaultRequest('fixture-vps', request, signal, stale, workspace))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(stale).toHaveBeenCalledOnce()
  })

  it('accepts grant metadata only in the management window', async () => {
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    const add = { action: 'add-grant', ...grant }
    const id = 'a'.repeat(32)
    if (!isVaultRequestId(id)) throw new Error('Invalid fixture id')
    expect(vaultRequestAllowed(add, { kind: 'manage' })).toBe(true)
    expect(vaultRequestAllowed(add, { kind: 'request', id })).toBe(false)
    expect(vaultRequestAllowed({ ...add, bot: '../other' }, { kind: 'manage' })).toBe(false)
    expect(vaultRequestAllowed({ ...add, value }, { kind: 'manage' })).toBe(false)
    const valid = { access: { services: [unit], grants: [grant] } }
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-grants' }, signal,
      fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(valid))});`), managedWorkspace()))
      .resolves.toEqual({ ok: true, ...valid, bots: [{ id: 'bot-scout', name: 'Scout' }] })
    const invalid = { access: { services: [unit], grants: [{ ...grant, value }] } }
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-grants' }, signal,
      fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(invalid))});`), managedWorkspace()))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it.each([
    { body: { mode: 'external' }, status: 200, reason: 'external' },
    { body: { mode: 'disabled' }, status: 200, reason: 'disabled' },
    { body: { mode: 'managed' }, status: 404, reason: 'unavailable' },
    { body: { mode: 'managed', extra: value }, status: 200, reason: 'unavailable' },
    { body: { mode: 'x'.repeat(1024) }, status: 200, reason: 'unavailable' },
  ])('does not contact the VPS Vault when the policy cannot be managed ($reason, $status)', async ({ body, status, reason }) => {
    const execute = vi.fn(fixture('process.stdout.write(\'{"ok":true}\');'))
    const fetch = vi.fn(async () => Response.json(body, { status }))
    const workspace = { origin, fetch }
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    for (const request of [{ action: 'list-grants' }, { action: 'add-grant', ...grant }, { action: 'remove-grant', ...grant }]) {
      await expect(cloudVaultRequest('fixture-vps', request, signal, execute, workspace)).resolves.toEqual({ ok: false, reason })
    }
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(execute).not.toHaveBeenCalled()
  })

  it('checks the current policy for each change and accepts a grant only for a roster Bot', async () => {
    const workspace = managedWorkspace()
    let managed = true
    const fetch = vi.fn(async (url: string, options: RequestInit) => !managed && url.endsWith('/api/bot-vault-access')
      ? Response.json({ mode: 'external' })
      : workspace.fetch(url, options))
    const execute = vi.fn(fixture('process.stdout.write(\'{"ok":true}\');'))
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    await expect(cloudVaultRequest('fixture-vps', { action: 'add-grant', ...grant, bot: 'bot-other-vps' },
      signal, execute, { ...workspace, fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(execute).not.toHaveBeenCalled()
    await expect(cloudVaultRequest('fixture-vps', { action: 'add-grant', ...grant },
      signal, execute, { ...workspace, fetch })).resolves.toEqual({ ok: true })
    managed = false
    await expect(cloudVaultRequest('fixture-vps', { action: 'remove-grant', ...grant },
      signal, execute, { ...workspace, fetch })).resolves.toEqual({ ok: false, reason: 'external' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('loads explicit grant scopes from the current Cloud broker and keeps legacy listings readable', async () => {
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    const bots = [{ id: 'bot-scout', name: 'Scout' }]
    const fallback = { access: { services: [unit], grants: [grant] } }
    const scoped = { access: { services: [unit], grants: [{ ...grant, scope: 'shared' }] } }
    const execute = (current: boolean) => vi.fn(fixture(
      'let body = ""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => {'
      + 'const action = JSON.parse(body).action;'
      + `if (action === "list-scoped-grants" && ${current}) process.stdout.write(${JSON.stringify(JSON.stringify(scoped))});`
      + `else if (action === "list-grants") process.stdout.write(${JSON.stringify(JSON.stringify(fallback))});`
      + 'else process.exit(1); });',
    ))
    const current = execute(true)
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-grants' }, signal, current, managedWorkspace(true)))
      .resolves.toEqual({ ok: true, access: { ...scoped.access, sharedScopes: true }, bots })
    expect(current).toHaveBeenCalledOnce()
    const legacy = execute(false)
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-grants' }, signal, legacy, managedWorkspace(true)))
      .resolves.toEqual({ ok: true, ...fallback, bots })
    expect(legacy).toHaveBeenCalledTimes(2)
  })

  it('allows an exact scoped grant change only in Mac Vault management with current Cloud support', async () => {
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    const update = { action: 'set-grant-scope', ...grant, scope: 'owner' }
    const add = { action: 'add-grant', ...grant, scope: 'shared' }
    const id = 'a'.repeat(32)
    if (!isVaultRequestId(id)) throw new Error('Invalid fixture id')
    expect(vaultRequestAllowed(update, { kind: 'manage' })).toBe(true)
    expect(vaultRequestAllowed(update, { kind: 'request', id })).toBe(false)
    expect(vaultRequestAllowed({ ...update, scope: 'everyone' }, { kind: 'manage' })).toBe(false)
    expect(vaultRequestAllowed({ ...add, scope: 'owner' }, { kind: 'manage' })).toBe(false)
    expect(vaultRequestAllowed({ action: 'remove-grant', ...grant, scope: 'shared' }, { kind: 'manage' })).toBe(false)
    const execute = vi.fn(fixture(
      'let body = ""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => {'
      + `const actions = ${JSON.stringify([update, add])};`
      + 'const parsed = JSON.parse(body), { isDeepStrictEqual } = require("node:util");'
      + 'if (!actions.some(action => isDeepStrictEqual(action, parsed))) process.exit(1);'
      + 'process.stdout.write(JSON.stringify({ ok: true })); });',
    ))
    await expect(cloudVaultRequest('fixture-vps', update, signal, execute, managedWorkspace()))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(cloudVaultRequest('fixture-vps', { ...update, bot: 'bot-other' }, signal, execute, managedWorkspace(true)))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(execute).not.toHaveBeenCalled()
    for (const request of [update, add]) {
      await expect(cloudVaultRequest('fixture-vps', request, signal, execute, managedWorkspace(true))).resolves.toEqual({ ok: true })
    }
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not start a grant operation if the Cloud connection closes during the policy check', async () => {
    const controller = new AbortController()
    const execute = vi.fn(fixture('process.stdout.write(\'{"ok":true}\');'))
    const grant = { bot: 'bot-scout', unit, name: 'FIXTURE_KEY' }
    await expect(cloudVaultRequest('fixture-vps', { action: 'remove-grant', ...grant }, controller.signal, execute, {
      origin,
      async fetch() {
        controller.abort()
        return Response.json({ mode: 'managed' })
      },
    })).resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('loads only the named Bot choices from the connected owner workspace', async () => {
    const fetcher = async (url: string, init: RequestInit) => {
      expect(url).toBe(`${origin}/api/bots/list`)
      expect(init.credentials).toBe('include')
      expect(init.redirect).toBe('error')
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ type: 'client-request', method: 'bots/list', payload: { args: { request: { includeHidden: true } } } })
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { bots: [
        { id: 'bot-scout', state: 'active', name: 'Scout', fixtureOtherField: value },
        { id: 'bot-preparing', state: 'provisioning', name: 'Preparing' },
      ] } } })
    }
    await expect(readCloudVaultBots(origin, fetcher, signal)).resolves.toEqual([{ id: 'bot-scout', name: 'Scout' }])
    await expect(readCloudVaultBots('https://example.com', fetcher, signal)).resolves.toBeUndefined()
  })

  it('binds an assigned website login to one Bot in the connected roster', async () => {
    const workspace = managedWorkspace()
    const login = {
      action: 'add-login', origin: 'https://example.com', label: 'Scout account',
      username: 'fixture-user', password: 'fixture-password',
    }
    const execute = vi.fn(fixture(
      'let text=""; process.stdin.on("data", chunk => text+=chunk); process.stdin.on("end", () => {'
      + 'if(JSON.parse(text).bot!=="bot-scout") process.exit(2); process.stdout.write(\'{"ok":true}\')})',
    ))
    await expect(cloudVaultRequest('fixture-vps', { ...login, bot: 'bot-other' }, signal, execute, workspace))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    expect(execute).not.toHaveBeenCalled()
    await expect(cloudVaultRequest('fixture-vps', { ...login, bot: 'bot-scout' }, signal, execute, workspace))
      .resolves.toEqual({ ok: true })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('returns only scoped website metadata and named Bot choices', async () => {
    const scoped = { id: 'b'.repeat(32), bot: 'bot-scout', origin: 'https://example.com', label: 'Scout' }
    const workspace = managedWorkspace()
    const action = { action: 'list-bot-logins' }
    const output = { botLogins: [scoped] }
    await expect(cloudVaultRequest('fixture-vps', action, signal,
      fixture('process.stdout.write(' + JSON.stringify(JSON.stringify(output)) + ')'), workspace))
      .resolves.toEqual({ ok: true, ...output, bots: [{ id: 'bot-scout', name: 'Scout' }] })
    const hasPassword = { botLogins: [{ ...scoped, password: value }] }
    await expect(cloudVaultRequest('fixture-vps', action, signal,
      fixture('process.stdout.write(' + JSON.stringify(JSON.stringify(hasPassword)) + ')'), workspace))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('inspects a request and returns only its validated metadata', async () => {
    const id = 'a'.repeat(32)
    const execute: VaultExec = (_file, _args, options, callback) => fixture(`
      let body = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { body += chunk });
      process.stdin.on('end', () => {
        const request = JSON.parse(body);
        if (request.action !== 'inspect-request' || request.id !== ${JSON.stringify(id)}) process.exit(2);
        process.stdout.write(JSON.stringify({ request: {
          id: ${JSON.stringify(id)}, unit: ${JSON.stringify(unit)}, name: 'FIXTURE_KEY', state: 'pending'
        } }));
      });
    `)(_file, _args, options, callback)
    await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-request', id }, signal, execute))
      .resolves.toEqual({ request: { id, unit, name: 'FIXTURE_KEY', state: 'pending' } })
  })

  it('inspects a website login request without returning credential values', async () => {
    const id = 'f'.repeat(32)
    const loginId = 'e'.repeat(32)
    const generation = '1'.repeat(64)
    const execute: VaultExec = (_file, _args, options, callback) => fixture(`
      let body = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { body += chunk });
      process.stdin.on('end', () => {
        const request = JSON.parse(body);
        if (request.action !== 'inspect-login-use' || request.id !== ${JSON.stringify(id)}) process.exit(2);
        process.stdout.write(JSON.stringify({ request: {
          id: ${JSON.stringify(id)}, origin: 'https://example.com',
          destination: 'https://example.com/sign-in',
          logins: [{ id: ${JSON.stringify(loginId)}, label: 'Example', generation: ${JSON.stringify(generation)} }]
        } }));
      });
    `)(_file, _args, options, callback)
    await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-login-use', id }, signal, execute))
      .resolves.toEqual({ request: {
        id, origin: 'https://example.com', destination: 'https://example.com/sign-in',
        logins: [{ id: loginId, label: 'Example', generation }],
      } })
  })

  it.each(['submitted', 'needs-owner', 'unavailable'] as const)('returns website login approval state %s', async (state) => {
    const id = 'f'.repeat(32)
    const loginId = 'e'.repeat(32)
    const generation = '1'.repeat(64)
    await expect(cloudVaultRequest('fixture-vps', { action: 'approve-login-use', id, loginId, generation }, signal,
      fixture(`process.stdout.write(JSON.stringify({ state: ${JSON.stringify(state)} }));`)))
      .resolves.toEqual({ state })
  })

  it('validates secure entry for the reviewed URL and returns a separate saving result', async () => {
    const id = 'f'.repeat(32)
    const origin = 'https://example.com'
    const request = {
      action: 'enter-login-use', id, origin, destination: origin + '/login',
      username: 'fixture-user', password: 'fixture-password', saveLabel: ' Work ',
    }
    const execute: VaultExec = (file, args, options, callback) => {
      expect(file).toBe('/usr/bin/ssh')
      expect(args).not.toContain(request.password)
      return fixture(`
        let body = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { body += chunk; });
        process.stdin.on('end', () => {
          if (body !== ${JSON.stringify(JSON.stringify({ ...request, saveLabel: 'Work' }))}) process.exit(2);
          process.stdout.write(JSON.stringify({ state: 'submitted', saved: false }));
        });
      `)(file, args, options, callback)
    }
    await expect(cloudVaultRequest('fixture-vps', request, signal, execute)).resolves.toEqual({ state: 'submitted', saved: false })
    await expect(cloudVaultRequest('fixture-vps', { ...request, destination: 'https://other.example/login' }, signal, execute))
      .resolves.toEqual({ ok: false, reason: 'invalid' })
    await expect(cloudVaultRequest('fixture-vps', request, signal,
      fixture('process.stdout.write(JSON.stringify({ state: "submitted", password: "fixture-password" }));')))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('sends an exact website login decline and returns the fixed unavailable state', async () => {
    const id = 'f'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'decline-login-use', id }, signal,
      fixture('process.stdout.write(JSON.stringify({ state: "unavailable" }));')))
      .resolves.toEqual({ state: 'unavailable' })
  })

  it('rejects website login replies with a non-canonical destination, duplicate choices, or credential fields', async () => {
    const id = 'f'.repeat(32)
    const loginId = 'e'.repeat(32)
    const generation = '1'.repeat(64)
    const malformed = [
      { request: { id, origin: 'https://example.com', destination: 'https://example.com/sign-in?next=1', logins: [] } },
      { request: { id, origin: 'https://example.com', destination: 'https://example.com/sign-in', logins: [{ id: loginId, label: 'Example', generation }, { id: loginId, label: 'Again', generation }] } },
      { request: { id, origin: 'https://example.com', destination: 'https://example.com/sign-in', logins: [{ id: loginId, label: 'Example', generation, password: 'secret' }] } },
    ]
    for (const reply of malformed) {
      await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-login-use', id }, signal,
        fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(reply))});`))).resolves.toEqual({ ok: false, reason: 'unavailable' })
    }
  })

  it('accepts a save acknowledgment', async () => {
    const id = 'b'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'save-request', id, value }, signal,
      fixture('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ ok: true })));')))
      .resolves.toEqual({ ok: true })
  })

  it.each(['saved', 'cancelled'] as const)('returns the broker’s %s result after dismissal', async (state) => {
    const id = 'b'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'dismiss-request', id }, signal,
      fixture(`process.stdout.write(${JSON.stringify(JSON.stringify({ state }))});`))).resolves.toEqual({ state })
  })

  it('binds the Vault form to its exact request and keeps management operations separate', () => {
    const id = 'c'.repeat(32)
    if (!isVaultRequestId(id)) throw new Error('Fixture id is invalid.')
    expect(vaultRequestAllowed({ action: 'save-request', id, value }, id)).toBe(true)
    expect(vaultRequestAllowed({ action: 'save-request', id: 'd'.repeat(32), value }, id)).toBe(false)
    expect(vaultRequestAllowed({ action: 'add', unit, name: 'FIXTURE_KEY', value }, id)).toBe(false)
    expect(vaultRequestAllowed({ action: 'inspect-request', id }, undefined)).toBe(false)
    expect(vaultRequestAllowed({ action: 'list' }, undefined)).toBe(true)
    expect(vaultRequestAllowed({ action: 'replace-login', id, label: 'Site', username: 'fixture', password: 'dummy' }, undefined)).toBe(true)
    expect(vaultRequestAllowed({ action: 'remove-login', id }, undefined)).toBe(true)
    expect(vaultRequestAllowed({ action: 'remove-login', id }, id)).toBe(false)
  })

  it('binds website login approval to its exact native request mode', () => {
    const id = 'f'.repeat(32)
    const loginId = 'e'.repeat(32)
    const generation = '1'.repeat(64)
    const otherId = 'd'.repeat(32)
    if (!isVaultLoginUseRequestId(id) || !isVaultLoginUseRequestId(otherId)) throw new Error('Fixture id is invalid.')
    expect(vaultRequestAllowed({ action: 'approve-login-use', id, loginId, generation }, { kind: 'login-use', id })).toBe(true)
    expect(vaultRequestAllowed({ action: 'inspect-login-use', id }, { kind: 'login-use', id })).toBe(true)
    expect(vaultRequestAllowed({ action: 'inspect-login-use', id, form: 'entry' }, { kind: 'login-use', id })).toBe(true)
    expect(vaultRequestAllowed({ action: 'approve-login-use', id, loginId, generation }, { kind: 'login-use', id: otherId })).toBe(false)
    expect(vaultRequestAllowed({ action: 'approve-login-use', id, loginId, generation }, { kind: 'manage' })).toBe(false)
    expect(vaultRequestAllowed({ action: 'decline-login-use', id }, { kind: 'login-use', id })).toBe(true)
    expect(vaultRequestAllowed({ action: 'approve-login-use', id, loginId: 'A'.repeat(32), generation }, { kind: 'login-use', id })).toBe(false)
    const entry = { action: 'enter-login-use', id, origin: 'https://example.com', destination: 'https://example.com/login',
      username: 'fixture', password: 'dummy' }
    expect(vaultRequestAllowed(entry, { kind: 'login-use', id })).toBe(true)
    expect(vaultRequestAllowed(entry, { kind: 'login-use', id: otherId })).toBe(false)
    expect(vaultRequestAllowed(entry, { kind: 'manage' })).toBe(false)
  })

  it('sends secret bytes on stdin to the fixed command and returns an acknowledgment', async () => {
    const execute: VaultExec = (file, args, options, callback) => {
      expect(file).toBe('/usr/bin/ssh')
      expect(args.slice(-3)).toEqual(['--', 'fixture-vps', '/usr/local/sbin/yharness-vault desktop-client'])
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args).toContain('ClearAllForwardings=yes')
      expect(args).toContain('ForwardAgent=no')
      expect(JSON.stringify(args)).not.toContain('synthetic value')
      expect(Object.keys(options.env ?? {}).every(name => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))).toBe(true)
      return fixture(`
        let body = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { body += chunk });
        process.stdin.on('end', () => {
          const request = JSON.parse(body);
          if (request.action !== 'add' || request.unit !== ${JSON.stringify(unit)}
              || request.name !== 'FIXTURE_KEY' || request.value !== ${JSON.stringify(value)}) process.exit(2);
          process.stdout.write(JSON.stringify({ ok: true }));
        });
      `)(file, args, options, callback)
    }
    await expect(cloudVaultRequest('fixture-vps', { action: 'add', unit, name: 'FIXTURE_KEY', value }, signal, execute))
      .resolves.toEqual({ ok: true })
  })

  it('lists only validated service names and secret names', async () => {
    const response = JSON.stringify({ services: [{ unit, names: ['FIXTURE_KEY'] }] })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, signal,
      fixture(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(response)}));`)))
      .resolves.toEqual({ ok: true, services: [{ unit, names: ['FIXTURE_KEY'] }] })
  })

  it('normalizes website login origins and returns only login metadata', async () => {
    const id = 'e'.repeat(32)
    const requests: unknown[] = []
    const execute: VaultExec = (_file, _args, options, callback) => fixture(`
      let body = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { body += chunk });
      process.stdin.on('end', () => {
        const request = JSON.parse(body);
        if (request.action === 'add-login') {
          if (request.origin !== 'https://xn--bcher-kva.example:8443'
              || request.label !== 'My site' || request.username !== 'alice@example.com'
              || request.password !== 'fixture password') process.exit(2);
          process.stdout.write(JSON.stringify({ ok: true }));
          return;
        }
        if (request.action === 'list-logins') {
          process.stdout.write(JSON.stringify({ logins: [{
            id: ${JSON.stringify(id)}, origin: 'https://xn--bcher-kva.example:8443', label: 'My site'
          }] }));
          return;
        }
        process.exit(3);
      });
    `)(_file, _args, options, (error, stdout) => {
      if (error === null) requests.push(JSON.parse(stdout))
      callback(error, stdout)
    })
    await expect(cloudVaultRequest('fixture-vps', {
      action: 'add-login', origin: 'https://Bücher.Example:8443/', label: '  My site  ',
      username: 'alice@example.com', password: 'fixture password',
    }, signal, execute)).resolves.toEqual({ ok: true })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-logins' }, signal, execute))
      .resolves.toEqual({ ok: true, logins: [{ id, origin: 'https://xn--bcher-kva.example:8443', label: 'My site' }] })
    expect(requests).toEqual([{ ok: true }, { logins: [{ id, origin: 'https://xn--bcher-kva.example:8443', label: 'My site' }] }])
  })

  it('keeps website login ids and origins out of malformed or secret replies', async () => {
    const mustNotOpen: VaultExec = () => { throw new Error('SSH was started') }
    for (const request of [
      { action: 'add-login', origin: 'http://example.com', label: 'Site', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://127.0.0.1', label: 'Site', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://example', label: 'Site', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://example.123', label: 'Site', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://example.com/path', label: 'Site', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://example.com', label: ' ', username: 'alice', password: 'secret' },
      { action: 'add-login', origin: 'https://example.com', label: 'Site', username: 'a\u0000lice', password: 'secret' },
      { action: 'add-login', origin: 'https://example.com', label: 'Site', username: 'alice', password: 'secret\u0085' },
      { action: 'add-login', origin: 'https://example.com', label: 'Site', username: 'alice', password: 'secret\u2028' },
      { action: 'replace-login', id: 'A'.repeat(32), label: 'Site', username: 'alice', password: 'secret' },
      { action: 'remove-login', id: 'a'.repeat(31) },
      { action: 'list-logins', value },
    ]) {
      await expect(cloudVaultRequest('fixture-vps', request, signal, mustNotOpen))
        .resolves.toEqual({ ok: false, reason: 'invalid' })
    }
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-logins' }, signal,
      fixture('process.stdout.write(JSON.stringify({ logins: [{ id: \'A\'.repeat(32), origin: \'https://example.com\', label: \'Site\' }] }));')))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list-logins' }, signal,
      fixture('process.stdout.write(JSON.stringify({ logins: [{ id: \'a\'.repeat(32), origin: \'https://example.com/\', label: \'Site\' }] }));')))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('keeps remote output and errors out of the renderer', async () => {
    const result = { ok: false, reason: 'unavailable' }
    for (const script of [
      `process.stdout.write(JSON.stringify({ services: [], unexpected: ${JSON.stringify(value)} }));`,
      `process.stderr.write(${JSON.stringify(value)}); process.exitCode = 2;`,
      'process.stdout.write("x".repeat(300000));',
    ]) {
      await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, signal, fixture(script))).resolves.toEqual(result)
    }
  })

  it('rejects malformed requests before opening SSH', async () => {
    const mustNotOpen: VaultExec = () => { throw new Error('SSH was started') }
    for (const request of [
      { action: 'revoke', unit: '../../worker.service', name: 'FIXTURE_KEY' },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: 'x'.repeat(8193) },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: '\0' },
      { action: 'add', unit, name: 'FIXTURE_KEY', value: '\uD800' },
      { action: 'list', value },
      { action: 'get', unit, name: 'FIXTURE_KEY' },
      { action: 'inspect-request', id: 'A'.repeat(32) },
      { action: 'inspect-request', id: 'a'.repeat(31) },
      { action: 'save-request', id: 'a'.repeat(32), value: '' },
      { action: 'dismiss-request', id: 'a'.repeat(32), value },
    ]) {
      await expect(cloudVaultRequest('fixture-vps', request, signal, mustNotOpen)).resolves.toEqual({ ok: false, reason: 'invalid' })
    }
    await expect(cloudVaultRequest('-oUntrusted', { action: 'list' }, signal, mustNotOpen)).resolves.toEqual({ ok: false, reason: 'invalid' })
    await expect(cloudVaultRequest('fixture-vps', { action: 'list' }, AbortSignal.abort(), mustNotOpen))
      .resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('rejects an inspection reply for a different request', async () => {
    const id = 'a'.repeat(32)
    await expect(cloudVaultRequest('fixture-vps', { action: 'inspect-request', id }, signal,
      fixture(`process.stdout.write(JSON.stringify({ request: {
        id: ${JSON.stringify('b'.repeat(32))}, unit: ${JSON.stringify(unit)}, name: 'FIXTURE_KEY', state: 'pending'
      } }));`))).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
