// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError, SlotTestRuntime } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import type { ModelSelection } from '@yharness/api-remotes/client'
import { createSnapshotStore } from '@yharness/client-store'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { en, zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@yharness/client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const renderLabel: ComponentProps<typeof ModelSelect>['renderSlot'] = (_name, _owner, options) => options?.fallback ?? null

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    pending: null,
    error: null,
    ...overrides,
  }
}

function modelGroups(count: number): ModelDirectoryState['groups'] {
  const group = state().groups[0]!
  return [{ ...group, models: [
    ...group.models,
    ...Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
      id: `model-${index + 2}`, name: `Model ${index + 2}`,
    })),
  ].slice(0, count) }]
}

const scrollIntoView = vi.fn()
beforeEach(() => {
  scrollIntoView.mockClear()
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  onTestFinished(() => {
    if (descriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    else Object.defineProperty(Element.prototype, 'scrollIntoView', descriptor)
  })
})

afterEach(cleanup)

describe('ModelSelect provider-first selection', () => {
  const groups = [
    { id: 'alpha', name: 'Gateway', models: [{ id: 'shared', name: 'Shared' }] },
    { id: 'beta', name: 'Gateway', models: [
      { id: 'shared', name: 'Shared' }, { id: 'other', name: 'Shared' },
    ] },
    { id: 'empty', name: 'Empty', models: [] },
  ]
  function mount(overrides: Partial<ModelDirectoryState> = {}) {
    const directory = createSnapshotStore(state({ current: { provider: 'alpha', model: 'shared' }, groups, ...overrides }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((draft) => { draft.current = selection })
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model|Select model/ })
    fireEvent.click(trigger)
    return { directory, select, trigger }
  }
  function provider(id: string) {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: `Gateway (${id})` }))
  }

  it('stages a qualified provider then accepts only a model on that route', async () => {
    const { directory, select, trigger } = mount()
    provider('beta')
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Shared (shared)', 'Shared (other)'])
    expect(screen.getAllByRole('menuitemradio').every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(select).not.toHaveBeenCalled()
    expect(directory.getSnapshot().current).toEqual({ provider: 'alpha', model: 'shared' })
    expect(trigger.textContent).toBe('Shared')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shared (other)' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'beta', model: 'other' })
  })

  it('keeps repeated provider switches draft-only and resets them after cancel', () => {
    const { directory, select, trigger } = mount()
    provider('beta')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Model/ }))
    expect(screen.getByRole('menuitem', { name: /^Model/ }).textContent).toBe(`Model${zh['trigger.fallback']}`)
    provider('alpha')
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Shared'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    provider('beta')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Gateway (alpha)' })).toBeTruthy()
    expect(select).not.toHaveBeenCalled()
    expect(directory.getSnapshot().current).toEqual({ provider: 'alpha', model: 'shared' })
  })

  it('starts an unset session with providers and leaves Escape without choosing one', () => {
    const { select } = mount({ current: null })
    expect(screen.getByRole('menuitemradio', { name: 'Gateway (alpha)' })).toBeTruthy()
    expect(screen.queryByText('Shared')).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('exposes each full qualified provider label when a long duplicate name is truncated', () => {
    const name = 'Long Provider Display Name '.repeat(6)
    mount({ groups: ['alpha', 'beta'].map(id => ({ id, name, models: [] })) })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    for (const id of ['alpha', 'beta']) {
      const label = `${name} (${id})`
      expect(screen.getByRole('menuitemradio', { name: label.replace(/\s+/g, ' ').trim() }).getAttribute('title')).toBe(label)
    }
  })

  it('limits empty and failed states to the chosen provider', () => {
    const { select } = mount({ failures: [{ id: 'failed', name: 'Failed', message: 'Catalog down' }] })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Empty' }))
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
    expect(screen.queryByText(/Catalog down/)).toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Failed' }))
    expect(screen.getByText(/Catalog down/)).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /Shared/ })).toBeNull()
    expect(select).not.toHaveBeenCalled()
  })

  it('drops a stale provider draft when the authoritative session changes externally', () => {
    const { directory, select } = mount()
    provider('beta')
    act(() => { directory.update((draft) => { draft.current = { provider: 'empty', model: 'removed' } }) })
    expect(screen.queryAllByRole('menuitemradio')).toHaveLength(0)
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Empty' })).toBeTruthy()
  })

  it('does not revive a discarded provider draft if an external selection returns to its earlier value', () => {
    const { directory } = mount()
    provider('beta')
    act(() => { directory.update((draft) => { draft.current = { provider: 'empty', model: 'removed' } }) })
    act(() => { directory.update((draft) => { draft.current = { provider: 'alpha', model: 'shared' } }) })
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Shared'])
    expect(screen.getByRole('menuitemradio', { name: 'Shared' }).getAttribute('aria-checked')).toBe('true')
  })

  it.each(['alpha', 'beta'])('preserves explicitly selected compatible effort and speed on a different model from %s', async (providerId) => {
    const serviceTiers = { defaultTier: 'fast', tiers: [{ id: 'fast', name: 'Fast' }, { id: 'default', name: 'Standard' }] }
    const current = { provider: 'alpha', model: 'shared', reasoningEffort: 'max', serviceTier: 'default' }
    const { select } = mount({ current, groups: [
      { id: 'alpha', name: 'Gateway', models: [
        { id: 'shared', name: 'Shared', reasoning, serviceTiers },
        { id: 'other', name: 'Shared', reasoning, serviceTiers },
      ] },
      { id: 'beta', name: 'Gateway', models: [{ id: 'other', name: 'Shared', reasoning, serviceTiers }] },
    ] })
    provider(providerId)
    fireEvent.click(screen.getByRole('menuitemradio', { name: providerId === 'alpha' ? 'Shared (other)' : 'Shared' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: providerId, model: 'other', reasoningEffort: 'max', serviceTier: 'default' })
  })

  it.each(['missing', 'unsupported'])('uses target defaults for %s effort and speed metadata', async (metadata) => {
    const current = { provider: 'alpha', model: 'shared', reasoningEffort: 'max', serviceTier: 'default' }
    const { select } = mount({ current, groups: [groups[0]!, {
      id: 'beta', name: 'Gateway', models: [{ id: 'other', name: 'Other', ...metadata === 'missing' ? {} : {
        reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] },
        serviceTiers: { defaultTier: 'fast', tiers: [{ id: 'fast', name: 'Fast' }] },
      } }],
    }] })
    provider('beta')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Other' }))
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'beta', model: 'other' })
  })

  it('does not close a reopened menu when an interrupted selection eventually succeeds', async () => {
    const directory = createSnapshotStore(state({ current: { provider: 'alpha', model: 'shared' }, groups }))
    let finish: (value: { ok: true; value: undefined }) => void = () => { throw new Error('Selection not started') }
    const select = vi.fn(() => new Promise<{ ok: true; value: undefined }>((resolve) => { finish = resolve }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    provider('beta')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shared (other)' }))
    act(() => { directory.update((draft) => { draft.pending = { provider: 'beta', model: 'other' } }) })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    expect(screen.getAllByRole('menuitemradio').every(row => row.hasAttribute('disabled'))).toBe(true)
    await act(async () => { finish({ ok: true, value: undefined }) })
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('keeps compatible effort and speed until a different model is explicitly accepted', () => {
    const tiers = { defaultTier: 'fast', tiers: [{ id: 'fast', name: 'Fast' }, { id: 'default', name: 'Standard' }] }
    const current = { provider: 'alpha', model: 'shared', reasoningEffort: 'max', serviceTier: 'default' }
    const { directory, select } = mount({ current, groups: [
      { id: 'alpha', name: 'Gateway', models: [{ id: 'shared', name: 'Shared', reasoning, serviceTiers: tiers }] },
      groups[1]!,
    ] })
    provider('beta')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: /Effort|Speed/ })).toBeNull()
    provider('alpha')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: /Effort.*Max/ })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /Speed.*Standard/ })).toBeTruthy()
    expect(directory.getSnapshot().current).toEqual(current)
    expect(select).not.toHaveBeenCalled()
  })

  it('retains the saved model and the provider draft after an incompatible model is rejected', async () => {
    const current = { provider: 'alpha', model: 'shared' }
    const directory = createSnapshotStore(state({ current, groups }))
    const select = vi.fn(async () => ({ ok: false as const,
      error: new RemoteError('session/model-unavailable', 'session contains images', { provider: 'beta', model: 'other' }),
    }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    provider('beta')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Shared (other)' }))
    expect((await screen.findByRole('alert')).textContent).toContain('session contains images')
    expect(directory.getSnapshot().current).toEqual(current)
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Shared (shared)', 'Shared (other)'])
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Gateway (beta)' })).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Gateway (alpha)' })).toBeTruthy()
  })
})

describe('ModelSelect provider details', () => {
  it.each(['ready', 'loading', 'error'] as const)('keeps an unavailable trigger qualified during %s while retaining effort and speed', (status) => {
    const directory = createSnapshotStore(state({
      current: { provider: 'unconfigured-route', model: 'vendor/shared' },
      groups: [{ id: 'other-route', name: 'Other', models: [{ id: 'vendor/shared', name: 'Friendly Shared' }] }],
      status, routable: false, retainedEffort: 'Max', retainedTier: 'Standard',
    }))
    const select = vi.fn()
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', {
      name: 'Select model, current unconfigured-route/vendor/shared, reasoning effort Max, speed Standard',
    })
    expect(trigger.textContent).toBe('unconfigured-route/vendor/sharedMax · Standard')
    expect(trigger.getAttribute('title')).toBe('unconfigured-route/vendor/shared · Max · Standard')
    expect(directory.getSnapshot().current).toEqual({ provider: 'unconfigured-route', model: 'vendor/shared' })
    expect(select).not.toHaveBeenCalled()
  })

  it('shows the selected provider when identical model names and ids exist on different routes', async () => {
    const groups = [
      { id: 'alpha', name: 'Alpha API', models: [{ id: 'vendor/shared-model', name: 'Acme: Shared / Model' }] },
      { id: 'beta', name: 'Beta API', models: [{ id: 'vendor/shared-model', name: 'Acme: Shared / Model' }] },
    ]
    const directory = createSnapshotStore(state({ current: { provider: 'beta', model: 'vendor/shared-model' }, groups }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection, groups }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: 'Select model, current Acme: Shared / Model' })
    fireEvent.click(trigger)
    const provider = screen.getByRole('menuitem', { name: 'Provider', description: 'Beta API' })
    const model = screen.getByRole('menuitem', { name: /^Model\s*Acme: Shared \/ Model$/ })
    expect(`${provider.textContent}\n${model.textContent}\n`).toMatchInlineSnapshot(`
      "ProviderBeta API
      ModelAcme: Shared / Model
      "
    `)
    fireEvent.click(model)
    expect(screen.getByRole('menuitemradio', { name: 'Acme: Shared / Model' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Alpha API' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Acme: Shared / Model' }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({ provider: 'alpha', model: 'vendor/shared-model' })
      expect(screen.queryByRole('menu')).toBeNull()
    })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Alpha API' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Model\s*Acme: Shared \/ Model$/ })).toBeTruthy()
  })

  it.each(['catalog', 'failure'] as const)('qualifies duplicate provider labels from a %s with the selected route id', (other) => {
    const groups = [{ id: 'route-a', name: 'Shared Gateway', models: [{ id: 'shared', name: 'Shared' }] }]
    const failures = other === 'failure' ? [{ id: 'route-b', name: 'Shared Gateway', message: 'Catalog unavailable' }] : []
    if (other === 'catalog') groups.push({ id: 'route-b', name: 'Shared Gateway', models: [{ id: 'shared', name: 'Shared' }] })
    const directory = createSnapshotStore(state({ current: { provider: 'route-a', model: 'shared' }, groups, failures }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select model, current Shared' }))
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Shared Gateway (route-a)' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Model\s*Shared$/ })).toBeTruthy()
  })

  it.each([
    { groups: [{ id: 'gateway', name: 'Known Gateway', models: [{ id: 'other', name: 'Other' }] }], failures: [], provider: 'gateway', label: 'Known Gateway' },
    { groups: [], failures: [{ id: 'gateway', name: 'Failed Gateway', message: 'Catalog unavailable' }], provider: 'gateway', label: 'Failed Gateway' },
    { groups: [], failures: [], provider: 'missing/gateway', label: 'missing/gateway' },
  ])('keeps provider $label separate from an unavailable saved model', ({ groups, failures, provider, label }) => {
    const current = { provider, model: 'vendor/unlisted-model' }
    const directory = createSnapshotStore(state({ current, groups, failures, routable: false }))
    const select = vi.fn()
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: `Select model, current ${provider}/vendor/unlisted-model` })
    expect(trigger.textContent).toBe(`${provider}/vendor/unlisted-model`)
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Provider', description: label })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: /^Model\s*vendor\/unlisted-model$/ }).textContent).toBe('Modelvendor/unlisted-model')
    expect(directory.getSnapshot().current).toEqual(current)
    expect(select).not.toHaveBeenCalled()
  })

  it.each([en, zh])('localizes Provider and Account labels while preserving route qualification', (copy) => {
    const groups = [
      { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'shared', name: 'Shared' }] },
      { id: 'external-account', name: copy['provider.account'], models: [{ id: 'shared', name: 'Shared' }] },
    ]
    const translate: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
      const template = key in copy ? copy[key as keyof typeof copy] : key
      return params === undefined ? template : template.replace(/\{(\w+)\}/g,
        (match, name: string) => name in params ? String(params[name]) : match)
    }
    render(<ModelSelect renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ current: { provider: 'deepseek-account', model: 'shared' }, groups }))}
      load={vi.fn()} select={vi.fn()} t={translate} />)
    fireEvent.click(screen.getByRole('button', { name: translate('trigger.aria', { model: 'Shared' }) }))
    expect(screen.getByRole('menuitem', {
      name: copy['menu.provider'], description: `${copy['provider.account']} (deepseek-account)`,
    })).toBeTruthy()
  })

  it.each(['', '   '])('uses the route id when the provider display label is blank (%j)', (name) => {
    const directory = createSnapshotStore(state({
      current: { provider: 'blank-gateway', model: 'shared' },
      groups: [{ id: 'blank-gateway', name, models: [{ id: 'shared', name: 'Shared' }] }],
    }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select model, current Shared' }))
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'blank-gateway' })).toBeTruthy()
  })

  it('prefers the provider catalog label over a failure for the same route id', () => {
    const groups = [
      { id: 'route-a', name: 'Current Gateway', models: [{ id: 'shared', name: 'Shared' }] },
      { id: 'route-b', name: 'Other Gateway', models: [{ id: 'shared', name: 'Shared' }] },
    ]
    const directory = createSnapshotStore(state({ current: { provider: 'route-a', model: 'shared' }, groups,
      failures: [{ id: 'route-b', name: 'Current Gateway', message: 'Earlier catalog failure' }] }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select model, current Shared' }))
    expect(screen.getByRole('menuitem', { name: 'Provider', description: 'Current Gateway' })).toBeTruthy()
  })

  it('offers Provider as the first keyboard action and returns focus after backing out', () => {
    const select = vi.fn()
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state())}
      load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    const provider = screen.getByRole('menuitem', { name: 'Provider', description: 'DeepSeek' })
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(provider)
    expect(provider.querySelector('[title]')?.getAttribute('title')).toBe('DeepSeek')
    fireEvent.keyDown(provider, { key: 'Tab' })
    const route = screen.getByRole('menuitemradio', { name: 'DeepSeek' })
    expect(document.activeElement).toBe(route)
    expect(route.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(route, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Provider' }))
    expect(select).not.toHaveBeenCalled()
  })
})

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: 'Select model, current DeepSeek-V4-Flash, reasoning effort High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('Select model, current DeepSeek-V4-Flash, reasoning effort Max')
      expect(document.activeElement).toBe(trigger)
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: 'Select model, current Model, reasoning effort Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: 'Select model, current deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /Effort/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it.each(['model', 'provider'])('keeps the saved id and effort when the selected %s disappears', (removed) => {
    const directory = createSnapshotStore(state({ retainedEffort: 'High' }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    expect(screen.getByRole('button', { name: /Select model, current/ }).textContent).toContain('DeepSeek-V4-Flash')
    act(() => { directory.update((snapshot) => {
      snapshot.groups = removed === 'provider' ? [] : snapshot.groups.map(group => ({ ...group, models: [] }))
      snapshot.routable = false
    }) })
    expect(screen.getByRole('button', { name: /Select model, current/ }).textContent)
      .toMatchInlineSnapshot('"deepseek-official/deepseek-v4-flashHigh"')
    expect(directory.getSnapshot().current).toEqual(state().current)
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    expect(screen.getByRole('button', { name: 'Loading models…' }).textContent)
      .toContain('Loading models…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Select model, current DeepSeek-V4-Flash, reasoning effort High',
      })).toBeTruthy()
    })
  })

  it.each([false, true])('announces rejected selections with ownership guidance only for held writers (%s)', async (sessionInUse) => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      const error = sessionInUse
        ? new RemoteError('session/writer-held', 'writer held', { sessionId: SessionId('owned') })
        : new RemoteError('session/model-unavailable', 'session already contains images', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
      directory.set(state({ groups, status: 'error', error: 'unrelated catalog refresh' }))
      return { ok: false as const, error }
    })
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: /Select model|current/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    const rejected = screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ })
    fireEvent.mouseMove(rejected)
    fireEvent.click(rejected)
    const toast = await screen.findByRole('alert')
    expect(document.activeElement).toBe(trigger)
    expect(toast.textContent).toBe(sessionInUse
      ? zh['error.sessionInUse']
      : 'Model operation failed: session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.keyDown(trigger, { key: 'Tab' })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' }))
  })

  it('spins on the trigger and the chosen model row until the selection settles, across pane changes', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    let settle!: () => void
    const select = vi.fn((selection: ModelSelection) => {
      directory.set(state({ groups, status: 'selecting', pending: selection }))
      return new Promise<{ ok: true; value: undefined }>((resolve) => {
        settle = () => {
          directory.set(state({ groups, current: selection }))
          resolve({ ok: true, value: undefined })
        }
      })
    })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    const spinners = () => document.querySelectorAll('[data-state="ongoing"]')

    const trigger = screen.getByRole('button', { name: /Select model|current/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    expect(spinners()).toHaveLength(2)
    expect(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }).querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(trigger.getAttribute('aria-busy')).toBe('true')

    // Leaving the pane unmounts the row; the trigger keeps the feedback.
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menuitemradio')).toBeNull()
    expect(spinners()).toHaveLength(1)
    expect(trigger.querySelector('[data-state="ongoing"]')).not.toBeNull()

    await act(async () => { settle() })
    expect(spinners()).toHaveLength(0)
    expect(trigger.getAttribute('aria-busy')).toBe('false')
  })

  it('spins on the chosen effort row only', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn((selection: ModelSelection) => {
      directory.set(state({ status: 'selecting', pending: selection }))
      return new Promise<undefined>(() => {})
    })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: /Select model|current/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    expect(screen.getAllByRole('menuitemradio')
      .filter(row => row.querySelector('[data-state="ongoing"]') !== null)
      .map(row => row.textContent)).toEqual(['Max'])
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        renderSlot={renderLabel}
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /Select model/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      expect(fireEvent.mouseDown(menu)).toBe(true)
      expect(fireEvent.mouseDown(trigger)).toBe(false)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(undefined)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect processing speed', () => {
  const serviceTiers = {
    tiers: [
      { id: 'default', name: 'Standard' },
      { id: 'priority', name: 'Fast', description: '2x speed' },
    ],
    defaultTier: 'priority',
  }
  const codexGroups: ModelDirectoryState['groups'] = [{
    id: 'codex-backend',
    name: 'Codex',
    models: [{ id: 'gpt-6.1-sol', name: 'Sol', reasoning, serviceTiers }],
  }]

  it('shows the adapter default tier and submits Standard while preserving the effort', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      groups: codexGroups,
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection, groups: codexGroups }))
      return { ok: true as const, value: undefined }
    })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    // No conversation tier yet, so the caption reads the adapter's own default.
    const trigger = screen.getByRole('button', { name: 'Select model, current Sol, reasoning effort High, speed Fast' })
    expect(trigger.textContent).toContain('Fast')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Speed/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Standard', 'Fast'])
    expect(screen.queryByText('2x speed')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Standard/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'codex-backend',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'high',
        serviceTier: 'default',
      })
      expect(trigger.getAttribute('aria-label')).toBe('Select model, current Sol, reasoning effort High, speed Standard')
    })
  })

  it('keeps the chosen standard tier when the effort changes', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' },
      groups: codexGroups,
    }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select model, current Sol, reasoning effort High, speed Standard' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Off/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'codex-backend',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'off',
        serviceTier: 'default',
      })
    })
  })

  it('offers no Speed row for a model that advertises no tiers', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Select model, current DeepSeek-V4-Flash, reasoning effort High' }))
    expect(screen.queryByRole('menuitem', { name: /Speed/ })).toBeNull()
  })
})

describe('ModelSelect keyboard walk', () => {
  function mountOpen() {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={select}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    return select
  }

  it.each(['model', 'effort'])('prevents button mousedown defaults in the %s pane without selecting it', (pane) => {
    const select = mountOpen()
    const cell = screen.getByRole('menuitem', { name: pane === 'model' ? /^Model/ : /Effort/ })
    expect(fireEvent.mouseDown(cell.firstElementChild!)).toBe(false)
    fireEvent.click(cell)
    const rows = screen.getAllByRole('menuitemradio')
    const focused = document.activeElement
    expect(fireEvent.mouseDown(rows[0]!.firstElementChild!)).toBe(false)
    fireEvent.mouseUp(screen.getByRole('menu'))
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(focused!, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: pane === 'model' ? /^Model/ : /Effort/ }))
  })

  it('↑↓ walk the rows of the shown pane, wrapping, and stay open', () => {
    mountOpen()
    // The trigger holds focus while the menu opens: the first forward step
    // enters at the first cell instead of skipping it. false = preventDefault ran.
    const cells = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(cells[0]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(cells[0])

    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map(row => row.textContent)).toEqual(['Off', 'High', 'Max'])
    // The pane opens on its checked row, so walking starts from High.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' }) // wraps to the top
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' }) // wraps to the bottom
    expect(document.activeElement).toBe(rows[2])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('Tab settles the focused row like Enter and closes the menu', async () => {
    const select = mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' }) // High → Max
    expect(fireEvent.keyDown(rows[2]!, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('Shift+Tab leaves a drilled pane and then closes, like Escape', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(fireEvent.keyDown(rows[0]!, { key: 'Tab', shiftKey: true })).toBe(false)
    // Back on the drilled cell, then closed on the second press.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[2])
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(cells[2]!, { key: 'Tab', shiftKey: true })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Tab with the keyboard still on the trigger enters the menu at the value in use', () => {
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state())}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(false)
    // The root pane's first cell carries the current selection.
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[0])
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('a backward step from outside the list enters at the last row, and a closed menu leaves Tab native', () => {
    mountOpen()
    const [providerRow, , effortRow] = screen.getAllByRole('menuitem')
    expect(fireEvent.keyDown(providerRow!, { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(effortRow)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(fireEvent.keyDown(trigger, { key: 'Tab' })).toBe(true)
  })

  it('hands a drilled pane the focus its unmounted cell left behind, on the value in use', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    const rows = screen.getAllByRole('menuitemradio')
    // The fixture's model defaults to the High effort: the checked row is where
    // the keyboard lands, not the top of the list.
    expect(rows[1]!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(rows[1])
    // The walk continues from there.
    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[2])
  })

  it('keeps the card navigable when a pane has no rows, and leaves a retry its Tab', () => {
    const load = vi.fn()
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [], failures: [], status: 'error', error: 'catalog down',
    }))
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={directory}
      load={load}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(fireEvent.mouseDown(retry)).toBe(false)
    fireEvent.click(retry)
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('group', { name: 'Provider, model, reasoning effort, and speed' })).toBeTruthy()
    retry.focus()
    // A control that is not a row keeps the browser's traversal.
    expect(fireEvent.keyDown(retry, { key: 'Tab' })).toBe(true)
    // Escape still backs out of the pane and then closes the card.
    fireEvent.keyDown(retry, { key: 'Escape' })
    // Back on the root pane, whose only cell remains (no model means no effort row).
    const cell = screen.getAllByRole('menuitem')[0]!
    fireEvent.keyDown(cell, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('focuses the checked model in a small catalog', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(rows[0])
  })

  it('Escape returns to the root pane with the keyboard on the cell that drilled in', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /Effort/ }))
    const rows = screen.getAllByRole('menuitemradio')
    fireEvent.keyDown(rows[0]!, { key: 'Escape' })
    // The root pane is back with its two cells.
    const cells = screen.getAllByRole('menuitem')
    // Back on the drilled cell, so the next keystroke still reaches the menu.
    expect(document.activeElement).toBe(cells[2])
    expect(screen.getByRole('menu')).toBeTruthy()
    // A second Escape closes back to the trigger.
    fireEvent.keyDown(cells[2]!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Escape from the model list lands back on the model cell', () => {
    mountOpen()
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    fireEvent.keyDown(screen.getAllByRole('menuitemradio')[0]!, { key: 'Escape' })
    const cells = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(cells[1])
  })

  it('focuses the first row when no model is checked in a small catalog', () => {
    // The session runs a model the catalog no longer lists: no row is checked.
    render(<ModelSelect
      renderSlot={renderLabel}
      locked={false}
      available
      directory={createSnapshotStore(state({ current: { provider: 'deepseek-official', model: 'gone' } }))}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue({ ok: true, value: undefined })}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(rows[0])
  })
})

describe('ModelSelect catalog size', () => {
  it.each([0, 1, 4, 5])('shows search only above four models (%i models)', (count) => {
    const groups = modelGroups(count)
    const current = { provider: 'deepseek-official', model: count > 1 ? 'model-2' : 'deepseek-v4-flash' }
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups, current }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const rows = screen.queryAllByRole('menuitemradio')
    expect(rows).toHaveLength(count)
    if (count > 4) {
      const search = screen.getByRole('searchbox')
      expect(search).toBeInstanceOf(HTMLInputElement)
      expect(document.activeElement).toBe(search)
      expect(search.getAttribute('aria-activedescendant')).toBe(rows[1]!.id)
      expect(rows.every(row => row.tabIndex === -1)).toBe(true)
    } else {
      expect(screen.queryByRole('searchbox')).toBeNull()
      expect(document.activeElement).toBe(count === 0 ? trigger : rows[count > 1 ? 1 : 0])
      expect(rows.every(row => row.tabIndex === 0)).toBe(true)
    }
    if (count === 0) expect(screen.getByRole('status').textContent).toBe(zh['empty.models'])
  })

  it.each([0, 1, 4, 5])('opens an unselected %i-model catalog on search or its first row', (count) => {
    render(<ModelSelect renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(count), current: null }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: 'Select model' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek' }))
    const rows = screen.queryAllByRole('menuitemradio')
    expect(rows).toHaveLength(count)
    expect(rows.every(row => row.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(document.activeElement).toBe(count > 4 ? screen.getByRole('searchbox') : rows[0] ?? trigger)
    if (count <= 4) expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it.each([true, false])('clears search and restores focus across 5 → 4 → 5 models (checked: %s)', (checked) => {
    const current = { provider: 'deepseek-official', model: checked ? 'model-3' : 'removed' }
    const directory = createSnapshotStore(state({ groups: modelGroups(5), current }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'Model 5' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(1)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(document.activeElement).toBe(search)

    act(() => { directory.set(state({ groups: modelGroups(4), current })) })
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows).toHaveLength(4)
    expect(document.activeElement).toBe(rows[checked ? 2 : 0])

    act(() => { directory.set(state({ groups: modelGroups(5), current })) })
    const restored = screen.getByRole('searchbox')
    expect(restored.getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(restored)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    expect(restored.getAttribute('aria-activedescendant'))
      .toBe(screen.getAllByRole('menuitemradio')[checked ? 2 : 0]!.id)
  })

  it('moves actual row focus with arrows, leaves Enter native, and selects with Tab in a small catalog', async () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(4), current: { provider: 'deepseek-official', model: 'model-2' } }))}
      load={vi.fn()} select={select} t={t} />)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const rows = screen.getAllByRole('menuitemradio')
    expect(document.activeElement).toBe(rows[1])
    expect(fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' })).toBe(false)
    expect(document.activeElement).toBe(rows[2])
    fireEvent.keyDown(rows[2]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[3])
    fireEvent.keyDown(rows[3]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[3])
    fireEvent.keyDown(rows[3]!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[2])
    expect(rows[2]!.hasAttribute('data-highlighted')).toBe(true)
    expect(fireEvent.keyDown(rows[2]!, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(rows[2]!, { key: 'ArrowLeft' })).toBe(true)
    expect(document.activeElement).toBe(rows[2])
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(rows[2]!, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'model-3' })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(screen.queryByRole('group', { name: 'Provider, model, reasoning effort, and speed' })).toBeNull()
    expect(trigger.hasAttribute('data-selection-focus')).toBe(true)
  })

  it('keeps Tab selection available after hovering a small-catalog row', async () => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const row = screen.getByRole('menuitemradio', { name: 'Model 3' })
    fireEvent.mouseMove(row)
    expect(document.activeElement).toBe(row)
    expect(row.hasAttribute('data-highlighted')).toBe(true)
    expect(fireEvent.keyDown(row, { key: 'Tab' })).toBe(false)
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'model-3' })
    await waitFor(() => { expect(screen.queryByRole('group', { name: 'Provider, model, reasoning effort, and speed' })).toBeNull() })
  })

  it.each(['Escape', 'Tab'])('leaves a small model pane with %s and returns to its root cell', (key) => {
    const select = vi.fn()
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(4) }))}
      load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    const row = screen.getAllByRole('menuitemradio')[0]!
    expect(fireEvent.keyDown(row, { key, shiftKey: key === 'Tab' })).toBe(false)
    const cell = screen.getByRole('menuitem', { name: /^Model/ })
    expect(document.activeElement).toBe(cell)
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(cell, { key, shiftKey: key === 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ModelSelect search', () => {
  it('clears search when reopening an unselected large catalog', () => {
    render(<ModelSelect renderSlot={renderLabel} locked={false} available
      directory={createSnapshotStore(state({ groups: modelGroups(5), current: null }))}
      load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: 'Select model' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek' }))
    const search = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Provider, model, reasoning effort, and speed' })).toBeNull()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'DeepSeek' }))
    expect(screen.getByRole('searchbox').getAttribute('value')).toBe('')
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
  })

  it('keeps other providers out of the model pane and announces a removed provider', () => {
    const directory = createSnapshotStore(state({ groups: [
      ...state().groups, { id: 'empty', name: 'Empty Provider', models: [] },
    ] }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    expect(screen.queryByRole('group', { name: 'Empty Provider' })).toBeNull()
    act(() => { directory.set(state({ groups: [] })) })
    expect(screen.getByRole('status').textContent).toBe(zh['empty.provider'])
    expect(screen.getByRole('status').closest('[role="menu"]')).toBeNull()
  })

  it.each(['Enter', 'Tab'])('returns focus silently after %s accepts the current model, without suppressing later focus', async (key) => {
    const select = vi.fn()
    render(<>
      <button type="button">Outside</button>
      <ModelSelect locked={false} available directory={createSnapshotStore(state({ groups: modelGroups(5) }))}
        renderSlot={renderLabel}
        load={vi.fn()} select={select} t={t} />
    </>)
    const trigger = screen.getByRole('button', { name: /Select model/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(true)
    expect(select).not.toHaveBeenCalled()
    act(() => { screen.getByRole('button', { name: 'Outside' }).focus() })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(false)
    act(() => { trigger.focus() })
    expect(trigger.hasAttribute('data-selection-focus')).toBe(false)
  })

  it.each(['Enter', 'Tab'])('keeps typing focus while arrows wrap selected-provider results and %s accepts the highlight', async (key) => {
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'beta' },
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [
          { id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }, { id: 'delta', name: 'Delta' },
          { id: 'epsilon', name: 'Epsilon' }, { id: 'gamma', name: 'Gamma' },
        ] },
        { id: 'other', name: 'Other', models: [{ id: 'zeta', name: 'Zeta' }] },
      ],
    }))
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    const search = screen.getByRole('searchbox')
    const [alpha, beta, delta, epsilon, gamma] = screen.getAllByRole('menuitemradio')
    expect(screen.queryByRole('menuitemradio', { name: 'Zeta' })).toBeNull()
    expect(search.getAttribute('aria-activedescendant')).toBe(beta!.id)
    for (const target of [delta, epsilon, gamma, alpha]) {
      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(search.getAttribute('aria-activedescendant')).toBe(target!.id)
      expect(document.activeElement).toBe(search)
    }
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    expect(scrollIntoView.mock.instances.at(-1)).toBe(gamma)
    expect(fireEvent.keyDown(search, { key: 'ArrowLeft' })).toBe(true)
    expect(fireEvent.keyDown(search, { key: 'ArrowRight' })).toBe(true)
    fireEvent.keyDown(search, { key: 'ArrowDown', isComposing: true })
    expect(search.getAttribute('aria-activedescendant')).toBe(gamma!.id)
    fireEvent.change(search, { target: { value: 'alp' } })
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getByRole('menuitemradio', { name: 'Alpha' }).id)
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(search.hasAttribute('aria-activedescendant')).toBe(false)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(select).not.toHaveBeenCalled()
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    const restored = screen.getAllByRole('menuitemradio')
    fireEvent.mouseMove(restored[4]!)
    expect(search.getAttribute('aria-activedescendant')).toBe(restored[4]!.id)
    fireEvent.keyDown(search, { key })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'gamma' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
  })

  it('filters names fuzzily within the provider, clears on reopening, and accepts a result', async () => {
    const directory = createSnapshotStore(state({ groups: [
      { ...modelGroups(5)[0]!, models: [...modelGroups(4)[0]!.models, { id: 'gemini', name: 'Gemini Flash' }] },
      { id: 'other', name: 'Other', models: [{ id: 'external', name: 'Gemini External' }] },
    ] }))
    const select = vi.fn().mockResolvedValue({ ok: true, value: undefined })
    render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: '  GMFL  ' } })
    expect(screen.getAllByRole('menuitemradio').map(row => row.textContent)).toEqual(['Gemini Flash'])
    fireEvent.change(search, { target: { value: 'zzzz' } })
    expect(screen.getByRole('status').textContent).toBe(zh['search.empty'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(search.getAttribute('value')).toBe('')
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(5)
    fireEvent.keyDown(search, { key: 'Escape' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Model/ }))
    const reopened = screen.getByRole('searchbox')
    expect(reopened.getAttribute('value')).toBe('')
    fireEvent.change(reopened, { target: { value: 'gmfl' } })
    fireEvent.keyDown(reopened, { key: 'Tab' })
    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull() })
    expect(select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'gemini' })
  })
})

it('shows the unselected model control with the inherited effort', async () => {
  const directory = createSnapshotStore<ModelDirectoryState>(state({ current: null, routable: false, retainedEffort: 'High' }))
  render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
  const trigger = screen.getByRole('button', { name: 'Select model' })
  expect(trigger.hasAttribute('disabled')).toBe(false)
  await expect(`${trigger.textContent}\n`).toMatchFileSnapshot('./expected/unselected-model.txt')
  expect(trigger.textContent).toContain('High')
  fireEvent.click(trigger)
  expect(screen.queryByRole('menuitem', { name: /Model/ })).toBeNull()
  expect(screen.getByRole('menuitemradio', { name: 'DeepSeek' })).toBeTruthy()
  expect(screen.queryByRole('searchbox')).toBeNull()
  const row = screen.getByRole('menuitemradio', { name: 'DeepSeek' })
  expect(document.activeElement).toBe(row)
  fireEvent.keyDown(row, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Provider, model, reasoning effort, and speed' })).toBeNull()
  fireEvent.click(trigger)
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'DeepSeek' }))
})


it('places account and official providers before third-party providers', async () => {
  const groups = ['custom', 'deepseek-official', 'deepseek-account', 'another'].map(id => ({
    id, name: id, models: [1, 2].map(index => ({ id: `${id}-${index}`, name: `${id}-${index}` })),
  }))
  const directory = createSnapshotStore<ModelDirectoryState>(state({ current: null, groups }))
  render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Select model' }))
  const names = screen.getAllByRole('menuitemradio').map(row => row.textContent)
  expect(names).toEqual([
    zh['provider.account'], 'deepseek-official', 'custom', 'another',
  ])
  expect(groups.map(group => group.id)).toEqual(['custom', 'deepseek-official', 'deepseek-account', 'another'])
  await expect(`${names.join('\n')}\n`).toMatchFileSnapshot('./expected/account-first.txt')
})

it.each([en, zh])('localizes the account group while preserving external names', (copy) => {
  const groups = ['deepseek-account', 'custom'].map(id => ({
    id, name: id === 'deepseek-account' ? 'DeepSeek Account' : 'My Gateway',
    models: [{ id: 'model', name: 'Model' }],
  }))
  render(<ModelSelect renderSlot={renderLabel} locked={false} available
    directory={createSnapshotStore(state({ current: null, groups }))}
    load={vi.fn()} select={vi.fn()} t={key => key in copy ? copy[key as keyof typeof copy] : key} />)
  fireEvent.click(screen.getByRole('button', { name: copy['trigger.selectAria'] }))
  expect(screen.getByRole('menuitemradio', { name: copy['provider.account'] })).toBeTruthy()
  expect(screen.getByRole('menuitemradio', { name: 'My Gateway' })).toBeTruthy()
})

it('restores the account model name after login without changing the saved route', () => {
  const groups = [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning },
  ] }]
  const selected = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  const directory = createSnapshotStore(state({ current: selected, groups, retainedEffort: 'High' }))
  render(<ModelSelect renderSlot={renderLabel} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
  expect(screen.getByRole('button', { name: /Select model, current/ }).textContent).toBe('DeepSeek FlashHigh')
  act(() => { directory.update((snapshot) => { snapshot.groups = []; snapshot.routable = false }) })
  expect(screen.getByRole('button', { name: /Select model, current/ }).textContent)
    .toMatchInlineSnapshot('"deepseek-account/deepseek-flashHigh"')
  act(() => { directory.update((snapshot) => { snapshot.groups = groups; snapshot.routable = true }) })
  expect(screen.getByRole('button', { name: /Select model, current/ }).textContent).toBe('DeepSeek FlashHigh')
  expect(directory.getSnapshot().current).toEqual(selected)
})

describe('ModelSelect model label slot', () => {
  async function mountWithLabel({ register, current, status }: {
    register: boolean
    current?: { provider: string; model: string } | null
    status?: ModelDirectoryState['status']
  }) {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const sessionId = SessionId('model-label')
    await runtime.sessions.add({ id: sessionId })
    const session = runtime.sessions.retainFor(runtime.ctx, sessionId)
    const groups = ['trusted', 'external'].map(id => ({
      id, name: `${id} gateway`, models: [{ id: 'same-model', name: 'Same model' }],
    }))
    const directory = createSnapshotStore(state({
      groups,
      ...current === undefined ? { current: { provider: 'trusted', model: 'same-model' } } : { current },
      ...status === undefined ? {} : { status },
    }))
    await runtime.root.declare(
      { 'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true } },
      ({ renderSlot, SessionProvider }) => <SessionProvider session={session}>
        <ModelSelect renderSlot={renderSlot} locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />
      </SessionProvider>,
    )
    if (register) {
      await runtime.mount({ inject: ['slots'], apply(ctx) {
        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register(
          { name: 'conversation.input.model.label' },
          ({ provider, model, placement, selected }) => (
            <span data-testid={`${placement}-label`}>{provider.id}:{model.name}:{String(selected)}</span>
          ),
        ))
      } })
    }
    runtime.renderRoot()
    return runtime
  }

  it('offers the selected model to the trigger, the menu value, and every option', async () => {
    await mountWithLabel({ register: true })
    const trigger = screen.getByRole('button', { name: 'Select model, current Same model' })
    expect(screen.getByTestId('trigger-label').textContent).toBe('trusted:Same model:true')
    expect(trigger.querySelector('[data-provider-id="trusted"][data-model-id="same-model"]')).toBeTruthy()
    fireEvent.click(trigger)
    expect(screen.getByTestId('menu-label').textContent).toBe('trusted:Same model:true')
    fireEvent.click(screen.getByRole('menuitem', { name: /^Model/ }))
    expect(screen.getByTestId('option-label').textContent).toBe('trusted:Same model:true')
  })

  it('keeps the catalog name without a contribution and never decorates a missing selection', async () => {
    await mountWithLabel({ register: false })
    expect(screen.getByRole('button', { name: 'Select model, current Same model' }).textContent).toBe('Same model')
  })

  it('leaves a loading catalog and an unset selection undecorated', async () => {
    await mountWithLabel({ register: true, current: null, status: 'loading' })
    expect(screen.getByRole('button', { name: zh['trigger.loading'] }).textContent).toBe(zh['trigger.loading'])
    expect(document.querySelector('[data-provider-id]')).toBeNull()
    expect(screen.queryByTestId('trigger-label')).toBeNull()
  })
})
