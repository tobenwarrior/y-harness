import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en } from '../src/locale.ts'

function page(mode: { readonly kind: 'request'; readonly id: string } | { readonly kind: 'login-use'; readonly id: string } | { readonly kind: 'manage' }, request: (value: unknown) => Promise<unknown>) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/cloud-vault.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only', url: 'dsh-app://shell/cloud-vault.html',
  })
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')) }
  const close = vi.fn(async () => {})
  Object.defineProperty(dom.window, 'yhCloudVault', {
    value: { messages: async () => en, mode: async () => mode, request, close },
  })
  onTestFinished(() => { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close() })
  const element = (id: string): HTMLElement => {
    const value = dom.window.document.getElementById(id)
    if (value === null) throw new Error(`Missing Vault element: ${id}`)
    return value
  }
  const run = (): void => {
    runInContext(readFileSync(new URL('../renderer/cloud-vault.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  }
  return { dom, close, element, run }
}

it('grants and withdraws one named Bot’s request access', async () => {
  const unit = 'fixture-worker.service'
  const grant = { bot: 'bot-scout', unit, name: 'SCOUT_API_KEY' }
  let permitted = false
  const request = vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value) {
      switch (value.action) {
        case 'list': return { ok: true, services: [{ unit, names: [] }] }
        case 'list-logins': return { ok: true, logins: [] }
        case 'list-grants': return { ok: true, access: { services: [unit], grants: permitted ? [grant] : [] }, bots: [
          { id: 'bot-scout', name: 'Scout' }, { id: 'bot-orbit', name: 'Orbit' },
        ] }
        case 'add-grant': permitted = true; return { ok: true }
        case 'remove-grant': permitted = false; return { ok: true }
      }
    }
    return { ok: false }
  })
  const p = page({ kind: 'manage' }, request)
  p.run()
  await expect.poll(() => p.element('management').hidden).toBe(false)
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('bot-access-tab').click()
  const add = p.element('add-grant') as HTMLButtonElement
  await expect.poll(() => add.disabled).toBe(false)
  add.click()
  const bot = p.element('grant-bot') as HTMLSelectElement
  bot.value = grant.bot
  expect(bot.selectedOptions[0]?.textContent).toBe('Scout')
  const service = p.element('grant-service') as HTMLSelectElement
  const name = p.element('grant-name') as HTMLInputElement
  service.value = unit
  name.value = grant.name
  p.element('grant-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => p.element('grants').textContent).toContain('Scout')
  expect(request).toHaveBeenCalledWith({ action: 'add-grant', ...grant })
  const remove = p.element('grants').querySelector('button')
  remove?.click()
  expect((p.element('confirmation') as HTMLDialogElement).open).toBe(true)
  p.element('confirm-revoke').click()
  await expect.poll(() => p.element('grants').children.length).toBe(0)
  expect(request).toHaveBeenCalledWith({ action: 'remove-grant', ...grant })
})

it('lets the owner create a shared per-key grant only when the capability is advertised', async () => {
  const unit = 'fixture-worker.service'
  const grant = { bot: 'bot-scout', unit, name: 'SCOUT_API_KEY' }
  let grants: Array<typeof grant & { scope?: 'shared' }> = []
  const request = vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value) {
      switch (value.action) {
        case 'list': return { ok: true, services: [{ unit, names: [] }] }
        case 'list-logins': return { ok: true, logins: [] }
        case 'list-grants': return { ok: true, access: { services: [unit], grants, sharedScopes: true }, bots: [
          { id: 'bot-scout', name: 'Scout' },
        ] }
        case 'add-grant':
          grants = [{ ...grant, ...('scope' in value && value.scope === 'shared' ? { scope: 'shared' as const } : {}) }]
          return { ok: true }
      }
    }
    return { ok: false }
  })
  const p = page({ kind: 'manage' }, request)
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('bot-access-tab').click()
  await expect.poll(() => (p.element('add-grant') as HTMLButtonElement).disabled).toBe(false)
  p.element('add-grant').click()
  const scopeField = p.dom.window.document.getElementById('grant-scope-field')
  expect(scopeField).not.toBeNull()
  expect((p.element('grant-scope') as HTMLSelectElement).value).toBe('owner')
  ;(p.element('grant-bot') as HTMLSelectElement).value = grant.bot
  ;(p.element('grant-service') as HTMLSelectElement).value = unit
  ;(p.element('grant-name') as HTMLInputElement).value = grant.name
  ;(p.element('grant-scope') as HTMLSelectElement).value = 'shared'
  p.element('grant-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => p.element('grants').textContent).toContain('Scout')
  expect(request).toHaveBeenCalledWith({ action: 'add-grant', ...grant, scope: 'shared' })

  await expect.poll(() => (p.element('add-grant') as HTMLButtonElement).disabled).toBe(false)
  p.element('add-grant').click()
  expect((p.element('grant-scope') as HTMLSelectElement).value).toBe('owner')
  ;(p.element('grant-name') as HTMLInputElement).value = grant.name
  const requestCount = request.mock.calls.length
  p.element('grant-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  expect(request).toHaveBeenCalledTimes(requestCount)
  expect(p.element('grant-notice').textContent).toContain('This key already has a grant')
})

it('changes an existing supported grant back to owner-only with its exact identity', async () => {
  const unit = 'fixture-worker.service'
  const grant = { bot: 'bot-scout', unit, name: 'SCOUT_API_KEY', scope: 'shared' as const }
  const request = vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value) {
      switch (value.action) {
        case 'list': return { ok: true, services: [{ unit, names: [] }] }
        case 'list-logins': return { ok: true, logins: [] }
        case 'list-grants': return { ok: true, access: { services: [unit], grants: [grant], sharedScopes: true }, bots: [
          { id: 'bot-scout', name: 'Scout' },
        ] }
        case 'set-grant-scope': return { ok: true }
      }
    }
    return { ok: false }
  })
  const p = page({ kind: 'manage' }, request)
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('bot-access-tab').click()
  await expect.poll(() => p.element('grants').textContent).toContain('Scout')
  const scope = p.element('grants').querySelector('select.grant-scope') as HTMLSelectElement
  expect(scope.value).toBe('shared')
  scope.value = 'owner'
  scope.dispatchEvent(new p.dom.window.Event('change', { bubbles: true }))
  await expect.poll(() => request.mock.calls.some(([value]) => value && typeof value === 'object'
    && 'action' in value && value.action === 'set-grant-scope')).toBe(true)
  expect(request).toHaveBeenCalledWith({ action: 'set-grant-scope', bot: grant.bot, unit, name: grant.name, scope: 'owner' })
})

it('keeps scope controls hidden for legacy Cloud grant responses', async () => {
  const unit = 'fixture-worker.service'
  const grant = { bot: 'bot-scout', unit, name: 'SCOUT_API_KEY' }
  const request = vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value) {
      switch (value.action) {
        case 'list': return { ok: true, services: [{ unit, names: [] }] }
        case 'list-logins': return { ok: true, logins: [] }
        case 'list-grants': return { ok: true, access: { services: [unit], grants: [grant] }, bots: [
          { id: 'bot-scout', name: 'Scout' },
        ] }
      }
    }
    return { ok: false }
  })
  const p = page({ kind: 'manage' }, request)
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('bot-access-tab').click()
  await expect.poll(() => p.element('grants').textContent).toContain('Scout')
  const scopeField = p.dom.window.document.getElementById('grant-scope-field')
  expect(scopeField).not.toBeNull()
  expect(scopeField?.hidden).toBe(true)
  expect(p.element('grants').querySelector('select.grant-scope')).toBeNull()
})

it('clears a previously loaded grant when Cloud policy takes over during removal', async () => {
  const unit = 'fixture-worker.service'
  const grant = { bot: 'bot-scout', unit, name: 'SCOUT_API_KEY' }
  const request = vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value) {
      switch (value.action) {
        case 'list': return { ok: true, services: [{ unit, names: [] }] }
        case 'list-logins': return { ok: true, logins: [] }
        case 'list-grants': return { ok: true, access: { services: [unit], grants: [grant] },
          bots: [{ id: 'bot-scout', name: 'Scout' }] }
        case 'remove-grant': return { ok: false, reason: 'external' }
      }
    }
    return { ok: false }
  })
  const p = page({ kind: 'manage' }, request)
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('bot-access-tab').click()
  await expect.poll(() => p.element('grants').textContent).toContain('Scout')
  p.element('grants').querySelector('button')?.click()
  p.element('confirm-revoke').click()
  await expect.poll(() => p.element('grants').children.length).toBe(0)
  expect(p.element('add-grant').hidden).toBe(true)
  expect(p.element('grant-notice').textContent).toBe('Bot access is managed outside this Vault by your Cloud configuration.')
})

it('renders request mode without generic Vault controls and saves only after a trusted acknowledgment', async () => {
  const id = 'a'.repeat(32)
  const requests: unknown[] = []
  const request = vi.fn(async (value: unknown) => {
    requests.push(value)
    if (requests.length === 1) return { request: { id, unit: 'fixture-worker.service', name: 'FIXTURE_KEY', state: 'pending' } }
    return { ok: true }
  })
  const p = page({ kind: 'request', id }, request)
  p.run()
  await expect.poll(() => p.element('request').hidden).toBe(false)
  expect(p.element('services').hidden).toBe(true)
  expect(p.element('request-unit').textContent).toBe('fixture-worker.service')
  expect(p.element('request-name').textContent).toBe('FIXTURE_KEY')
  const value = p.element('request-value') as HTMLInputElement
  value.value = 'fixture secret'
  p.element('request-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => p.element('request-outcome').textContent).toBe(en.cloudVaultRequestSaved)
  expect(requests).toEqual([
    { action: 'inspect-request', id },
    { action: 'save-request', id, value: 'fixture secret' },
  ])
  expect((p.element('request-value') as HTMLInputElement).value).toBe('')
  expect((p.element('request-save') as HTMLButtonElement).disabled).toBe(true)
})

it('lets the owner choose a saved login and falls back to the legacy inspection', async () => {
  const id = 'f'.repeat(32)
  const loginId = 'e'.repeat(32)
  const generation = '1'.repeat(64)
  const requests: unknown[] = []
  const request = vi.fn(async (value: unknown) => {
    requests.push(value)
    if (value && typeof value === 'object' && 'action' in value && value.action === 'inspect-login-use') {
      if ('form' in value) return { ok: false, reason: 'unavailable' }
      return { request: {
        id, origin: 'https://example.com', destination: 'https://example.com/sign-in',
        logins: [{ id: loginId, label: 'Example', generation }],
      } }
    }
    return { state: 'submitted' }
  })
  const p = page({ kind: 'login-use', id }, request)
  p.run()
  await expect.poll(() => (p.element('login-choice') as HTMLSelectElement).options.length).toBe(1)
  expect(p.element('request').hidden).toBe(true)
  expect(p.element('management').hidden).toBe(true)
  expect(p.element('login-use-origin').textContent).toBe('https://example.com')
  expect(p.element('login-use-destination').textContent).toBe('https://example.com/sign-in')
  expect((p.element('login-choice') as HTMLSelectElement).options[0]?.textContent).toBe('Example')
  expect(p.element('login-use-entry').hidden).toBe(true)
  p.element('login-use-approve').click()
  expect((p.element('login-use-approve') as HTMLButtonElement).disabled).toBe(true)
  await expect.poll(() => p.element('login-use-outcome').textContent).toBe(en.cloudVaultLoginUseSubmitted)
  expect(requests).toEqual([
    { action: 'inspect-login-use', id, form: 'entry' },
    { action: 'inspect-login-use', id },
    { action: 'approve-login-use', id, loginId, generation },
  ])
})

it.each([false, true])('enters a login for the reviewed website with saving set to %s', async (save) => {
  const id = 'a'.repeat(32)
  const origin = 'https://example.com'
  const destination = origin + '/sign-in'
  const request = vi.fn<(value: unknown) => Promise<unknown>>()
    .mockResolvedValueOnce({ request: { id, origin, destination, logins: [], acceptsCredentials: true } })
    .mockResolvedValue({ state: 'submitted', ...(save ? { saved: true } : {}) })
  const p = page({ kind: 'login-use', id }, request)
  p.run()
  await expect.poll(() => p.element('login-use-entry').hidden).toBe(false)
  expect(p.element('login-use-empty').hidden).toBe(true)
  expect(p.element('login-use-saved').hidden).toBe(true)
  const username = p.element('login-use-username') as HTMLInputElement
  const password = p.element('login-use-password') as HTMLInputElement
  const remember = p.element('login-use-save') as HTMLInputElement
  expect(p.dom.window.document.activeElement).toBe(username)
  expect(password.type).toBe('password')
  expect(remember.checked).toBe(false)
  username.value = 'fixture-user'
  password.value = 'fixture-password'
  if (save) {
    remember.click()
    const label = p.element('login-use-save-label') as HTMLInputElement
    label.value = 'Work'
  }
  p.element('login-use-entry').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => request.mock.calls.length).toBe(2)
  expect(request).toHaveBeenLastCalledWith({
    action: 'enter-login-use', id, origin, destination, username: 'fixture-user', password: 'fixture-password',
    ...(save ? { saveLabel: 'Work' } : {}),
  })
  expect(password.value).toBe('')
  await expect.poll(() => p.element('login-use-outcome').textContent)
    .toBe(save ? en.cloudVaultLoginUseSubmittedSaved : en.cloudVaultLoginUseSubmitted)
})

it('clears entered credentials when the owner returns to a saved login', async () => {
  const id = 'a'.repeat(32)
  const origin = 'https://example.com'
  const request = vi.fn(async () => ({ request: {
    id, origin, destination: origin + '/sign-in', acceptsCredentials: true,
    logins: [{ id: 'f'.repeat(32), label: 'Work', generation: '1'.repeat(64) }],
  } }))
  const p = page({ kind: 'login-use', id }, request)
  p.run()
  await expect.poll(() => p.element('login-use-saved').hidden).toBe(false)
  expect(p.element('login-use-entry').hidden).toBe(true)
  p.element('login-use-toggle').click()
  expect(p.element('login-use-entry').hidden).toBe(false)
  const password = p.element('login-use-password') as HTMLInputElement
  password.value = 'fixture-password'
  p.element('login-use-toggle').click()
  expect(p.element('login-use-entry').hidden).toBe(true)
  expect(password.value).toBe('')
  expect(request).toHaveBeenCalledOnce()
})

it('keeps website login approval disabled when inspection returns no saved logins', async () => {
  const id = 'a'.repeat(32)
  const p = page({ kind: 'login-use', id }, vi.fn(async () => ({ request: {
    id, origin: 'https://example.com', destination: 'https://example.com/sign-in', logins: [],
  } })))
  p.run()
  await expect.poll(() => p.element('login-use-empty').hidden).toBe(false)
  expect((p.element('login-use-approve') as HTMLButtonElement).disabled).toBe(true)
  expect((p.element('login-use-decline') as HTMLButtonElement).disabled).toBe(false)
})

it('lets Escape close request mode without dismissing a still-pending request', async () => {
  const id = 'b'.repeat(32)
  const request = vi.fn(async () => ({ request: { id, unit: 'fixture-worker.service', name: 'FIXTURE_KEY', state: 'pending' } }))
  const p = page({ kind: 'request', id }, request)
  p.run()
  await expect.poll(() => p.element('request-value').hidden).toBe(false)
  const event = new p.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  p.dom.window.document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(p.close).toHaveBeenCalledOnce()
  expect(request).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'dismiss-request' }))
})

it.each([
  ['cancelled', 'cloudVaultRequestCancelled'],
  ['saved', 'cloudVaultRequestSaved'],
] as const)('shows the %s outcome reported by the broker after dismissal', async (state, copy) => {
  const id = 'e'.repeat(32)
  const request = vi.fn(async (value: unknown) => value && typeof value === 'object' && 'action' in value
    && value.action === 'inspect-request'
    ? { request: { id, unit: 'fixture-worker.service', name: 'FIXTURE_KEY', state: 'pending' } }
    : { state })
  const p = page({ kind: 'request', id }, request)
  p.run()
  await expect.poll(() => p.element('request-editor').hidden).toBe(false)
  p.element('request-cancel').click()
  await expect.poll(() => p.element('request-outcome').textContent).toBe(en[copy])
  expect(request).toHaveBeenLastCalledWith({ action: 'dismiss-request', id })
  expect(p.element('request-editor').hidden).toBe(true)
})

it.each([
  ['saved', 'cloudVaultRequestSaved'],
  ['cancelled', 'cloudVaultRequestCancelled'],
] as const)('renders a terminal %s request state without enabling the form', async (state, copy) => {
  const id = 'c'.repeat(32)
  const p = page({ kind: 'request', id }, vi.fn(async () => ({
    request: { id, unit: 'fixture-worker.service', name: 'FIXTURE_KEY', state },
  })))
  p.run()
  await expect.poll(() => p.element('request-outcome').textContent).toBe(en[copy])
  expect((p.element('request-value') as HTMLInputElement).disabled).toBe(true)
  expect((p.element('request-save') as HTMLButtonElement).disabled).toBe(true)
})

it('disables request entry after a failed save instead of presenting an untrusted success', async () => {
  const id = 'd'.repeat(32)
  const request = vi.fn(async (value: unknown) => value && typeof value === 'object' && 'action' in value
    && value.action === 'inspect-request'
    ? { request: { id, unit: 'fixture-worker.service', name: 'FIXTURE_KEY', state: 'pending' } }
    : { ok: false, reason: 'unavailable' })
  const p = page({ kind: 'request', id }, request)
  p.run()
  await expect.poll(() => p.element('request-editor').hidden).toBe(false)
  const input = p.element('request-value') as HTMLInputElement
  input.value = 'fixture secret'
  p.element('request-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => p.element('request-outcome').textContent).toBe(en.cloudVaultRequestFailed)
  expect(p.element('request-editor').hidden).toBe(true)
  expect(input.disabled).toBe(true)
})

it('keeps API keys as the default section and renders website login metadata separately', async () => {
  const requests: unknown[] = []
  let inFlight = false
  let concurrent = false
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    requests.push(value)
    if (inFlight) concurrent = true
    inFlight = true
    await new Promise(resolve => setTimeout(resolve, 0))
    inFlight = false
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list') {
      return { ok: true, services: [{ unit: 'fixture-worker.service', names: ['FIXTURE_KEY'] }] }
    }
    return { ok: true, logins: [{ id: 'a'.repeat(32), origin: 'https://example.com', label: 'Example' }] }
  }))
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  expect(p.element('api-keys-panel').hidden).toBe(false)
  expect(p.element('websites-panel').hidden).toBe(true)
  p.element('websites-tab').click()
  expect(p.element('websites-panel').hidden).toBe(false)
  expect(p.element('api-keys-panel').hidden).toBe(true)
  expect(p.element('logins').textContent).toContain('https://example.com')
  expect(p.element('logins').textContent).toContain('Example')
  expect(p.element('logins').textContent).not.toContain('password')
  expect(requests).toEqual([{ action: 'list' }, { action: 'list-logins' }, { action: 'list-bot-logins' }])
  expect(concurrent).toBe(false)
})

it('keeps API keys usable when an older server lacks website logins', async () => {
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list') {
      return { ok: true, services: [{ unit: 'fixture-worker.service', names: ['FIXTURE_KEY'] }] }
    }
    return { ok: false, reason: 'unavailable' }
  }))
  p.run()
  await expect.poll(() => p.element('service').querySelectorAll('option').length).toBe(1)
  p.element('websites-tab').click()
  expect(p.element('websites-notice').textContent).toBe(en.cloudVaultWebsitesUnavailable)
  p.element('api-keys-tab').click()
  expect(p.element('service').querySelectorAll('option').length).toBe(1)
  expect(p.element('services').hidden).toBe(false)
})

it('keeps both Vault sections visible when the server has no API-key services', async () => {
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list') {
      return { ok: true, services: [] }
    }
    return { ok: false, reason: 'unavailable' }
  }))
  p.run()
  await expect.poll(() => p.element('management').hidden).toBe(false)
  expect(p.element('api-keys-tab').hidden).toBe(false)
  expect(p.element('websites-tab').hidden).toBe(false)
  expect(p.element('api-keys-panel').hidden).toBe(false)
})

it('starts website rotation with a blank username and clears the masked password', async () => {
  const id = 'b'.repeat(32)
  const requests: unknown[] = []
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    requests.push(value)
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list') {
      return { ok: true, services: [] }
    }
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list-logins') {
      return { ok: true, logins: [{ id, origin: 'https://example.com', label: 'Example' }] }
    }
    return { ok: true }
  }))
  p.run()
  await expect.poll(() => p.element('logins').children.length).toBe(1)
  p.element('websites-tab').click()
  const replace = p.element('logins').querySelector('button')
  if (replace === null) throw new Error('Expected website login action')
  replace.click()
  expect((p.element('login-username') as HTMLInputElement).value).toBe('')
  expect((p.element('login-password') as HTMLInputElement).value).toBe('')
  expect((p.element('login-origin') as HTMLInputElement).readOnly).toBe(true)
  ;(p.element('login-label') as HTMLInputElement).value = 'Updated'
  ;(p.element('login-username') as HTMLInputElement).value = 'new-user'
  ;(p.element('login-password') as HTMLInputElement).value = 'new-password'
  p.element('login-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => requests.some(value => value && typeof value === 'object' && 'action' in value && value.action === 'replace-login')).toBe(true)
  expect(requests).toContainEqual({ action: 'replace-login', id, label: 'Updated', username: 'new-user', password: 'new-password' })
  expect((p.element('login-password') as HTMLInputElement).value).toBe('')
})

it('assigns a website login to a Bot and displays its account without exposing the credentials', async () => {
  const bot = { id: 'bot-scout', name: 'Scout' }
  const assigned = { id: 'e'.repeat(32), origin: 'https://example.com', label: 'Operations', bot: bot.id }
  const requests: unknown[] = []
  let saved = false
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    requests.push(value)
    if (value && typeof value === 'object' && 'action' in value) {
      if (value.action === 'list') return { ok: true, services: [] }
      if (value.action === 'list-logins') return { ok: true, logins: [] }
      if (value.action === 'list-bot-logins') return { ok: true, botLogins: saved ? [assigned] : [], bots: [bot] }
      if (value.action === 'add-login') { saved = true; return { ok: true } }
    }
    return { ok: false, reason: 'unavailable' }
  }))
  p.run()
  await expect.poll(() => p.dom.window.document.querySelector('main')?.getAttribute('aria-busy')).toBe('false')
  p.element('websites-tab').click()
  p.element('add-login').click()
  const scope = p.element('login-bot') as HTMLSelectElement
  expect([...scope.options].map(option => option.text)).toEqual(['Personal', 'Scout'])
  scope.value = bot.id
  const fill = (id: string, value: string): void => { (p.element(id) as HTMLInputElement).value = value }
  fill('login-origin', assigned.origin)
  fill('login-label', assigned.label)
  fill('login-username', 'fixture-user')
  fill('login-password', 'fixture-password')
  p.element('login-editor').dispatchEvent(new p.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await expect.poll(() => p.element('logins').textContent).toContain('Scout')
  expect(p.element('logins').textContent).not.toContain('fixture-')
  expect(requests).toContainEqual({
    action: 'add-login', bot: bot.id, origin: assigned.origin, label: assigned.label,
    username: 'fixture-user', password: 'fixture-password',
  })
  p.element('logins').querySelector('button')?.click()
  expect(scope.value).toBe(bot.id)
  expect(scope.disabled).toBe(true)
  expect((p.element('login-password') as HTMLInputElement).value).toBe('')
})

it('requires confirmation before removing a website login', async () => {
  const id = 'c'.repeat(32)
  const requests: unknown[] = []
  const p = page({ kind: 'manage' }, vi.fn(async (value: unknown) => {
    requests.push(value)
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list') {
      return { ok: true, services: [] }
    }
    if (value && typeof value === 'object' && 'action' in value && value.action === 'list-logins') {
      return { ok: true, logins: [{ id, origin: 'https://example.com', label: 'Example' }] }
    }
    return { ok: true }
  }))
  p.run()
  await expect.poll(() => p.element('logins').children.length).toBe(1)
  p.element('websites-tab').click()
  const actions = p.element('logins').querySelectorAll('button')
  actions[1]?.click()
  expect(p.element('confirmation').hasAttribute('open')).toBe(true)
  expect(requests).not.toContainEqual({ action: 'remove-login', id })
  p.element('confirm-revoke').click()
  await expect.poll(() => requests).toContainEqual({ action: 'remove-login', id })
})
