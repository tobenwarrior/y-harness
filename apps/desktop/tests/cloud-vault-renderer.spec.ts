import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en } from '../src/locale.ts'

function page(mode: { readonly kind: 'request'; readonly id: string }, request: (value: unknown) => Promise<unknown>) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/cloud-vault.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only', url: 'dsh-app://shell/cloud-vault.html',
  })
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
