/** Internal layout and optional SDK paging contracts retain their complete public boundary semantics. */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeClaudeSourcePage, resolveClaudeSourceWorker } from '../src/claude-source-options.ts'
import { claudeSourceRequestSchema } from '../src/claude-source-worker.ts'

const scope = { protocol: 1, operation: 'listSessions', profileRoot: '/fixture/profile', directory: '/fixture/project',
  shellHome: '/fixture/home', sdkModulePath: '/fixture/sdk.mjs', sdkManifestPath: '/fixture/package.json',
  sdkModuleSha256: 'a'.repeat(64), sdkVersion: '0.3.263', maxBytes: 10000, maxEvents: 10 }

describe('Claude source actual module layouts', () => {
  it.each([
    ['coding-session/src/claude-source.ts', 'coding-session/lib/types/claude-source-worker.js'],
    ['coding-session/lib/types/claude-source.js', 'coding-session/lib/types/claude-source-worker.js'],
    ['with space/lib/types/claude-source.js', 'with space/lib/types/claude-source-worker.js'],
  ])('locates the worker beside the applicable real module layout %s', (modulePath, workerPath) => {
    expect(resolveClaudeSourceWorker(pathToFileURL(resolve('/fixture', modulePath)).href)).toBe(resolve('/fixture', workerPath))
  })
})

describe('Claude source optional SDK paging normalization', () => {
  it.each([
    [undefined, { limit: 2, offset: 0 }],
    [{}, { limit: 2, offset: 0 }],
    [{ limit: 3 }, { limit: 3, offset: 0 }],
    [{ offset: 4 }, { limit: 2, offset: 4 }],
    [{ limit: undefined, offset: undefined }, { limit: 2, offset: 0 }],
    [{ limit: 5, offset: 6 }, { limit: 5, offset: 6 }],
  ])('preserves omitted, partial and explicit SDK options %j', (options, expected) => {
    const value = normalizeClaudeSourcePage(2, options)
    expect(value).toEqual(expected)
    expect(claudeSourceRequestSchema.parse({ ...scope, ...value })).toMatchObject(expected)
  })
  it.each([
    { limit: 0 }, { limit: -1 }, { limit: Number.NaN }, { limit: Number.POSITIVE_INFINITY },
    { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { offset: 0.5 },
  ])('retains invalid numeric input %j for the real strict worker schema to reject', (options) => {
    const normalized = normalizeClaudeSourcePage(2, options)
    expect(normalized).toMatchObject(options)
    expect(() => claudeSourceRequestSchema.parse({ ...scope, ...normalized })).toThrow()
  })
})
