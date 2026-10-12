import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocaleFace, PropsRenderSlots, SlotScopeAdapter, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import * as UiRenderer from '../src/client/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'retirement.leaves': { kind: 'list'; scope: 'root' }
  }
}

const contexts: Context[] = []
const Empty = () => null
const Root = (props: PropsRenderSlots<'retirement.leaves'>) => props.renderSlot('retirement.leaves', {})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
  const rendererFiber = await ctx.plugin(UiRenderer)
  const renderer = ctx.get('uiRenderer')!
  return { ctx, renderer, rendererFiber }
}

async function root(ctx: Context, inject: string[] = ['slots']): Promise<Fiber> {
  return await ctx.plugin({
    inject,
    apply(caller) {
      caller.slots.register({
        name: 'root',
        children: { 'retirement.leaves': { kind: 'list', scope: 'root' } },
      }, Root)
    },
  })
}

async function provider(ctx: Context, name: string, inject: string[] = []): Promise<Fiber> {
  return await ctx.plugin({
    inject,
    apply(caller) { caller.provide(name, {}) },
  })
}

async function leaf(ctx: Context, id: string, inject: string[] = ['slots']): Promise<Fiber> {
  return await ctx.plugin({
    inject,
    apply(caller) { caller.slots.register({ name: 'retirement.leaves', id }, Empty) },
  })
}

function adapter(): SlotScopeAdapter {
  const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
  const source = { getSnapshot: () => absent, subscribe: () => () => {} }
  return { current: source, bindingSource: () => source }
}

describe('UI renderer retirement dependencies', () => {
  it('requires suspension for its own fiber and root owner', async () => {
    const { ctx, renderer, rendererFiber } = await boot()
    const owner = await root(ctx)
    expect(renderer.affectedBy([])).toBe(false)
    expect(renderer.affectedBy([rendererFiber])).toBe(true)
    expect(renderer.affectedBy([owner])).toBe(true)
  })

  it('keeps the root mounted for a service-free leaf and unrelated provider', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const owner = await leaf(ctx, 'plain')
    const unrelated = await provider(ctx, 'retirementUnused')
    expect(renderer.affectedBy([owner])).toBe(false)
    expect(renderer.affectedBy([unrelated])).toBe(false)
  })

  it('keeps a locale-consuming leaf retirement local while detecting locale provider retirement', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const locale = await provider(ctx, 'locale')
    const owner = await leaf(ctx, 'localized', ['slots', 'locale'])
    expect(renderer.affectedBy([owner])).toBe(false)
    expect(renderer.affectedBy([locale])).toBe(true)
  })

  it('uses fiber identity when a callback has multiple instances', async () => {
    const { ctx, renderer } = await boot()
    const apply = (caller: Context, critical: boolean) => {
      if (critical) caller.slots.register({ name: 'root' }, Empty)
    }
    const plugin = { inject: ['slots'], apply }
    const critical = await ctx.plugin(plugin, true)
    const unrelated = await ctx.plugin(plugin, false)
    expect(critical.runtime).toBe(unrelated.runtime)
    expect(renderer.affectedBy([unrelated])).toBe(false)
    expect(renderer.affectedBy([critical])).toBe(true)
    expect(renderer.affectedBy([unrelated, critical])).toBe(true)
  })

  it('requires suspension before a root dependency retires', async () => {
    const { ctx, renderer } = await boot()
    const dependency = await provider(ctx, 'retirementData')
    await root(ctx, ['slots', 'retirementData'])
    expect(renderer.affectedBy([dependency])).toBe(true)
  })

  it('follows transitive providers', async () => {
    const { ctx, renderer } = await boot()
    const upstream = await provider(ctx, 'retirementUpstream')
    await provider(ctx, 'retirementData', ['retirementUpstream'])
    await root(ctx, ['slots', 'retirementData'])
    expect(renderer.affectedBy([upstream])).toBe(true)
  })

  it('follows ownership of plain ctx.plugin children and parent injections', async () => {
    const { ctx, renderer } = await boot()
    const dependency = await provider(ctx, 'retirementData')
    let child: Fiber | undefined
    const parent = await ctx.plugin({
      inject: ['slots', 'retirementData'],
      async apply(caller) { child = await root(caller, []) },
    })
    expect(child?.parent.fiber).toBe(parent)
    expect(renderer.affectedBy([parent])).toBe(true)
    expect(renderer.affectedBy([dependency])).toBe(true)
  })

  it('suspends for a service-dependent leaf cascade', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const dependency = await provider(ctx, 'retirementData')
    const owner = await leaf(ctx, 'dependent', ['slots', 'retirementData'])
    expect(renderer.affectedBy([dependency])).toBe(true)
    expect(renderer.affectedBy([owner])).toBe(false)
  })

  it('conservatively suspends when an ordinary registration owner provides a service', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) {
        caller.provide('retirementLeafService', {})
        caller.slots.register({ name: 'retirement.leaves', id: 'provider' }, Empty)
      },
    })
    expect(renderer.affectedBy([owner])).toBe(true)
  })

  it('includes factory owners in service-dependent cascades', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const dependency = await provider(ctx, 'retirementData')
    let release = () => {}
    await ctx.plugin({
      inject: ['slots', 'retirementData'],
      apply(caller) {
        const slots: { registerFactory(options: object, component: unknown): () => void } = caller.slots
        release = slots.registerFactory({ name: 'retirement.factory', scope: 'root' }, Empty)
      },
    })
    expect(renderer.affectedBy([dependency])).toBe(true)
    release()
    release()
    expect(renderer.affectedBy([dependency])).toBe(false)
  })

  it('keeps the root mounted when a service-free factory retires', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) {
        const slots: { registerFactory(options: object, component: unknown): () => void } = caller.slots
        slots.registerFactory({ name: 'retirement.factory', scope: 'root' }, Empty)
      },
    })
    expect(renderer.affectedBy([owner])).toBe(false)
  })

  it('follows inherited leaf dependencies through a plain child plugin', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const dependency = await provider(ctx, 'retirementData')
    await ctx.plugin({
      inject: ['slots', 'retirementData'],
      async apply(caller) { await leaf(caller, 'inherited', []) },
    })
    expect(renderer.affectedBy([dependency])).toBe(true)
  })

  it('releases cascaded leaf registrations before their plugins retire', async () => {
    const { ctx, renderer } = await boot()
    const frame = await root(ctx)
    const dependency = await provider(ctx, 'retirementData')
    const owner = await leaf(ctx, 'dependent', ['slots', 'retirementData'])
    expect(renderer.affectedBy([dependency])).toBe(true)
    await frame.dispose()
    await root(ctx)
    expect(owner.uid).not.toBeNull()
    expect(renderer.affectedBy([dependency])).toBe(false)
  })

  it('retains an ordinary owner until its last registration releases', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    const dependency = await provider(ctx, 'retirementData')
    let first = () => {}
    let second = () => {}
    await ctx.plugin({
      inject: ['slots', 'retirementData'],
      apply(caller) {
        first = caller.slots.register({ name: 'retirement.leaves', id: 'first' }, Empty)
        second = caller.slots.register({ name: 'retirement.leaves', id: 'second' }, Empty)
      },
    })
    first()
    first()
    expect(renderer.affectedBy([dependency])).toBe(true)
    second()
    expect(renderer.affectedBy([dependency])).toBe(false)
  })

  it('retains root contributions until the last disposer releases the owner', async () => {
    const { ctx, renderer } = await boot()
    let first = () => {}
    let second = () => {}
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) {
        first = caller.slots.provideRoot({ props: { first: true } })
        second = caller.slots.provideRoot({ props: { second: true } })
      },
    })
    expect(renderer.affectedBy([owner])).toBe(true)
    first()
    first()
    expect(renderer.affectedBy([owner])).toBe(true)
    second()
    expect(renderer.affectedBy([owner])).toBe(false)
  })

  it('releases a disposed root registration even while its plugin remains live', async () => {
    const { ctx, renderer } = await boot()
    let release = () => {}
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) { release = caller.slots.register({ name: 'root' }, Empty) },
    })
    expect(renderer.affectedBy([owner])).toBe(true)
    release()
    expect(renderer.affectedBy([owner])).toBe(false)
  })

  it('does not retain owners whose registration or root contribution fails', async () => {
    const { ctx, renderer } = await boot()
    await root(ctx)
    ctx.slots.provideRoot({ props: { occupied: true } })
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) {
        expect(() => caller.slots.register({ name: 'root' }, Empty)).toThrow('already has')
        expect(() => caller.slots.provideRoot({ props: { occupied: true } })).toThrow('duplicate root')
      },
    })
    expect(renderer.affectedBy([owner])).toBe(false)
  })

  it('includes the session adapter and its dependency provider', async () => {
    const { ctx, renderer } = await boot()
    const sessions = await provider(ctx, 'retirementSessions')
    const owner = await ctx.plugin({
      inject: ['slots', 'retirementSessions'],
      apply(caller) { caller.slots.installScope('session', adapter()) },
    })
    expect(renderer.affectedBy([owner])).toBe(true)
    expect(renderer.affectedBy([sessions])).toBe(true)
    await owner.dispose()
    expect(renderer.affectedBy([sessions])).toBe(false)
  })

  it('includes the locale installation owner', async () => {
    const { ctx, renderer } = await boot()
    const face: LocaleFace = {
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
      bind: () => () => '',
    }
    const owner = await ctx.plugin({
      inject: ['slots'],
      apply(caller) { caller.slots.installLocale(face) },
    })
    expect(renderer.affectedBy([owner])).toBe(true)
  })
})
