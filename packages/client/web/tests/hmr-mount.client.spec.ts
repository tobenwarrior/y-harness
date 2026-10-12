// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleLoaderTarget, WebBootEntry, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import * as rendererClient from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as uiSessionClient from '@deepseek-ai/dsh-client-ui-session/client'
import type { ComposedProps } from '@deepseek-ai/dsh-client-ui-slots'
import { ClientSessions } from '../../../api/session-controller/src/client/sessions/service.ts'
import type { SessionRemotes } from '../../../api/session-controller/src/client/sessions/remotes.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { bootClient } from '../src/boot-client.ts'
import { mountClient } from '../src/mount.ts'

const BOOTSTRAP = '@deepseek-ai/dsh-client-modules'
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer'
const SESSIONS = 'hmr-sessions'
const REMOTE = 'hmr-remotes'
const UI_SESSION = '@deepseek-ai/dsh-client-ui-session'
const APP = 'hmr-app'
const EXTRA = 'hmr-extra'
const STABLE = 'hmr-stable'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'hmr.leaves': { kind: 'list'; scope: 'root' }
  }
}
const PROBE = SessionId('hmr-cleanup-probe')

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function teardownGate() {
  return { started: deferred(), release: deferred() }
}

function row(id: string, rev = 'r0'): WebBootEntry {
  return { id, rev, url: `/plugins/??${id}/client.js&rev=${rev}` }
}

function graph(...entries: WebBootEntry[]): WebBootGraph {
  return {
    rev: JSON.stringify(entries), entries,
    batches: [{ phase: 'application', url: '/hmr-batch', rev: 'initial', entries: entries.map(entry => entry.id) }],
  }
}

function rootFace(sessions: ClientSessions, revision: string, events: string[], errors: string[]) {
  const probe = (): void => {
    const reference = sessions.retainAgentScope(PROBE)
    reference.release()
  }
  return {
    revision,
    hooks: { catalog: sessions.list },
    probe,
    mounted: () => { events.push(`react mount ${revision}`) },
    cleanup: () => {
      try {
        probe()
        events.push(`react cleanup ${revision}`)
      } catch (error) {
        errors.push(String(error))
      }
    },
  }
}

type RootProps = ComposedProps<'root', string, never, undefined, ReturnType<typeof rootFace>>

function Application(props: RootProps) {
  const count = props.useCatalog(snapshot => snapshot.ids.length)
  useEffect(() => {
    props.mounted()
    return props.cleanup
  }, [props.cleanup, props.mounted])
  return createElement('main', { 'data-hmr-app': props.revision },
    `Application ${props.revision}; sessions: ${String(count)}`,
    createElement('button', { 'data-hmr-probe': '', onClick: props.probe }, 'Read live sessions'),
  )
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

/** Real Loader/module reconciliation and renderer; only bundle delivery and Host RPCs are test-owned. */
async function bench() {
  const ctx = new Context()
  const container = document.createElement('div')
  document.body.append(container)
  const originalDocument = container.ownerDocument
  const events: string[] = []
  const errors: string[] = []
  const gates: ReturnType<typeof teardownGate>[] = []
  let appGate: ReturnType<typeof teardownGate> | undefined
  let sessionsGate: ReturnType<typeof teardownGate> | undefined
  let appRevision = 'r0'
  let sessionGeneration = 0
  let failApplication = false
  const uncaught = (event: ErrorEvent): void => {
    errors.push(event.error instanceof Error ? event.error.message : event.message)
    event.preventDefault()
  }
  window.addEventListener('error', uncaught)
  // React's diagnostic log is preserved in `errors` through the browser error event.
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const remote = RemoteMock.create()
  const remotes: SessionRemotes = {
    $stream: () => { throw new Error('HMR fixture must not open Host streams') },
    session: remote.remote.session,
    commands: remote.remote.commands,
    subagents: remote.remote.subagents,
  }
  const factories: Record<string, ClientBundleRegistration['factory']> = {
    [RENDERER]: () => rendererClient,
    [UI_SESSION]: () => uiSessionClient,
    [STABLE]: () => ({ apply(scope: Context) { scope.provide('hmrStableService', {}) } }),
    [EXTRA]: () => ({ inject: ['slots', 'hmrStableService'], apply(scope: Context) {
      scope.slots.register({ name: 'hmr.leaves', id: 'extra' }, () => null)
    } }),
    [REMOTE]: () => ({ apply(scope: Context) {
      scope.reflect.provide('remote', { $on: () => () => {} })
    } }),
    [SESSIONS]: () => ({ apply(scope: Context) {
      const generation = ++sessionGeneration
      scope.effect(() => async () => {
        events.push(`sessions dispose ${String(generation)}`)
        const gate = sessionsGate
        sessionsGate = undefined
        gate?.started.resolve()
        await gate?.release.promise
      })
      new ClientSessions(scope, remotes)
    } }),
    [APP]: () => ({ inject: ['slots', 'sessions'], apply(scope: Context) {
      if (failApplication) throw new Error('replacement application failed')
      scope.effect(() => async () => {
        const gate = appGate
        appGate = undefined
        gate?.started.resolve()
        await gate?.release.promise
      })
      const sessions = scope.sessions as ClientSessions
      const revision = appRevision
      scope.slots.register({
        name: 'root', inject: () => rootFace(sessions, revision, events, errors),
        children: { 'hmr.leaves': { kind: 'list', scope: 'root' } },
      }, Application)
    } }),
  }
  const initial = graph(row(BOOTSTRAP), row(RENDERER), row(REMOTE), row(SESSIONS), row(UI_SESSION), row(STABLE), row(APP))
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => modulesClient.createClientModuleSystem(target, { id: BOOTSTRAP, exports: modulesClient }, options),
  }
  const modules = target.create({
    boot: initial, staticModules: {},
    loadBundle: async (url) => {
      const ids = url === '/hmr-batch'
        ? [RENDERER, REMOTE, SESSIONS, UI_SESSION, STABLE, APP]
        : [url.split('??')[1]!.split('/client.js')[0]!]
      for (const id of ids) target.load({ id, factory: factories[id]! })
    },
  })
  cleanups.push(async () => {
    for (const gate of gates) gate.release.resolve()
    await ctx.fiber.dispose()
    await ctx.fiber.await()
    window.removeEventListener('error', uncaught)
    container.remove()
    remote.assertNoUnmatched()
  })
  await bootClient({ ctx, modules, manifest: modules.manifest })
  await mountClient(ctx, container)
  await vi.waitFor(() => { expect(container.querySelector('[data-hmr-app]')?.textContent).toContain('Application r0') })
  return {
    ctx, container, originalDocument, modules, initial, events, errors,
    appRevision: (revision: string) => { appRevision = revision },
    failApplication: (fail: boolean) => { failApplication = fail },
    hold: (id: string) => {
      const gate = teardownGate()
      gates.push(gate)
      if (id === APP) appGate = gate
      else sessionsGate = gate
      return gate
    },
  }
}

describe('assembled client HMR mount', () => {
  it('preserves the mounted application across stable-service leaf creation, replacement and removal', async () => {
    const b = await bench()
    const application = b.container.querySelector('[data-hmr-app]')
    const button = b.container.querySelector<HTMLButtonElement>('[data-hmr-probe]')
    const expanded = graph(...b.initial.entries, row(EXTRA))
    await b.modules.entries.sync(expanded)
    expect(b.container.querySelector('[data-hmr-app]')).toBe(application)
    expect(b.events).toEqual(['react mount r0'])
    await b.modules.entries.reload(EXTRA, 'r1')
    expect(b.container.querySelector('[data-hmr-app]')).toBe(application)
    await b.modules.entries.sync(b.initial)
    expect(b.container.querySelector('[data-hmr-probe]')).toBe(button)
    expect(b.events).toEqual(['react mount r0'])
    button?.click()
    expect(b.errors).toEqual([])
  })
  it('keeps recovery visible while the real root registration is absent during delayed teardown', async () => {
    const b = await bench()
    const gate = b.hold(APP)
    b.appRevision('r1')
    const replacing = b.modules.entries.reload(APP, 'r1')
    try {
      await gate.started.promise
      expect(b.modules.entries.state.getSnapshot().syncing).toBe(true)
      await vi.waitFor(() => { expect(b.container.querySelector('[data-dsh-boot]')).not.toBeNull() })
      expect(b.container.querySelector('[data-hmr-app]')).toBeNull()
      expect(b.errors).toEqual([])
    } finally {
      gate.release.resolve()
      await replacing
    }
    await vi.waitFor(() => { expect(b.container.querySelector('[data-hmr-app="r1"]')).not.toBeNull() })
    expect(b.container.querySelector('[data-dsh-boot]')).toBeNull()
    expect(b.errors).toEqual([])
  })

  it('cleans React effects before live sessions are disposed in a foundational dependency cascade', async () => {
    const b = await bench()
    const gate = b.hold(SESSIONS)
    const replacing = b.modules.entries.reload(SESSIONS, 'r1')
    try {
      await gate.started.promise
      expect(b.events).toEqual(['react mount r0', 'react cleanup r0', 'sessions dispose 1'])
      expect(b.errors).toEqual([])
      expect(b.container.querySelector('[data-hmr-app]')).toBeNull()
      expect(b.container.querySelector('[data-dsh-boot]')).not.toBeNull()
    } finally {
      gate.release.resolve()
      await replacing
    }
    await vi.waitFor(() => { expect(b.events.filter(event => event === 'react mount r0')).toHaveLength(2) })
    b.container.querySelector<HTMLButtonElement>('[data-hmr-probe]')!.click()
    expect(b.errors).toEqual([])
  })

  it('remounts successive successful root replacements in the same document', async () => {
    const b = await bench()
    for (const revision of ['r1', 'r2']) {
      b.appRevision(revision)
      await b.modules.entries.reload(APP, revision)
      await vi.waitFor(() => { expect(b.container.querySelector(`[data-hmr-app="${revision}"]`)).not.toBeNull() })
      expect(b.container.querySelectorAll('[data-hmr-app]')).toHaveLength(1)
      expect(b.container.querySelector('[data-dsh-boot]')).toBeNull()
      expect(b.container.ownerDocument).toBe(b.originalDocument)
      b.container.querySelector<HTMLButtonElement>('[data-hmr-probe]')!.click()
    }
    expect(b.events).toEqual([
      'react mount r0', 'react cleanup r0', 'react mount r1', 'react cleanup r1', 'react mount r2',
    ])
    expect(b.errors).toEqual([])
  })

  it('shows a failed replacement and retries through the static recovery page', async () => {
    const b = await bench()
    b.failApplication(true)
    b.appRevision('r1')
    await expect(b.modules.entries.reload(APP, 'r1')).rejects.toThrow('replacement application failed')
    await vi.waitFor(() => { expect(b.container.querySelector('[data-dsh-boot]')?.textContent).toContain('replacement application failed') })
    expect(b.container.querySelector('[data-hmr-app]')).toBeNull()
    const retry = b.container.querySelector<HTMLButtonElement>('[data-dsh-boot-retry]')
    expect(retry).not.toBeNull()
    expect(retry?.disabled).toBe(false)
    b.failApplication(false)
    retry!.click()
    await vi.waitFor(() => { expect(b.container.querySelector('[data-hmr-app="r1"]')).not.toBeNull() })
    expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
    expect(b.container.querySelector('[data-dsh-boot]')).toBeNull()
    expect(b.errors).toEqual([])
  })
})
