/** Pinned public fileChange metadata yields task-fit patch facts, never retained diff bodies. */
import { expect, it } from 'vitest'
import { codexNativeItem } from '../src/codex-native-evidence.ts'

const item = { id: 'current-patch', type: 'fileChange', status: 'completed', changes: [
  { path: '/fixture/project/src/a.ts', kind: { type: 'update', move_path: '/fixture/project/src/b.ts' }, diff: 'Authorization: Bearer private-diff-fixture' },
] }
it('retains current project patch operations and safe move targets without diff text', () => {
  const result = codexNativeItem('profile', 'original', 'current', 'settled', item, '/fixture/project', 8)
  expect(result?.patchProcedure).toEqual({ kind: 'patch', changes: [{ operation: 'update', path: 'src/a.ts', movePath: 'src/b.ts' }] })
  expect(result).not.toHaveProperty('procedure')
  expect(result?.outcome).toBe('reported-success')
  expect(JSON.stringify(result)).not.toMatch(/private-diff|Authorization|diff/)
})
it('retains bounded multiple project changes in public observed order', () => {
  const result = codexNativeItem('profile', 'original', 'current', 'started', { ...item, status: 'inProgress', changes: [
    { path: 'src/a.ts', kind: { type: 'add' }, diff: 'body-a' },
    { path: 'src/b.ts', kind: { type: 'delete' }, diff: 'body-b' },
  ] }, '/fixture/project', 2)
  expect(result?.patchProcedure).toEqual({ kind: 'patch', changes: [{ operation: 'add', path: 'src/a.ts' }, { operation: 'delete', path: 'src/b.ts' }] })
  expect(result).not.toHaveProperty('procedure')
  expect(result?.outcome).toBeUndefined()
})
it.each([
  { changes: [{ path: '../outside.ts', kind: { type: 'update' }, diff: '' }] },
  { changes: [{ path: '.env', kind: { type: 'update' }, diff: '' }] },
  { changes: [{ path: 'src/auth.ts', kind: { type: 'update' }, diff: '' }] },
  { changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: '/other/outside.ts' }, diff: '' }] },
  { changes: [{ path: 'src/a.ts', kind: { type: 'delete', move_path: 'src/b.ts' }, diff: '' }] },
  { changes: [{ path: 'src/a.ts', kind: { type: 'unknown' }, diff: '' }] },
  { changes: [{ path: 'src/a.ts', kind: { type: 'add' }, diff: '' }, { path: 'src/a.ts', kind: { type: 'delete' }, diff: '' }] },
])('withholds a concrete procedure for unsafe or conflicting patch metadata %j', ({ changes }) => {
  expect(codexNativeItem('profile', 'original', 'current', 'settled', { ...item, changes }, '/fixture/project', 8)?.patchProcedure).toBeUndefined()
})
it('withholds complete patch facts exceeding the declared change count or lacking the actual project root', () => {
  const changes = ['src/a.ts', 'src/b.ts'].map(path => ({ path, kind: { type: 'update' }, diff: '' }))
  expect(codexNativeItem('profile', 'original', 'current', 'settled', { ...item, changes }, '/fixture/project', 1)?.patchProcedure).toBeUndefined()
  expect(codexNativeItem('profile', 'original', 'current', 'settled', item)?.patchProcedure).toBeUndefined()
})
it.each(['read', 'check'] as const)('preserves the exact existing %s procedure payload without an additive field', (kind) => {
  const command = kind === 'read' ? 'cat src/a.ts' : 'pnpm run test'
  const procedure = kind === 'read' ? { kind: 'read', path: 'src/a.ts' } : { kind: 'check', command }
  const nativeKind = kind === 'read' ? 'read' : 'command'
  const result = codexNativeItem('profile', 'original', 'current', 'settled', {
    id: 'legacy', type: 'commandExecution', source: 'agent', cwd: '/fixture/project', command, status: 'completed', exitCode: 0,
    commandActions: kind === 'read' ? [{ type: 'read', path: 'src/a.ts' }] : [],
  }, '/fixture/project', 8)
  expect(JSON.stringify(result)).toBe(JSON.stringify({ provider: 'codex', connectionId: 'profile', sessionId: 'original',
    turnId: 'current', itemId: 'legacy', kind: nativeKind, name: `native-${nativeKind}`, phase: 'settled',
    outcome: 'reported-success', procedure }))
  expect(result).not.toHaveProperty('patchProcedure')
})
