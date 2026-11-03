/** Pure call/result projections for the apply_patch tool. */
import { expect, it } from 'vitest'
import { presentPatchCall, presentPatchResult } from '../src/apply-patch-presentation.ts'
import { MAX_PATCH_WHOLE_FILE_DIFF_BYTES, patchToolValue, renderPatch, patchPresentationMeta, type PatchToolValue } from '../src/apply-patch-output.ts'
import type { PatchExecutionReport, PatchFailure, PatchFailureCode, PatchOperationRecord } from '../src/patch/types.ts'
import { stoppedFromMeta } from '../src/diff.ts'

const patch = (...operations: string[]) => ['*** Begin Patch', ...operations, '*** End Patch'].join('\n')
const add = (path: string, content = 'new') => `*** Add File: ${path}\n+${content}`
const update = (path: string, before = 'old', after = 'new') => `*** Update File: ${path}\n@@\n-${before}\n+${after}`
const remove = (path: string) => `*** Delete File: ${path}`
const move = (source: string, destination: string) => `*** Update File: ${source}\n*** Move to: ${destination}\n@@\n-old\n+new`

it('previews operations and counts move endpoints', () => {
  const text = patch(add('a'), update('b'), remove('c'), move('d', 'e'))
  expect(presentPatchCall(text)).toEqual({
    card: 'diff', title: 'Apply patch (5 files)',
    diffs: [
      { path: 'a', oldText: null, newText: 'new\n' },
      { path: 'b', oldText: 'old', newText: 'new' },
      { path: 'd', oldText: 'old', newText: 'new' },
    ],
    locations: ['a', 'b', 'c', 'd', 'e'].map(path => ({ path })),
  })
  expect(presentPatchCall('invalid')).toBeUndefined()
  const insertion = presentPatchCall(patch('*** Update File: insert.txt\n@@\n+new'))
  expect(insertion?.diffs).toEqual([{ path: 'insert.txt', oldText: null, newText: 'new' }])
})
it('renders stopped results and preserves known diffs', () => {
  const value: PatchToolValue = {
    phase: 'commit', cancelled: false, affectedPaths: [], operations: [
      { index: 0, kind: 'update', path: 'a', patchLine: 2, status: 'failed', code: 'FS_PERMISSION_DENIED', message: 'denied', changes: [] },
      { index: 1, kind: 'add', path: 'b', patchLine: 3, status: 'skipped' },
    ],
  }
  expect(renderPatch(value)).toContain('Patch stopped after 0 of 2 operations.')
  expect(patchPresentationMeta(value)).toEqual({ stopped: true, diffs: [], locations: [], produced: [] })
  const diffs = [{ path: 'a', oldText: 'old', newText: 'new' }]
  expect(presentPatchResult({ isError: false, content: [], meta: { diffs } })).toEqual({ card: 'diff', title: 'Apply patch', diffs })
  expect(presentPatchResult({ isError: false, content: [], meta: { diffs, stopped: true } })).toEqual({ card: 'diff', title: 'Apply patch (stopped)', diffs })
  expect(presentPatchResult({ isError: true, content: [], meta: { diffs } })).toBeUndefined()
  expect(presentPatchResult({ isError: false, content: [], meta: { stopped: false } })).toBeUndefined()
})
it.each([undefined, null, [], 'stopped', {}, { stopped: 'true' }, { stopped: false }])('rejects malformed stopped metadata %j', (meta) => {
  expect(stoppedFromMeta(meta)).toBe(false)
})

it('retains a deletion diff only when the provider returned a bounded basis', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['a'], operations: [
    { index: 0, kind: 'delete', path: 'a', patchLine: 2, status: 'completed', changes: [{ path: 'a', before: 'gone\n', after: null }] },
  ] }
  expect(patchPresentationMeta(value)).toEqual({ stopped: false, diffs: [{ path: 'a', oldText: 'gone\n', newText: '' }], locations: [{ path: 'a' }], produced: [] })
})

it('retains a delete-only location when no bounded before-image exists', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['a'], operations: [
    { index: 0, kind: 'delete', path: 'a', patchLine: 2, status: 'completed', changes: [{ path: 'a', before: null, after: null }] },
  ] }
  expect(patchPresentationMeta(value)).toEqual({ stopped: false, diffs: [], locations: [{ path: 'a' }], produced: [] })
  expect(presentPatchResult({ isError: false, content: [], meta: { diffs: [], locations: [{ path: 'a' }] } })).toEqual({
    card: 'diff', title: 'Apply patch', diffs: [], locations: [{ path: 'a' }],
  })
})

it('keeps whole-file diffs for created files and move destinations', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['created', 'source', 'destination'], operations: [
    { index: 0, kind: 'add', path: 'created', patchLine: 2, status: 'completed', changes: [{ path: 'created', before: null, after: 'fresh\n' }] },
    { index: 1, kind: 'move', path: 'source', destination: 'destination', patchLine: 3, status: 'completed', changes: [
      { path: 'destination', before: null, after: 'moved\n' }, { path: 'source', before: 'old\n', after: null },
    ] },
  ] }
  expect(patchPresentationMeta(value).diffs).toEqual([
    { path: 'created', oldText: null, newText: 'fresh\n' },
    { path: 'destination', oldText: null, newText: 'moved\n' },
    { path: 'source', oldText: 'old\n', newText: '' },
  ])
})

it('keeps oversized created files as locations without persisting their body', () => {
  const after = 'x'.repeat(MAX_PATCH_WHOLE_FILE_DIFF_BYTES + 1)
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['created'], operations: [
    { index: 0, kind: 'add', path: 'created', patchLine: 2, status: 'completed', changes: [{ path: 'created', before: null, after }] },
  ] }
  expect(patchPresentationMeta(value)).toEqual({
    stopped: false, diffs: [], locations: [{ path: 'created' }], produced: [{ path: 'created' }],
  })
})

it('publishes produced locations only for actual non-deletion changes', () => {
  const value: PatchToolValue = { phase: 'commit', cancelled: false, affectedPaths: ['created', 'updated', 'removed', 'destination', 'source'], operations: [
    { index: 0, kind: 'add', path: 'created', patchLine: 2, status: 'completed', changes: [{ path: 'created', before: null, after: 'new' }] },
    { index: 1, kind: 'update', path: 'updated', patchLine: 3, status: 'completed', changes: [{ path: 'updated', before: 'old', after: 'new' }] },
    { index: 2, kind: 'delete', path: 'removed', patchLine: 4, status: 'completed', changes: [{ path: 'removed', before: 'old', after: null }] },
    { index: 3, kind: 'move', path: 'source', destination: 'destination', patchLine: 5, status: 'completed', changes: [
      { path: 'destination', before: null, after: 'new' }, { path: 'source', before: 'old', after: null },
    ] },
    { index: 4, kind: 'move', path: 'partial-source', destination: 'partial-destination', patchLine: 6, status: 'failed', changes: [
      { path: 'partial-destination', before: null, after: 'new' },
    ], code: 'FS_IO_ERROR', message: 'source removal failed' },
    { index: 5, kind: 'add', path: 'transient', patchLine: 7, status: 'completed', changes: [{ path: 'transient', before: null, after: 'new' }] },
    { index: 6, kind: 'update', path: 'transient', patchLine: 8, status: 'completed', changes: [{ path: 'transient', before: 'new', after: 'newer' }] },
    { index: 7, kind: 'delete', path: 'transient', patchLine: 9, status: 'completed', changes: [{ path: 'transient', before: 'newer', after: null }] },
  ] }
  expect(patchPresentationMeta(value).produced).toEqual([
    { path: 'created' }, { path: 'updated' }, { path: 'destination' }, { path: 'partial-destination' },
  ])
})

const operation = (index: number, kind: PatchOperationRecord['kind'], path: string, destination?: string): PatchOperationRecord => ({
  index, kind, path, patchLine: index + 2, ...(destination === undefined ? {} : { destination }),
})
const failure = (code: PatchFailureCode, message = 'failure'): PatchFailure => ({ code, message })

it('renders completed paths, empty patches, and partial move diagnostics', () => {
  const complete: PatchToolValue = {
    phase: 'commit', cancelled: false, affectedPaths: ['a', 'b', 'c', 'd'], operations: [
      { ...operation(0, 'add', 'a'), status: 'completed', changes: [] },
      { ...operation(1, 'update', 'b'), status: 'completed', changes: [{ path: 'b', before: 'old', after: 'new' }] },
      { ...operation(2, 'delete', 'c'), status: 'completed', changes: [] },
      { ...operation(3, 'move', 'd', 'e'), status: 'completed', changes: [] },
    ],
  }
  expect(renderPatch(complete)).toContain('A a')
  expect(renderPatch(complete)).toContain('M b')
  expect(renderPatch(complete)).toContain('D c')
  expect(renderPatch(complete)).toContain('M e')
  expect(patchPresentationMeta(complete).diffs).toEqual([{ path: 'b', oldText: 'old', newText: 'new' }])
  expect(renderPatch({ phase: 'commit', cancelled: false, affectedPaths: [], operations: [] })).toBe('Success. No operations in patch.')

  const stopped: PatchToolValue = {
    phase: 'commit', cancelled: false, affectedPaths: ['a'], operations: [
      { ...operation(0, 'add', 'a'), status: 'completed', changes: [] },
      { ...operation(1, 'update', 'b'), status: 'failed', code: 'FS_IO_ERROR', message: 'failed', changes: [] },
      { ...operation(2, 'move', 'c', 'd'), status: 'unknown', code: 'FS_ABORTED', message: 'unknown' },
      { ...operation(3, 'delete', 'e'), status: 'skipped' },
    ],
  }
  expect(renderPatch(stopped)).toContain('Completed:')
  expect(patchPresentationMeta(stopped)).toEqual({ stopped: true, diffs: [], locations: [{ path: 'a' }], produced: [] })

  const partial: PatchExecutionReport = {
    phase: 'commit', cancelled: false, affectedPaths: ['dest'], outcomes: [{
      status: 'failed', operation: operation(0, 'move', 'source', 'dest'), failure: failure('FS_IO_ERROR', 'source removal failed'),
      changes: [{ path: 'dest', before: 'old', after: 'new' }],
    }],
  }
  expect(renderPatch(patchToolValue(partial))).toContain('destination dest was written; source source remains')

  const mapped = patchToolValue({
    phase: 'commit', cancelled: false, affectedPaths: ['a'], outcomes: [
      { status: 'completed', operation: operation(0, 'add', 'a'), changes: [] },
      { status: 'failed', operation: operation(1, 'update', 'b'), failure: failure('FS_IO_ERROR'), changes: [] },
      { status: 'unknown', operation: operation(2, 'delete', 'c'), failure: failure('FS_ABORTED') },
      { status: 'skipped', operation: operation(3, 'move', 'd', 'e') },
    ],
  })
  expect(mapped.operations[1]).toMatchObject({ status: 'failed', code: 'FS_IO_ERROR', changes: [] })
})

it('preserves syntax, preflight, and first-operation refusal errors', () => {
  expect(() => patchToolValue({ phase: 'syntax', failure: failure('PATCH_SYNTAX', 'bad patch') })).toThrow('bad patch')
  const preflight: PatchExecutionReport = {
    phase: 'preflight', refusals: [
      { operation: operation(0, 'update', 'a'), failure: failure('FS_NOT_FOUND', 'missing') },
      { operation: operation(1, 'delete', 'b'), failure: failure('FS_STALE_VERSION', 'stale') },
    ],
  }
  expect(() => patchToolValue(preflight)).toThrow('2 problems')
  const firstFailed: PatchExecutionReport = {
    phase: 'commit', cancelled: false, affectedPaths: [], outcomes: [
      { status: 'failed', operation: operation(0, 'update', 'a'), failure: failure('FS_PATCH_MISMATCH', 'mismatch'), changes: [] },
      { status: 'skipped', operation: operation(1, 'add', 'b') },
    ],
  }
  expect(() => patchToolValue(firstFailed)).toThrow('Patch rejected before any change')
})
