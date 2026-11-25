import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@yharness/cordis'
import { createScope } from '@yharness/scope'
import {
  createMcpActionCatalog,
  loaderEntryId,
  registerMcpActionCatalogReader,
} from '../src/action-catalog.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function root(): Context {
  const ctx = new Context()
  roots.push(ctx)
  return ctx
}

function setEntry(ctx: Context, id: string): void {
  Object.defineProperty(ctx.fiber, 'entry', { configurable: true, value: { id } })
}

describe('MCP action catalog', () => {
  it('retains exact names, bounds descriptions, and returns isolated snapshots', () => {
    const catalog = createMcpActionCatalog('github', 'profile:github', 'github-app')
    catalog.discovered([
      { name: 'records.read:recent', description: '', enabled: true },
      { name: 'tools with spaces', description: 'x'.repeat(4_097), enabled: false },
    ])
    catalog.setConnected(true)

    const snapshot = catalog.snapshot()
    expect(snapshot).toEqual({
      serverName: 'github',
      entryId: 'profile:github',
      authKind: 'github-app',
      connected: true,
      actions: [
        { name: 'records.read:recent', enabled: true },
        { name: 'tools with spaces', description: 'x'.repeat(4_096), enabled: false },
      ],
    })
    Object.assign(snapshot.actions[0]!, { enabled: false })
    expect(catalog.snapshot().actions[0]!.enabled).toBe(true)
  })

  it('marks the retained discovery stale without inventing a new list', () => {
    const catalog = createMcpActionCatalog('records', 'profile:records')
    catalog.discovered([{ name: 'records.read:recent', enabled: true }])
    catalog.setConnected(true)
    catalog.setConnected(false)
    expect(catalog.snapshot()).toEqual({
      serverName: 'records',
      entryId: 'profile:records',
      connected: false,
      actions: [{ name: 'records.read:recent', enabled: true }],
    })
  })

  it('accepts a catalog reader only for an unscoped loader entry', () => {
    const ctx = root()
    expect(loaderEntryId(ctx)).toBeUndefined()
    setEntry(ctx, '')
    expect(loaderEntryId(ctx)).toBeUndefined()
    setEntry(ctx, 'profile:records')
    expect(loaderEntryId(ctx)).toBe('profile:records')

    const scoped = createScope(ctx, {})
    setEntry(scoped.ctx, 'profile:records:scoped')
    expect(loaderEntryId(scoped.ctx)).toBeUndefined()
  })

  it('emits one current snapshot and skips a missing reader result', () => {
    const ctx = root()
    const catalog = createMcpActionCatalog('records', 'profile:records')
    catalog.discovered([{ name: 'records.read:recent', enabled: true }])
    const seen: string[] = []
    registerMcpActionCatalogReader(ctx, () => catalog.snapshot())
    ctx.emit('mcp/actions/catalog', (current) => { seen.push(current.actions[0]!.name) })
    expect(seen).toEqual(['records.read:recent'])

    const emptyCtx = root()
    registerMcpActionCatalogReader(emptyCtx, () => undefined)
    emptyCtx.emit('mcp/actions/catalog', () => { seen.push('unexpected') })
    expect(seen).toEqual(['records.read:recent'])
  })
})
