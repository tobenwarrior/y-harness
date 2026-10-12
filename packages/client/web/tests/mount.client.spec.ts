// @vitest-environment jsdom
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { mountClient } from '../src/mount.ts'

/** Stable entry state published synchronously before a plugin transaction mutates services. */
function provideEntries(ctx: Context) {
  let snapshot = { syncing: false, failures: [] as { id: string; message: string }[] }
  const listeners = new Set<() => void>()
  const retirementListeners = new Set<(fibers: readonly Fiber[]) => void>()
  const retry = vi.fn(async () => {})
  const entries = { state: {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }, retry, beforeRetire: (listener: (fibers: readonly Fiber[]) => void) => {
    retirementListeners.add(listener)
    return () => { retirementListeners.delete(listener) }
  } }
  ctx.reflect.provide('modules', { entries, importError: () => undefined })
  ctx.reflect.provide('loader', { entries: () => [] })
  ctx.reflect.provide('slots', { renderSlot: () => null })
  return { retry, listeners, retirementListeners, retire: (...fibers: Fiber[]) => {
    for (const listener of [...retirementListeners]) listener(fibers)
  }, publish: (next: typeof snapshot) => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  } }
}

/** Provide a fake `uiRenderer` from its own plugin fiber so it can be replaced. */
function provideRenderer(ctx: Context, mount: (container: HTMLElement) => () => void) {
  return ctx.plugin({ apply: (scope: Context) => {
    scope.reflect.provide('uiRenderer', { mount, affectedBy: (fibers: readonly Fiber[]) => fibers.length > 0 })
  } })
}

describe('mountClient', () => {
  it('rejects the initial mount so the carrier retains its boot recovery path', async () => {
    const ctx = new Context()
    provideEntries(ctx)
    const error = new Error('initial assembly failed')
    provideRenderer(ctx, () => { throw error })
    await expect(mountClient(ctx, document.createElement('div'))).rejects.toBe(error)
    await ctx.fiber.dispose()
  })
  it('mounts into the container and unmounts when the tree is disposed', async () => {
    const ctx = new Context()
    provideEntries(ctx)
    const unmount = vi.fn()
    const mount = vi.fn((_container: HTMLElement) => unmount)
    provideRenderer(ctx, mount)
    const container = document.createElement('div')

    await mountClient(ctx, container)

    expect(mount).toHaveBeenCalledExactlyOnceWith(container)
    expect(unmount).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('remounts when uiRenderer is replaced', async () => {
    const ctx = new Context()
    provideEntries(ctx)
    const container = document.createElement('div')
    const first = { unmount: vi.fn(), mount: vi.fn(() => first.unmount) }
    const second = { unmount: vi.fn(), mount: vi.fn(() => second.unmount) }

    await mountClient(ctx, container)
    expect(first.mount).not.toHaveBeenCalled()

    const renderer = provideRenderer(ctx, first.mount)
    await vi.waitFor(() => { expect(first.mount).toHaveBeenCalledExactlyOnceWith(container) })

    await renderer.dispose()
    expect(first.unmount).toHaveBeenCalledOnce()

    provideRenderer(ctx, second.mount)
    await vi.waitFor(() => { expect(second.mount).toHaveBeenCalledExactlyOnceWith(container) })
    await ctx.fiber.dispose()
    expect(second.unmount).toHaveBeenCalledOnce()
  })

  it('unmounts synchronously before entry teardown and waits through renderer replacement', async () => {
    const ctx = new Context()
    const entries = provideEntries(ctx)
    const container = document.createElement('div')
    const unmount = vi.fn()
    const first = provideRenderer(ctx, () => unmount)
    await mountClient(ctx, container)

    entries.publish({ syncing: true, failures: [] })
    expect(unmount).not.toHaveBeenCalled()
    entries.retire(first)
    expect(unmount).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    await first.dispose()
    const secondUnmount = vi.fn()
    const secondMount = vi.fn(() => secondUnmount)
    const second = provideRenderer(ctx, secondMount)
    await second.await()
    expect(secondMount).not.toHaveBeenCalled()
    entries.publish({ syncing: false, failures: [] })
    await vi.waitFor(() => { expect(secondMount).toHaveBeenCalledExactlyOnceWith(container) })
    await ctx.fiber.dispose()
    expect(secondUnmount).toHaveBeenCalledOnce()
    expect(entries.listeners.size).toBe(0)
    expect(entries.retirementListeners.size).toBe(0)
  })

  it('keeps a mounted application usable when prefetch fails before teardown', async () => {
    const ctx = new Context()
    const entries = provideEntries(ctx)
    const container = document.createElement('div')
    const unmount = vi.fn()
    const mount = vi.fn(() => unmount)
    provideRenderer(ctx, mount)
    await mountClient(ctx, container)
    entries.publish({ syncing: false, failures: [{ id: 'layout', message: 'download failed' }] })
    expect(unmount).not.toHaveBeenCalled()
    expect(mount).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('shows retryable failure after teardown instead of mounting a broken roster', async () => {
    const ctx = new Context()
    const entries = provideEntries(ctx)
    const container = document.createElement('div')
    const mount = vi.fn(() => () => {})
    const renderer = provideRenderer(ctx, mount)
    await mountClient(ctx, container)
    entries.publish({ syncing: true, failures: [] })
    entries.retire(renderer)
    entries.publish({ syncing: false, failures: [{ id: 'layout', message: 'activation failed' }] })
    expect(mount).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('activation failed')
    const retry = container.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(retry?.textContent).toBe('Retry')
    retry?.click()
    expect(entries.retry).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
