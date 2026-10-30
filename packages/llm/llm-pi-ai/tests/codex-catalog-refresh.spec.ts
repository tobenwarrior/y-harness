import { describe, expect, it, vi } from 'vitest'
import { CodexBackendRuntime, declineCodexRequest } from '../src/codex-backend.ts'
import type { CodexPreferences } from '../src/codex-backend.ts'
import { CodexBackendConnection } from '../src/codex-backend-connection.ts'

const refreshedCatalog = {
  data: [{ id: 'fresh-id', model: 'fresh-model', displayName: 'Fresh', description: 'Fresh catalog', hidden: false }],
}
const cachedModel = {
  id: 'cached-model', name: 'Cached', description: 'Cached catalog', efforts: [], serviceTiers: [], inputModalities: ['text' as const],
}

function fixture(options: {
  enabled?: boolean
  account?: unknown
  models?: unknown
  interval?: number
  notifyViewChanged?: () => void
} = {}) {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'initialize') return { userAgent: 'codex' }
    if (method === 'account/read') return { account: options.account === undefined ? { type: 'chatgpt' } : options.account }
    if (method === 'model/list') return options.models ?? refreshedCatalog
    return {}
  })
  const peer = {
    request,
    notify: vi.fn(),
    subscribe: (listener: (method: string, params: Record<string, unknown>) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close: vi.fn(),
  }
  const persist = vi.fn(async (_preferences: CodexPreferences) => {})
  const runtime = new CodexBackendRuntime({
    connect: async () => peer,
    resolveAccess: () => ({ cwd: '/project', sandbox: 'workspace-write', writableRoots: ['/project'], approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/project'], networkAccess: true }, request: declineCodexRequest }),
    preferences: { enabled: options.enabled ?? true, models: [cachedModel], tiers: {} },
    persist,
    catalogRefreshIntervalMs: options.interval ?? 100,
    ...(options.notifyViewChanged === undefined ? {} : { notifyViewChanged: options.notifyViewChanged }),
  })
  return { runtime, request, persist, peer }
}

describe('automatic ChatGPT catalog refresh', () => {
  it('resolves and bounds the configured connection cadence', () => {
    expect(CodexBackendConnection.Config({}).catalogRefreshIntervalMs).toBe(15 * 60 * 1000)
    expect(CodexBackendConnection.Config({ catalogRefreshIntervalMs: 1 }).catalogRefreshIntervalMs).toBe(1)
    expect(() => CodexBackendConnection.Config({ catalogRefreshIntervalMs: 0 })).toThrow()
    expect(() => CodexBackendConnection.Config({ catalogRefreshIntervalMs: 2 ** 31 })).toThrow()
  })

  it.each([0, 2 ** 31, 1.5])('rejects an invalid refresh interval (%s)', (interval) => {
    expect(() => fixture({ interval })).toThrow('refresh interval')
  })

  it('refreshes an enabled account on startup', async () => {
    const { runtime, request } = fixture()
    try {
      runtime.startAutomaticRefresh()
      await vi.waitFor(() => expect(request.mock.calls.map(([method]) => method)).toContain('model/list'))
      expect(runtime.models()).toEqual([{ id: 'fresh-model', name: 'Fresh', description: 'Fresh catalog', efforts: [], serviceTiers: [], inputModalities: ['text', 'image'] }])
    } finally {
      runtime.close()
    }
  })

  it('refreshes on the configured interval without overlapping catalog requests', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<unknown>()
    const f = fixture()
    f.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'codex' }
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return gate.promise
      return {}
    })
    try {
      f.runtime.startAutomaticRefresh()
      await vi.advanceTimersByTimeAsync(100)
      expect(f.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(1)
      gate.resolve(refreshedCatalog)
      await vi.advanceTimersByTimeAsync(100)
      expect(f.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2)
    } finally {
      f.runtime.close()
      vi.useRealTimers()
    }
  })

  it('does not launch an automatic read while the route is disabled', async () => {
    vi.useFakeTimers()
    const f = fixture({ enabled: false })
    try {
      f.runtime.startAutomaticRefresh()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(f.request).not.toHaveBeenCalled()
    } finally {
      f.runtime.close()
      vi.useRealTimers()
    }
  })

  it('keeps the cached catalog when account authorization is absent', async () => {
    const { runtime, request, persist } = fixture({ account: null })
    try {
      await runtime.refresh()
      expect(runtime.models()).toEqual([cachedModel])
      expect(request.mock.calls.map(([method]) => method)).not.toContain('model/list')
      expect(persist).not.toHaveBeenCalled()
    } finally {
      runtime.close()
    }
  })

  it('restores the previous catalog when persistence rejects', async () => {
    const f = fixture()
    const failure = new Error('disk unavailable')
    f.persist.mockRejectedValue(failure)
    try {
      await expect(f.runtime.refresh()).rejects.toBe(failure)
      expect(f.runtime.models()).toEqual([cachedModel])
    } finally {
      f.runtime.close()
    }
  })

  it('gives the persistence consumer the fresh catalog before its update notification', async () => {
    const f = fixture()
    const observed: unknown[] = []
    f.persist.mockImplementation(async (preferences) => { observed.push(preferences.models) })
    try {
      await f.runtime.refresh()
      expect(observed).toEqual([[{ id: 'fresh-model', name: 'Fresh', description: 'Fresh catalog', efforts: [], serviceTiers: [], inputModalities: ['text', 'image'] }]])
    } finally {
      f.runtime.close()
    }
  })

  it('waits for an in-flight persist during close and rolls the cache back', async () => {
    const f = fixture()
    const persisted = Promise.withResolvers<undefined>()
    f.persist.mockImplementation(async () => persisted.promise)
    const refresh = f.runtime.refresh()
    try {
      await vi.waitFor(() => expect(f.persist).toHaveBeenCalled())
      const closing = f.runtime.close()
      let settled = false
      void closing.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      persisted.resolve(undefined)
      await expect(refresh).rejects.toThrow('closed')
      await closing
      expect(f.runtime.models()).toEqual([cachedModel])
    } finally {
      persisted.resolve(undefined)
      await f.runtime.close()
    }
  })

  it('does not commit a catalog that finishes after disposal', async () => {
    const gate = Promise.withResolvers<unknown>()
    const f = fixture()
    f.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'codex' }
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return gate.promise
      return {}
    })
    const refresh = f.runtime.refresh()
    try {
      await vi.waitFor(() => expect(f.request.mock.calls.map(([method]) => method)).toContain('model/list'))
      f.runtime.close()
      gate.resolve(refreshedCatalog)
      await expect(refresh).rejects.toThrow('closed')
      expect(f.runtime.models()).toEqual([cachedModel])
      expect(f.persist).not.toHaveBeenCalled()
    } finally {
      f.runtime.close()
    }
  })

  it('serializes a disable operation behind an in-flight catalog read', async () => {
    const gate = Promise.withResolvers<unknown>()
    const f = fixture()
    f.request.mockImplementation(async (method: string) => {
      if (method === 'initialize') return { userAgent: 'codex' }
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return gate.promise
      return {}
    })
    try {
      const refresh = f.runtime.refresh()
      await vi.waitFor(() => expect(f.request.mock.calls.map(([method]) => method)).toContain('model/list'))
      const disable = f.runtime.configure(false)
      await Promise.resolve()
      expect(f.runtime.view().enabled).toBe(true)
      gate.resolve(refreshedCatalog)
      await refresh
      await disable
      expect(f.runtime.view().enabled).toBe(false)
      expect(f.runtime.models()).toEqual([{ id: 'fresh-model', name: 'Fresh', description: 'Fresh catalog', efforts: [], serviceTiers: [], inputModalities: ['text', 'image'] }])
    } finally {
      f.runtime.close()
    }
  })

  it('pauses periodic refresh before an account logout request', async () => {
    vi.useFakeTimers()
    const f = fixture({ interval: 10_000 })
    await f.runtime.refresh()
    f.runtime.startAutomaticRefresh()
    try {
      await vi.advanceTimersByTimeAsync(0)
      await vi.waitFor(() => expect(f.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(2))
      const beforeLogout = f.request.mock.calls.filter(([method]) => method === 'model/list').length
      const logoutRequest = Promise.withResolvers<unknown>()
      f.request.mockImplementation(async (method: string) => {
        if (method === 'account/logout') return logoutRequest.promise
        if (method === 'account/read') return { account: { type: 'chatgpt' } }
        if (method === 'model/list') return refreshedCatalog
        return {}
      })
      const logout = f.runtime.logout()
      await vi.waitFor(() => expect(f.request.mock.calls.map(([method]) => method)).toContain('account/logout'))
      await vi.advanceTimersByTimeAsync(100)
      expect(f.request.mock.calls.filter(([method]) => method === 'model/list')).toHaveLength(beforeLogout)
      logoutRequest.resolve({})
      await logout
      expect(f.runtime.view().enabled).toBe(false)
    } finally {
      await f.runtime.close()
      vi.useRealTimers()
    }
  })

  it('refuses a manual refresh while logout is in progress', async () => {
    const f = fixture()
    const logoutRequest = Promise.withResolvers<unknown>()
    await f.runtime.refresh()
    f.request.mockImplementation(async (method: string) => {
      if (method === 'account/logout') return logoutRequest.promise
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return refreshedCatalog
      return {}
    })
    try {
      const logout = f.runtime.logout()
      void logout.catch(() => {})
      await vi.waitFor(() => expect(f.request.mock.calls.map(([method]) => method)).toContain('account/logout'))
      await expect(f.runtime.refresh()).rejects.toThrow('disconnect')
      await expect(f.runtime.publish()).rejects.toThrow('disconnect')
      await expect(f.runtime.configure(true)).rejects.toThrow('disconnect')
      await expect(f.runtime.login(true)).rejects.toThrow('disconnect')
      await expect(f.runtime.stream({ provider: 'codex-backend', model: 'fresh-model', messages: [] }).next()).rejects.toThrow('disconnect')
      logoutRequest.resolve({})
      await logout
      expect(f.runtime.view().enabled).toBe(false)
    } finally {
      logoutRequest.resolve({})
      await f.runtime.close()
    }
  })

  it('does not disconnect while a settings write is in progress', async () => {
    const f = fixture()
    await f.runtime.refresh()
    const write = Promise.withResolvers<undefined>()
    f.persist.mockClear()
    f.persist.mockImplementation(async () => write.promise)
    try {
      const configure = f.runtime.configure(true)
      await vi.waitFor(() => expect(f.persist).toHaveBeenCalledOnce())
      await expect(f.runtime.logout()).rejects.toThrow('operation')
      write.resolve(undefined)
      await configure
      expect(f.runtime.view()).toMatchObject({ enabled: true, connected: true })
    } finally {
      write.resolve(undefined)
      await f.runtime.close()
    }
  })

  it('preserves the enabled cache on confirmed account loss and notifies the consumer', async () => {
    const notify = vi.fn()
    const f = fixture({ notifyViewChanged: notify })
    await f.runtime.refresh()
    const connectedNotifications = notify.mock.calls.length
    f.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: null }
      return {}
    })
    try {
      await f.runtime.refresh()
      expect(f.runtime.view()).toMatchObject({ enabled: true, connected: false })
      expect(f.runtime.models()).toEqual([{ id: 'fresh-model', name: 'Fresh', description: 'Fresh catalog', efforts: [], serviceTiers: [], inputModalities: ['text', 'image'] }])
      expect(notify.mock.calls.length).toBe(connectedNotifications + 1)
    } finally {
      await f.runtime.close()
    }
  })

  it('preserves account and catalog state when account refresh is unavailable', async () => {
    const notify = vi.fn()
    const f = fixture({ notifyViewChanged: notify })
    await f.runtime.refresh()
    const before = { notifications: notify.mock.calls.length, models: f.runtime.models() }
    f.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') throw new Error('temporary account read failure')
      return {}
    })
    try {
      await expect(f.runtime.refresh()).rejects.toThrow('temporary account read failure')
      expect(f.runtime.view()).toMatchObject({ enabled: true, connected: true })
      expect(f.runtime.models()).toEqual(before.models)
      expect(notify.mock.calls.length).toBe(before.notifications)
    } finally {
      await f.runtime.close()
    }
  })
})
