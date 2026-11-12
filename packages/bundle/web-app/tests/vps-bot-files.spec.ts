import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import type { FsTarget, FsVersion } from '@yharness/fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsBotFileSystem } from '../src/vps-bot-files.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

interface ExecOptions {
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly maxBuffer?: number
}

interface ExecResult {
  readonly stdout: string
  readonly stderr: string
}

interface ExecCall {
  readonly program: string
  readonly argv: readonly string[]
  readonly options: ExecOptions
  input: string
}

interface ExecChild {
  readonly stdin: {
    on: (event: string, listener: (error: Error) => void) => ExecChild['stdin']
    end: (data?: string | Uint8Array) => void
  }
}

type ExecPromise = Promise<ExecResult> & { child: ExecChild }
type ExecHandler = (call: ExecCall) => ExecResult | Promise<ExecResult>

const execState = vi.hoisted(() => {
  const calls: ExecCall[] = []
  let handler: ExecHandler = () => ({ stdout: '', stderr: '' })
  const execFileMock = vi.fn()
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: (program: string, argv: readonly string[], options: ExecOptions): ExecPromise => {
      const call: ExecCall = { program, argv: [...argv], options, input: '' }
      calls.push(call)
      let onAbort: (() => void) | undefined
      let settled = false
      let stdinError: ((error: Error) => void) | undefined
      const stdin = {
        on: (_event: string, listener: (error: Error) => void) => {
          stdinError = listener
          return stdin
        },
        end: (data?: string | Uint8Array) => {
          if (data !== undefined) call.input += typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
          stdinError?.(new Error('fixture stdin closed'))
        },
      }
      const child: ExecChild = { stdin }
      const promise = new Promise<ExecResult>((resolve, reject) => {
        const finish = (complete: () => void): void => {
          if (settled) return
          settled = true
          if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort)
          complete()
        }
        onAbort = () => {
          finish(() => { reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) })
        }
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener('abort', onAbort, { once: true })
        void Promise.resolve().then(() => handler(call)).then(
          (result) => {
            finish(() => { resolve(result) })
          },
          (error: unknown) => {
            const reason = error instanceof Error ? error : new Error(String(error))
            finish(() => { reject(reason) })
          },
        )
      }) as ExecPromise
      promise.child = child
      return promise
    },
  })
  return {
    calls,
    execFileMock,
    setHandler(next: ExecHandler): void { handler = next },
    reset(): void {
      calls.length = 0
      handler = () => ({ stdout: '', stderr: '' })
      execFileMock.mockReset()
    },
  }
})

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execState.execFileMock,
}))

type EntryType = 'file' | 'directory' | 'other' | 'symlink'

interface WorkerEntry {
  type: EntryType
  version: string
  bytes: Uint8Array
}

interface WorkerRequest {
  operation: string
  path: string
  content?: string
  expected?: { kind: string; version?: string }
  destination?: string
  destinationExpected?: { kind: string; version?: string }
  offset?: number
  limit?: number
  whole?: boolean
}

interface WorkerState {
  readonly root: string
  readonly entries: Map<string, WorkerEntry>
  nextVersion: number
  keepMoveSource: boolean
  deleteWithoutBasis: boolean
  moveSourceBeforeNull: boolean
}

const sessionId = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  execState.reset()
  vi.restoreAllMocks()
})

function stdout(value: object): ExecResult {
  return { stdout: JSON.stringify(value), stderr: '' }
}

function failure(error: string, message = error): ExecResult {
  return stdout({ error, message })
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function metadata(entry: WorkerEntry): { type: EntryType; version: string; size: number } {
  return { type: entry.type, version: entry.version, size: entry.bytes.byteLength }
}

function textBefore(entry: WorkerEntry | undefined): string | null {
  if (entry === undefined) return null
  return new TextDecoder().decode(entry.bytes)
}

function installWorker(state: WorkerState): void {
  execState.setHandler(async (call) => {
    const request = JSON.parse(call.input) as WorkerRequest
    if (request.operation === 'resolve') {
      if (request.path !== state.root && !request.path.startsWith(`${state.root}/`)) return failure('FS_SANDBOX_DENIED', 'outside the Bot workspace')
      return stdout({ value: request.path })
    }
    if (request.operation === 'stat' || request.operation === 'lstat') {
      const entry = state.entries.get(request.path)
      return stdout({ value: entry === undefined ? null : metadata(entry) })
    }
    if (request.operation === 'read') {
      const entry = state.entries.get(request.path)
      if (entry === undefined) return failure('FS_NOT_FOUND')
      const offset = request.offset ?? 0
      const limit = request.limit ?? entry.bytes.byteLength
      if (request.whole === true && entry.bytes.byteLength > limit) return failure('FS_TOO_LARGE')
      const bytes = request.whole === true ? entry.bytes : entry.bytes.slice(offset, offset + limit)
      return stdout({ value: Buffer.from(bytes).toString('base64') })
    }
    if (request.operation === 'list') {
      const prefix = request.path.endsWith('/') ? request.path : `${request.path}/`
      const values = [...state.entries.entries()]
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map(([path, entry]) => ({ ...metadata(entry), name: path.slice(prefix.length), path }))
      return stdout({ value: values })
    }
    if (request.operation === 'write') {
      const existing = state.entries.get(request.path)
      if (request.expected?.kind === 'createIfAbsent' && existing !== undefined) return failure('FS_NOT_OBSERVED')
      if (request.expected?.kind === 'replaceIfVersion'
        && (existing === undefined || existing.version !== request.expected.version)) return failure('FS_STALE_VERSION')
      const next: WorkerEntry = { type: 'file', version: `v${++state.nextVersion}`, bytes: textBytes(request.content ?? '') }
      state.entries.set(request.path, next)
      return stdout({ value: { entry: metadata(next), before: textBefore(existing), created: existing === undefined } })
    }
    if (request.operation === 'delete') {
      const existing = state.entries.get(request.path)
      if (existing === undefined) {
        if (state.deleteWithoutBasis) return stdout({ value: { before: null } })
        return failure('FS_STALE_VERSION')
      }
      state.entries.delete(request.path)
      return stdout({ value: { before: state.deleteWithoutBasis ? null : textBefore(existing) } })
    }
    if (request.operation === 'move') {
      const source = state.entries.get(request.path)
      if (source === undefined) return failure('FS_STALE_VERSION')
      if (request.expected?.kind === 'replaceIfVersion' && request.expected.version !== source.version) return failure('FS_STALE_VERSION')
      const existingDestination = state.entries.get(request.destination ?? '')
      if (request.destinationExpected?.kind === 'createIfAbsent' && existingDestination !== undefined) return failure('FS_NOT_OBSERVED')
      const next: WorkerEntry = {
        type: 'file',
        version: `v${++state.nextVersion}`,
        bytes: textBytes(request.content ?? new TextDecoder().decode(source.bytes)),
      }
      state.entries.set(request.destination ?? '', next)
      if (!state.keepMoveSource) state.entries.delete(request.path)
      return stdout({
        value: {
          entry: metadata(next),
          before: textBefore(existingDestination),
          created: existingDestination === undefined,
          sourceBefore: state.moveSourceBeforeNull ? null : textBefore(source),
          sourceDeleted: !state.keepMoveSource,
        },
      })
    }
    throw new Error(`Unhandled worker operation: ${request.operation}`)
  })
}

async function fixture(initial: ReadonlyArray<[string, WorkerEntry]> = []) {
  const hostRoot = await mkdtemp(join(tmpdir(), 'yh-bot-files-'))
  roots.push(hostRoot)
  const runtime = new VpsRuntime(hostRoot, 'localhost/test')
  const root = runtime.workspace(sessionId)
  vi.spyOn(runtime, 'ensure').mockResolvedValue()
  const execArgv = vi.spyOn(runtime, 'execArgv')
  const ctx = new Context()
  contexts.push(ctx)
  const state: WorkerState = {
    root, entries: new Map(initial), nextVersion: 0, keepMoveSource: false,
    deleteWithoutBasis: false, moveSourceBeforeNull: false,
  }
  installWorker(state)
  return { root, runtime, execArgv, fs: new VpsBotFileSystem(ctx, runtime, sessionId), state, ctx }
}

function file(version: string, content: string, type: EntryType = 'file'): WorkerEntry {
  return { type, version, bytes: textBytes(content) }
}

function hunk(oldLines: string[], newLines: string[], context?: string): {
  lineNumber: number
  context?: string
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
} {
  return { lineNumber: 1, ...(context === undefined ? {} : { context }), oldLines, newLines, isEndOfFile: false }
}

describe('VPS Bot file provider', () => {
  it('uses its computer for guarded writes, edits, reads and moves', async () => {
    const f = await fixture()
    const rootTarget = await f.fs.resolve('.')
    const first = await f.fs.resolve('notes.txt')
    expect(rootTarget.displayPath).toBe('.')
    expect(first.displayPath).toBe('notes.txt')
    expect(f.execArgv).toHaveBeenCalledWith(sessionId, [
      '/usr/bin/python3', '-I', '/usr/local/lib/yharness/files.py', f.root,
    ], { stdin: true })
    expect(execState.calls[0]?.program).toBe('/usr/bin/env')
    expect(execState.calls[0]?.argv).toContain(f.root)

    const created = await f.fs.writeText(first, 'Hello\r\nWorld\r\n', { kind: 'createIfAbsent' })
    expect(created).toMatchObject({ operation: 'create', before: null, after: 'Hello\nWorld\n' })
    const edited = await f.fs.editText(first, { oldString: 'World', newString: '$&', replaceAll: true }, { version: created.version })
    expect(edited).toMatchObject({ before: 'Hello\nWorld\n', after: 'Hello\n$&\n' })
    await expect(f.fs.writeText(first, 'stale', { kind: 'replaceIfVersion', version: created.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

    const second = await f.fs.resolve('new/notes.txt')
    await expect(f.fs.moveFile(first, second, { expectedDestination: { kind: 'createIfAbsent' } })).resolves.toMatchObject({
      sourceDeleted: true,
      destination: { operation: 'create', after: 'Hello\n$&\n' },
    })
    await expect(f.fs.readText(second)).resolves.toBe('Hello\r\n$&\r\n')
    await expect(f.fs.stat(first)).resolves.toBeUndefined()
    await expect(f.fs.resolve('../outside')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('keeps target identity, URI and containment in the VPS execution world', async () => {
    const f = await fixture()
    const root = await f.fs.resolve('.')
    const child = await f.fs.resolve('dir/file.txt')
    const sibling = { targetKey: '/outside', displayPath: '../outside' } as FsTarget
    expect(f.fs.processPath(root)).toBe(f.root)
    expect(f.fs.fileUrl(child)).toBe(`file://${f.root}/dir/file.txt`)
    expect(f.fs.contains(root, root)).toBe(true)
    expect(f.fs.contains(root, child)).toBe(true)
    expect(f.fs.contains(child, root)).toBe(false)
    expect(f.fs.contains(root, sibling)).toBe(false)
  })

  it('maps stat, lstat and directory results without exposing symlink identity', async () => {
    const f = await fixture()
    f.state.entries.set(join(f.root, 'dir'), file('v1', '', 'directory'))
    f.state.entries.set(join(f.root, 'link'), file('v2', '', 'symlink'))
    f.state.entries.set(join(f.root, 'plain.txt'), file('v3', 'ok'))
    const link = await f.fs.resolve('link')
    expect(await f.fs.stat(link)).toMatchObject({ type: 'other', version: 'v2' })
    expect(await f.fs.lstat('link')).toMatchObject({ type: 'symlink', version: 'v2' })
    expect(await f.fs.lstat('missing')).toBeUndefined()
    const entries = await f.fs.listDir(await f.fs.resolve('.'))
    expect(entries.some(entry => entry.name === 'link' && entry.type === 'other' && entry.target.displayPath === 'link')).toBe(true)
    expect(entries.some(entry => entry.name === 'plain.txt' && entry.type === 'file' && entry.target.displayPath === 'plain.txt')).toBe(true)
    expect(entries.some(entry => entry.name === 'dir' && entry.type === 'directory')).toBe(true)
  })

  it('reads byte windows and streams UTF-8 across worker chunks', async () => {
    const content = `${'a'.repeat(256 * 1024)}tail`
    const f = await fixture()
    f.state.entries.set(join(f.root, 'large.txt'), file('v1', content))
    const target = await f.fs.resolve('large.txt')
    await expect(f.fs.readByteRange(target, { offset: 256 * 1024, length: 4 })).resolves.toEqual(Buffer.from('tail'))
    await expect(f.fs.readBytes(target, undefined, 4)).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    let streamed = ''
    for await (const chunk of await f.fs.streamText(target)) streamed += chunk
    expect(streamed).toBe(content)
    const empty = await f.fs.resolve('empty.txt')
    f.state.entries.set(String(empty.targetKey), file('v2', ''))
    let emptyStream = ''
    for await (const chunk of await f.fs.streamText(empty)) emptyStream += chunk
    expect(emptyStream).toBe('')
  })

  it('flushes the decoder tail after the worker ends a stream', async () => {
    const f = await fixture()
    const target = await f.fs.resolve('tail.txt')
    f.state.entries.set(String(target.targetKey), file('v1', 'one'))
    const RealDecoder = TextDecoder
    class TailDecoder {
      private readonly decoder: TextDecoder

      constructor(label?: string, options?: TextDecoderOptions) {
        this.decoder = new RealDecoder(label, options)
      }

      decode(input?: AllowSharedBufferSource, options?: TextDecoderOptions): string {
        if (input === undefined) return 'fixture tail'
        return this.decoder.decode(input, options)
      }
    }
    vi.stubGlobal('TextDecoder', TailDecoder)
    try {
      let streamed = ''
      for await (const chunk of await f.fs.streamText(target)) streamed += chunk
      expect(streamed).toBe('onefixture tail')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects binary and malformed text from whole and streaming reads', async () => {
    const f = await fixture()
    const binary = await f.fs.resolve('binary')
    const malformed = await f.fs.resolve('malformed')
    f.state.entries.set(String(binary.targetKey), { type: 'file', version: 'v1', bytes: Uint8Array.from([0, 1, 2]) })
    f.state.entries.set(String(malformed.targetKey), { type: 'file', version: 'v2', bytes: Uint8Array.from([0xc3, 0x28]) })
    await expect(f.fs.readText(binary)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect(f.fs.readText(malformed)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect((async () => {
      for await (const _chunk of await f.fs.streamText(binary)) { /* consume */ }
    })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
    await expect((async () => {
      for await (const _chunk of await f.fs.streamText(malformed)) { /* consume */ }
    })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
  })

  it('applies literal edits and patches, including their safe failures', async () => {
    const f = await fixture()
    const target = await f.fs.resolve('notes.txt')
    await f.fs.writeText(target, 'same same\n')
    await expect(f.fs.editText(target, { oldString: 'missing', newString: 'x', replaceAll: false })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(f.fs.editText(target, { oldString: '', newString: 'x', replaceAll: false })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
    await expect(f.fs.editText(target, { oldString: 'same', newString: 'x', replaceAll: false })).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
    await expect(f.fs.editText(target, { oldString: 'same', newString: 'x', replaceAll: true })).resolves.toMatchObject({ after: 'x x\n' })
    const unique = await f.fs.resolve('unique.txt')
    await f.fs.writeText(unique, 'one\n')
    await expect(f.fs.editText(unique, { oldString: 'one', newString: 'two', replaceAll: false })).resolves.toMatchObject({ after: 'two\n' })

    const patched = await f.fs.patchText(target, [hunk(['x x'], ['patched'])])
    expect(patched).toMatchObject({ before: 'x x\n', after: 'patched\n' })
    await expect(f.fs.patchText(target, [hunk(['not present'], ['nope'])])).rejects.toMatchObject({ code: 'FS_PATCH_MISMATCH' })
  })

  it('enforces mutation policy and reports delete and retained-source outcomes', async () => {
    const f = await fixture()
    const target = await f.fs.resolve('notes.txt')
    await expect(f.fs.writeText(target, 'blocked', undefined, undefined, { mode: 'read-only' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(f.fs.writeText(target, 'x'.repeat(8 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await expect(f.fs.editText(target, { oldString: 'a', newString: 'b', replaceAll: false }, undefined, undefined, { mode: 'read-only' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(f.fs.patchText(target, [], undefined, undefined, { mode: 'read-only' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(f.fs.deleteFile(target, undefined, undefined, { mode: 'read-only' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await f.fs.writeText(target, 'remove me')
    await expect(f.fs.deleteFile(target)).resolves.toEqual({ before: 'remove me' })
    await expect(f.fs.deleteFile(target)).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    f.state.deleteWithoutBasis = true
    await expect(f.fs.deleteFile(target)).resolves.toEqual({ before: null })

    await f.fs.writeText(target, 'keep source')
    const destination = await f.fs.resolve('destination.txt')
    f.state.keepMoveSource = true
    f.state.moveSourceBeforeNull = true
    await expect(f.fs.moveFile(target, destination, { expectedDestination: { kind: 'createIfAbsent' } })).resolves.toMatchObject({
      sourceDeleted: false,
      sourceBefore: null,
      sourceFailure: { code: 'FS_IO_ERROR' },
    })
  })

  it('moves with a patch and rejects same or stale sources', async () => {
    const f = await fixture()
    const source = await f.fs.resolve('source.txt')
    const destination = await f.fs.resolve('destination.txt')
    await f.fs.writeText(source, 'one\r\ntwo\r\n')
    await expect(f.fs.moveFile(source, source, { expectedDestination: { kind: 'createIfAbsent' } })).rejects.toMatchObject({ code: 'FS_SAME_TARGET' })
    await expect(f.fs.moveFile(source, destination, { expectedSource: { version: 'stale' as FsVersion }, expectedDestination: { kind: 'createIfAbsent' } })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    const moved = await f.fs.moveFile(source, destination, {
      expectedDestination: { kind: 'createIfAbsent' },
      hunks: [hunk(['one', 'two'], ['one', 'three'])],
    })
    expect(moved).toMatchObject({ sourceDeleted: true, destination: { operation: 'create', after: 'one\nthree\n' } })
    expect(f.state.entries.get(String(destination.targetKey))?.bytes).toEqual(textBytes('one\r\nthree\r\n'))
  })

  it('returns safe I/O errors for malformed workers and preserves abort state', async () => {
    const f = await fixture()
    const target = await f.fs.resolve('broken.txt')
    execState.setHandler(() => ({ stdout: '{', stderr: 'secret host path' }))
    await expect(f.fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR', message: 'The VPS Bot file operation could not complete.' })
    execState.setHandler(() => { throw new Error('host secret') })
    await expect(f.fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    execState.setHandler(() => stdout({ value: { wrong: true } }))
    await expect(f.fs.stat(target)).rejects.toMatchObject({ code: 'FS_IO_ERROR' })

    const abort = new AbortController()
    const ensure = vi.spyOn(f.runtime, 'ensure')
    ensure.mockClear()
    abort.abort(new Error('caller closed'))
    await expect(f.fs.readText(target, abort.signal)).rejects.toThrow('caller closed')
    expect(ensure).not.toHaveBeenCalled()

    const afterEnsureAbort = new AbortController()
    ensure.mockImplementation(async () => { afterEnsureAbort.abort(new Error('closed during ensure')) })
    execState.calls.length = 0
    await expect(f.fs.readText(target, afterEnsureAbort.signal)).rejects.toThrow('closed during ensure')
    expect(execState.calls).toHaveLength(0)
  })

  it('aborts an in-flight worker and waits for its owned promise to settle', async () => {
    const f = await fixture()
    const target = await f.fs.resolve('slow.txt')
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    execState.setHandler(async () => {
      await blocked
      return stdout({ value: Buffer.from('done').toString('base64') })
    })
    const abort = new AbortController()
    const read = f.fs.readText(target, abort.signal)
    await Promise.resolve()
    abort.abort(new Error('request cancelled'))
    await expect(read).rejects.toThrow('request cancelled')
    release?.()
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  })
})
