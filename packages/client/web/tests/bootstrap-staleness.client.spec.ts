// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearBootstrapReloadGuard,
  isBootstrapStalenessOnly,
  reloadOnceForStaleness,
  type StalenessReloadSeams,
} from '../src/bootstrap-staleness.ts'

const STALE = 'Error: client-modules: replacing bootstrap module app requires a page reload'

/** Memory storage standing in for the session storage. */
function memoryStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { backing: Map<string, string> } {
  const backing = new Map<string, string>()
  if (initial !== undefined) backing.set('dsh.web.bootstrapReloaded', initial)
  return {
    backing,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) },
    removeItem: (key: string) => { backing.delete(key) },
  }
}

function seams(overrides: StalenessReloadSeams = {}): StalenessReloadSeams & { reloadPage: () => void; deferred: (() => void)[] } {
  const deferred: (() => void)[] = []
  return {
    reloadPage: vi.fn(),
    storage: memoryStorage(),
    settleMs: 0,
    defer: (callback: () => void) => { deferred.push(callback) },
    ...overrides,
    deferred,
  }
}

afterEach(() => { sessionStorage.clear() })

describe('isBootstrapStalenessOnly', () => {
  it('rejects empty and mixed failure sets', () => {
    expect(isBootstrapStalenessOnly([])).toBe(false)
    expect(isBootstrapStalenessOnly(['download failed'])).toBe(false)
    expect(isBootstrapStalenessOnly([STALE, 'download failed'])).toBe(false)
  })

  it('accepts only all-staleness sets', () => {
    expect(isBootstrapStalenessOnly([STALE])).toBe(true)
    expect(isBootstrapStalenessOnly([STALE, STALE])).toBe(true)
  })
})

describe('reloadOnceForStaleness', () => {
  it('reloads synchronously when the settle delay is zero', () => {
    const hooks = seams()
    expect(reloadOnceForStaleness(hooks)).toBe(true)
    expect(hooks.reloadPage).toHaveBeenCalledOnce()
    expect(hooks.deferred).toHaveLength(0)
    expect(hooks.storage?.getItem('dsh.web.bootstrapReloaded')).toBe('1')
  })

  it('defers the reload past the settle delay', () => {
    const hooks = seams({ settleMs: 2000 })
    expect(reloadOnceForStaleness(hooks)).toBe(true)
    expect(hooks.reloadPage).not.toHaveBeenCalled()
    expect(hooks.deferred).toHaveLength(1)
    hooks.deferred[0]?.()
    expect(hooks.reloadPage).toHaveBeenCalledOnce()
  })

  it('refuses a second reload while the guard stands', () => {
    const hooks = seams({ storage: memoryStorage('1') })
    expect(reloadOnceForStaleness(hooks)).toBe(false)
    expect(hooks.reloadPage).not.toHaveBeenCalled()
    expect(hooks.deferred).toHaveLength(0)
  })

  it('refuses the reload when storage is unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => {},
    }
    const hooks = seams({ storage })
    expect(reloadOnceForStaleness(hooks)).toBe(false)
    expect(hooks.reloadPage).not.toHaveBeenCalled()
  })

  it('uses the session storage and default timing without seams', () => {
    vi.useFakeTimers()
    try {
      const reloadPage = vi.fn()
      expect(reloadOnceForStaleness({ reloadPage })).toBe(true)
      expect(reloadPage).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('dsh.web.bootstrapReloaded')).toBe('1')
    } finally {
      vi.useRealTimers()
      sessionStorage.clear()
    }
  })

  it('reloads through the document location on the production path', () => {
    try {
      expect(reloadOnceForStaleness({ settleMs: 0 })).toBe(true)
      expect(sessionStorage.getItem('dsh.web.bootstrapReloaded')).toBe('1')
    } finally {
      sessionStorage.clear()
    }
  })
})

describe('clearBootstrapReloadGuard', () => {
  it('re-arms future incidents', () => {
    const storage = memoryStorage('1')
    clearBootstrapReloadGuard(storage)
    expect(storage.backing.has('dsh.web.bootstrapReloaded')).toBe(false)
  })

  it('ignores unavailable storage', () => {
    expect(() => { clearBootstrapReloadGuard({ removeItem: () => { throw new Error('denied') } }) }).not.toThrow()
  })
})
