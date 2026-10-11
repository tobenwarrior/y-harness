import { describe, expect, it } from 'vitest'
import { codexNativeItem } from '../src/codex-native-evidence.ts'

const observe = (item: unknown) => codexNativeItem('fixture-profile', 'fixture-original', 'fixture-turn', 'settled', item, '/fixture/project', 8)
const command = (fields: Record<string, unknown> = {}) => ({
  id: 'fixture-item', type: 'commandExecution', source: 'agent', cwd: '/fixture/project',
  command: 'pnpm run test', status: 'completed', exitCode: 0, ...fields,
})

describe('native item observations without inferred verification', () => {
  it.each([
    [{ id: 'item', type: 'mcpToolCall', status: 'completed', error: null }, 'mcp', 'reported-success'],
    [{ id: 'item', type: 'mcpToolCall', status: 'completed', error: { message: 'Private fixture result' } }, 'mcp', 'reported-error'],
    [{ id: 'item', type: 'mcpToolCall', status: 'completed' }, 'mcp', 'unknown'],
    [{ id: 'item', type: 'dynamicToolCall', success: true }, 'mcp', 'reported-success'],
    [{ id: 'item', type: 'dynamicToolCall', success: false }, 'mcp', 'reported-error'],
    [{ id: 'item', type: 'dynamicToolCall' }, 'mcp', 'unknown'],
    [{ id: 'item', type: 'webSearch', status: 'completed' }, 'web', 'unknown'],
    [command({ exitCode: 1 }), 'command', 'reported-error'],
    [command({ exitCode: undefined }), 'command', 'unknown'],
    [command({ status: 'declined' }), 'command', 'reported-error'],
    [command({ status: 'failed' }), 'command', 'reported-error'],
  ])('keeps reported outcomes neutral and strips native bodies: %j', (item, kind, outcome) => {
    const result = observe({ ...item, arguments: 'Private fixture arguments', result: 'Private fixture result' })
    expect(result).toMatchObject({ kind, outcome, phase: 'settled' })
    expect(JSON.stringify(result)).not.toContain('Private fixture')
  })

  it.each([null, [], { id: '', type: 'fileChange' }, { id: 'x'.repeat(257), type: 'fileChange' }, { id: 'item', type: 'unsupported' }])('omits unsupported native identities and items: %j', (item) => {
    expect(observe(item)).toBeUndefined()
  })

  it('requires every source identity to remain bounded', () => {
    const item = { id: 'item', type: 'fileChange' }
    expect(codexNativeItem('', 'original', 'turn', 'settled', item)).toBeUndefined()
    expect(codexNativeItem('profile', '', 'turn', 'settled', item)).toBeUndefined()
    expect(codexNativeItem('profile', 'original', '', 'settled', item)).toBeUndefined()
  })

  it('classifies read-only command actions without promoting them to verified checks', () => {
    const result = observe(command({ command: 'unsupported fixture command', commandActions: [{ type: 'listFiles' }, { type: 'search' }] }))
    expect(result).toMatchObject({ kind: 'read', outcome: 'reported-success' })
    expect(result).not.toHaveProperty('procedure')
    expect(observe(command({ commandActions: [{ type: 'read', path: 'src/a.ts' }, { type: 'unknown' }] }))).toMatchObject({ kind: 'command' })
  })

  it('recognizes a literal shell-wrapped check while withholding nested shell syntax', () => {
    expect(observe(command({ command: "/bin/zsh -lc 'pnpm run test'" }))?.procedure).toEqual({ kind: 'check', command: 'pnpm run test' })
    expect(observe(command({ command: "/bin/zsh -lc 'pnpm run test && publish'" }))?.procedure).toBeUndefined()
    expect(observe(command({ command: 'pnpm run test', cwd: '/fixture/another' }))?.procedure).toBeUndefined()
  })

  it.each([
    { command: 'cat src/a.ts' },
    { command: 'cat src/a.ts', commandActions: [{ type: 'read', path: 'src/b.ts' }] },
    { command: 'cat src/a.ts', commandActions: [{ type: 'read', path: 1 }] },
    { command: 'cat src/a.ts', commandActions: [{ type: 'read', path: 'src/a.ts' }, { type: 'read', path: 'src/b.ts' }] },
    { command: 'cat .hidden/a.ts', commandActions: [{ type: 'read', path: '.hidden/a.ts' }] },
    { command: 'cat src/token.ts', commandActions: [{ type: 'read', path: 'src/token.ts' }] },
    { command: 'x'.repeat(257) }, { command: 'pnpm run test\n' },
  ])('withholds reusable read/check facts for ambiguous commands: %j', (fields) => {
    expect(observe(command(fields))?.procedure).toBeUndefined()
  })

  it('keeps a bounded explicit SKILL read path without claiming usage or retaining its contents', () => {
    const result = observe(command({ command: 'cat skills/SKILL.md', commandActions: [{ type: 'read', path: '/fixture/project/skills/SKILL.md' }] }))
    expect(result).toMatchObject({ kind: 'read', skillReadPath: '/fixture/project/skills/SKILL.md' })
    expect(observe(command({ commandActions: [{ type: 'read', path: `/${'x'.repeat(1024)}/SKILL.md` }] }))).not.toHaveProperty('skillReadPath')
    expect(observe(command({ commandActions: [{ type: 'read', path: 'src/a.ts' }] }))).not.toHaveProperty('skillReadPath')
  })
})
