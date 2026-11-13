import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en } from '../src/locale.ts'

function page(mode: { readonly kind: 'request'; readonly id: string } | { readonly kind: 'manage' }, request: (value: unknown) => Promise<unknown>) {
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
  await expect.poll(() => p.element('service').querySelectorAll('option').length).toBe(1)
  expect(p.element('api-keys-panel').hidden).toBe(false)
  expect(p.element('websites-panel').hidden).toBe(true)
  p.element('websites-tab').click()
  expect(p.element('websites-panel').hidden).toBe(false)
  expect(p.element('api-keys-panel').hidden).toBe(true)
  expect(p.element('logins').textContent).toContain('https://example.com')
  expect(p.element('logins').textContent).toContain('Example')
  expect(p.element('logins').textContent).not.toContain('password')
  expect(requests).toEqual([{ action: 'list' }, { action: 'list-logins' }])
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
