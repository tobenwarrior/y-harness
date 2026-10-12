/**
 * Shell-owned React lifetime follows settled client entry activation.
 * @module @deepseek-ai/dsh-client-web/src/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { assertEntriesActive } from './boot-client.ts'
import { BootPage } from './boot-page.ts'

/**
 * Mount the renderer while entries are settled. Exact retirement notifications
 * unmount React before its registrations or service dependencies are disposed.
 * @param ctx - booted root Context.
 * @param container - application mount point.
 * @returns after the dependency fibers are installed.
 */
export async function mountClient(ctx: Context, container: HTMLElement): Promise<void> {
  let rendererMount: ReturnType<Context['inject']> | undefined
  let initialFailure: { error: unknown } | undefined
  const mounted = ctx.inject(['modules'], (scope) => {
    const entries = scope.modules.entries
    let renderer: Context | undefined
    let unmount: (() => void) | undefined
    let page: BootPage | undefined
    let suspended = false
    let disposed = false
    let committed = false

    const stop = (): void => {
      const dispose = unmount
      unmount = undefined
      dispose?.()
    }
    const recoveryPage = (): BootPage => {
      if (page === undefined) page = new BootPage(container)
      return page
    }
    const retry = async (): Promise<void> => {
      try { await entries.retry() } catch (error) {
        if (!disposed) recoveryPage().fail(String(error), retry)
      }
    }
    const update = (): void => {
      if (disposed) return
      const snapshot = entries.state.getSnapshot()
      if (snapshot.syncing) {
        return
      }
      // A failed download before teardown leaves the existing application usable.
      if (unmount !== undefined) return
      if (suspended && snapshot.failures.length > 0) {
        recoveryPage().fail(snapshot.failures.map(failure => `${failure.id}: ${failure.message}`).join('\n'), retry)
        return
      }
      if (renderer === undefined) return
      try {
        if (suspended) {
          assertEntriesActive(ctx, scope.modules)
        }
        renderer.slots.renderSlot('root', {})
        unmount = renderer.uiRenderer.mount(container)
        committed = true
        page = undefined
        suspended = false
      } catch (error) {
        if (!committed && !suspended) {
          initialFailure = { error }
          return
        }
        suspended = true
        recoveryPage().fail(String(error), retry)
      }
    }

    scope.effect(() => {
      const unsubscribe = entries.state.subscribe(update)
      const unsubscribeRetire = entries.beforeRetire((fibers) => {
        if (disposed || renderer === undefined || unmount === undefined) return
        if (!renderer.uiRenderer.affectedBy(fibers)) return
        suspended = true
        stop()
        page?.dispose()
        page = new BootPage(container)
      })
      return () => {
        disposed = true
        unsubscribe()
        unsubscribeRetire()
        stop()
        page?.dispose()
      }
    }, 'web: entry lifetime')
    rendererMount = scope.inject(['uiRenderer', 'slots'], (provided) => {
      provided.effect(() => {
        renderer = provided
        update()
        return () => {
          stop()
          if (renderer === provided) renderer = undefined
        }
      }, 'web: renderer mount')
    })
  })
  await mounted
  await rendererMount
  if (initialFailure !== undefined) throw initialFailure.error
}
