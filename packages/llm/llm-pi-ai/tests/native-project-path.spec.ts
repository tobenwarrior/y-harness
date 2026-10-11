/** Native metadata remains lexical evidence, never file access authority. */
import { expect, it } from 'vitest'
import { codexNativeItem } from '../src/codex-native-evidence.ts'

it.each([
  ['src/source.ts', 'src/source.ts'],
  ['/project/src/source.ts', 'src/source.ts'],
  ['src/../notes/guide.md', 'notes/guide.md'],
  ['../outside.ts', undefined],
  ['/project-sibling/source.ts', undefined],
  ['src/.hidden.ts', undefined],
  ['.cache/source.ts', undefined],
  ['src/credential.json', undefined],
  ['src/PASSWORD.md', undefined],
  ['auth/source.ts', undefined],
  ['src/image.png', undefined],
] as const)('admits only normalized source read paths: %s', (path, expected) => {
  const item = codexNativeItem('profile', 'thread', 'turn', 'started', {
    id: 'read', type: 'commandExecution', source: 'agent', cwd: '/project', command: `cat ${path}`,
    commandActions: [{ type: 'read', path }],
  }, '/project')
  expect(item?.procedure).toEqual(expected === undefined ? undefined : { kind: 'read', path: expected })
})

it('bounds normalized patch paths and retains no secret diff body', () => {
  const path = `src/${'a'.repeat(249)}.ts`
  for (const [candidate, expected] of [[path, path], [`${path}x.ts`, undefined]] as const) {
    const item = codexNativeItem('profile', 'thread', 'turn', 'settled', {
      id: 'change', type: 'fileChange', status: 'completed',
      changes: [{ path: candidate, kind: { type: 'update' }, diff: 'SECRET_DIFF_BODY' }],
    }, '/project', 1)
    expect(item?.patchProcedure).toEqual(expected === undefined ? undefined : {
      kind: 'patch', changes: [{ operation: 'update', path: expected }],
    })
    expect(JSON.stringify(item)).not.toContain('SECRET_DIFF_BODY')
  }
})
