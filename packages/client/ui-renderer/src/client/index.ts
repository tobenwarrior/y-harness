/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'
import { SlotRegistry } from './registry.ts'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Mount and retirement checks exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Check whether retiring fibers invalidate renderer infrastructure or live UI service dependencies.
   * Call synchronously before retiring the fibers, while their dependency snapshots remain available.
   * @param retiring - Exact live fiber identities that will be retired.
   * @returns Whether the shell must unmount the React root before retirement.
   */
  affectedBy: (retiring: readonly Fiber[]) => boolean
  /**
   * Mount the assembled application into the supplied element.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An ordinary Slot declaration or entry registration set changed. Factory
     * definitions publish through `subscribeFactory()` instead.
     * @mode emit
     * @param key - mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** UI lifecycle face provided after the renderer activates. */
    uiRenderer: UiRendererService
  }
}

/** Services required before application assembly. */
export const inject: string[] = []

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(app()) })
  return root
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const criticalOwners = new Map<Fiber, { refs: number }>()
  const entryOwners = new Map<Fiber, { refs: number }>()
  const slots = new SlotRegistry(ctx, (caller, critical) => {
    const owners = critical ? criticalOwners : entryOwners
    const owner = caller.fiber
    const record = owners.get(owner) ?? { refs: 0 }
    record.refs += 1
    owners.set(owner, record)
    return () => {
      record.refs -= 1
      if (record.refs === 0) owners.delete(owner)
    }
  })
  slots.install(createSlotRenderer())
  ctx.reflect.provide('uiRenderer', {
    affectedBy: (retiring: readonly Fiber[]): boolean => {
      if (retiring.length === 0) return false
      const targets = new Set(retiring)
      const affected = (owner: Fiber, visited = new Set<Fiber>()): boolean => {
        if (targets.has(owner)) return true
        if (visited.has(owner)) return false
        visited.add(owner)
        // Live registrations normally retain an active dependency snapshot.
        // Missing snapshots cannot establish safe rendering during retirement.
        if (owner.store === undefined) return true
        for (const impl of Object.values(owner.store)) {
          if (affected(impl.fiber, visited)) return true
        }
        return affected(owner.parent.fiber, visited)
      }
      if (affected(ctx.fiber)) return true
      for (const owner of criticalOwners.keys()) {
        if (affected(owner)) return true
      }
      for (const owner of entryOwners.keys()) {
        let current = owner
        const ancestors = new Set<Fiber>()
        while (!ancestors.has(current)) {
          ancestors.add(current)
          if (current.store === undefined) return true
          // A retiring registration can leave its providers active. Only
          // provider retirement requires suspension for an ordinary entry.
          for (const impl of Object.values(current.store)) {
            if (affected(impl.fiber)) return true
          }
          current = current.parent.fiber
        }
      }
      return false
    },
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }))
      return () => { root.unmount() }
    },
  })
}
