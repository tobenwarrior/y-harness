/** File operations served inside one Bot's private computer. */

import { execFile } from 'node:child_process'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@yharness/cordis'
import { FS_ERROR_CODES, FileSystem, FsError, FsTargetKey, FsVersion } from '@yharness/fs'
import type { FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsVersion as Version, FsWriteIntent } from '@yharness/fs'
import { applyHunks, type PatchHunk } from '@yharness/fs-patch'
import type { SandboxExecutionPolicy } from '@yharness/sandbox'
import { z } from 'zod'
import type { VpsRuntime } from './vps-runtime.ts'

const exec = promisify(execFile)
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const entry = z.object({ type: z.enum(['file', 'directory', 'other', 'symlink']), version: z.string(), size: z.number().int().nonnegative() })
const outcome = z.object({ entry, before: z.string().nullable(), created: z.boolean() })
const workerFailure = z.object({ error: z.enum(FS_ERROR_CODES), message: z.string() })
const chunkSize = 256 * 1024

function normalize(value: string): string { return value.replaceAll('\r\n', '\n') }

/** Keep host storage paths out of model-visible filesystem diagnostics. */
function displayPath(root: string, target: string): string {
  const relative = posix.relative(root, target)
  return relative === '' ? '.' : relative
}

function decode(bytes: Uint8Array): string {
  try {
    if (bytes.includes(0)) throw new Error('binary')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new FsError('The file is not UTF-8 text.', 'FS_NOT_TEXT', { cause: error })
  }
}

function editContent(before: string, edit: FsEditRequest): string {
  const search = normalize(edit.oldString)
  const first = before.indexOf(search)
  if (first === -1 || search === '') throw new FsError('The text to replace was not found.', 'FS_EDIT_NOT_FOUND')
  if (edit.replaceAll) return before.replaceAll(search, () => normalize(edit.newString))
  if (before.indexOf(search, first + search.length) !== -1) throw new FsError('The text matches more than once.', 'FS_AMBIGUOUS_EDIT')
  return before.slice(0, first) + normalize(edit.newString) + before.slice(first + search.length)
}

function patchContent(before: string, hunks: readonly PatchHunk[]): string {
  const result = applyHunks(before, hunks)
  if (!result.ok) throw new FsError('The patch did not match the file.', 'FS_PATCH_MISMATCH')
  return result.after
}

function writeOutcome(result: z.output<typeof outcome>, after: string) {
  return {
    operation: result.created ? 'create' as const : 'update' as const,
    before: result.before === null ? null : normalize(result.before),
    after: normalize(after),
    version: FsVersion(result.entry.version),
  }
}

/** This provider never resolves a model path against the VPS host filesystem. */
export class VpsBotFileSystem extends FileSystem {
  private readonly root: string

  constructor(ctx: Context, private readonly runtime: VpsRuntime, private readonly sessionId: string) {
    super(ctx)
    this.root = runtime.workspace(sessionId)
  }

  /** @inheritdoc */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const target = await this.call('resolve', posix.resolve(opts?.cwd ?? this.root, path), {}, z.string(), opts?.signal)
    return { targetKey: FsTargetKey(target), displayPath: displayPath(this.root, target) }
  }

  /** @inheritdoc */
  override processPath(target: FsTarget): string { return String(target.targetKey) }

  /** @inheritdoc */
  override fileUrl(target: FsTarget): string { return pathToFileURL(this.processPath(target), { windows: false }).href }

  /** @inheritdoc */
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const relative = posix.relative(this.processPath(parent), this.processPath(child))
    return relative === '' || (!posix.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'))
  }

  /** @inheritdoc */
  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const info = await this.call('stat', this.processPath(target), {}, entry.nullable(), signal)
    if (info === null) return undefined
    return { ...info, type: info.type === 'symlink' ? 'other' : info.type, version: FsVersion(info.version) }
  }

  /** @inheritdoc */
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const info = await this.call('lstat', posix.resolve(opts?.cwd ?? this.root, path), {}, entry.nullable(), signal)
    return info === null ? undefined : { ...info, version: FsVersion(info.version) }
  }

  /** @inheritdoc */
  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return decode(await this.readBytes(target, signal, MAX_TEXT_BYTES))
  }

  /** @inheritdoc */
  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return Promise.resolve(this.streamFile(target, signal))
  }

  private async *streamFile(target: FsTarget, signal?: AbortSignal): AsyncIterable<string> {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    try {
      let offset = 0
      for (;;) {
        const bytes = await this.readByteRange(target, { offset, length: chunkSize }, signal)
        if (bytes.includes(0)) throw new FsError('The file is not UTF-8 text.', 'FS_NOT_TEXT')
        if (bytes.length > 0) yield decoder.decode(bytes, { stream: true })
        if (bytes.length < chunkSize) break
        offset += bytes.length
      }
      const tail = decoder.decode()
      if (tail !== '') yield tail
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      throw new FsError('The file is not UTF-8 text.', 'FS_NOT_TEXT', { cause: error })
    }
  }

  /** @inheritdoc */
  override readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return this.read(target, 0, Math.min(maxBytes, MAX_TEXT_BYTES), true, signal)
  }

  /** @inheritdoc */
  override readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return this.read(target, range.offset, range.length, false, signal)
  }

  /** @inheritdoc */
  override async listDir(target: FsTarget, signal?: AbortSignal) {
    const entries = z.array(entry.extend({ name: z.string(), path: z.string() }))
    const values = await this.call('list', this.processPath(target), {}, entries, signal)
    return values.map(value => ({
      name: value.name, type: value.type === 'symlink' ? 'other' as const : value.type,
      target: { targetKey: FsTargetKey(value.path), displayPath: displayPath(this.root, value.path) },
      version: FsVersion(value.version), size: value.size,
    }))
  }

  /** @inheritdoc */
  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    this.checkMutation(sandboxPolicy)
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new FsError('The write exceeds the Bot file size limit.', 'FS_TOO_LARGE')
    const result = await this.call('write', this.processPath(target), { content, expected }, outcome, signal)
    return writeOutcome(result, content)
  }

  /** @inheritdoc */
  override editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: Version },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    return this.change(target, before => editContent(before, edit), expected, signal, sandboxPolicy)
  }

  /** @inheritdoc */
  override patchText(
    target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: Version },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    return this.change(target, before => patchContent(before, hunks), expected, signal, sandboxPolicy)
  }

  /** @inheritdoc */
  override async deleteFile(
    target: FsTarget, expected?: { version: Version },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    this.checkMutation(sandboxPolicy)
    const result = await this.call('delete', this.processPath(target), { expected }, z.object({ before: z.string().nullable() }), signal)
    return { before: result.before === null ? null : normalize(result.before) }
  }

  /** @inheritdoc */
  override async moveFile(
    source: FsTarget, destination: FsTarget, options: Parameters<FileSystem['moveFile']>[2],
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    this.checkMutation(sandboxPolicy)
    if (this.processPath(source) === this.processPath(destination)) {
      throw new FsError('Source and destination are the same file.', 'FS_SAME_TARGET')
    }
    const current = await this.currentText(source, options.expectedSource, signal)
    const after = options.hunks === undefined ? current.text : patchContent(normalize(current.text), options.hunks)
    const moved = await this.call('move', this.processPath(source), {
      expected: { version: current.version }, destination: this.processPath(destination),
      destinationExpected: options.expectedDestination,
      ...(options.hunks === undefined ? {} : { content: this.restoreStyle(current.text, after) }),
    }, outcome.extend({ sourceBefore: z.string().nullable(), sourceDeleted: z.boolean() }), signal)
    const before = moved.sourceBefore === null ? null : normalize(moved.sourceBefore)
    return {
      sourceBefore: before, destination: writeOutcome(moved, after),
      ...(moved.sourceDeleted ? { sourceDeleted: true as const } : {
        sourceDeleted: false as const,
        sourceFailure: { code: 'FS_IO_ERROR' as const, message: 'The destination was saved. The source could not be removed.' },
      }),
    }
  }

  private restoreStyle(original: string, text: string): string {
    return original.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text
  }

  private async currentText(target: FsTarget, expected: { version: Version } | undefined, signal?: AbortSignal) {
    const info = await this.stat(target, signal)
    if (info === undefined || (expected !== undefined && expected.version !== info.version)) {
      throw new FsError('Read the file again before modifying it.', 'FS_STALE_VERSION')
    }
    return { version: info.version, text: await this.readText(target, signal) }
  }

  private async change(
    target: FsTarget, transform: (text: string) => string, expected?: { version: Version },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ) {
    this.checkMutation(sandboxPolicy)
    const current = await this.currentText(target, expected, signal)
    const before = normalize(current.text)
    const after = transform(before)
    const guard = { kind: 'replaceIfVersion' as const, version: current.version }
    const result = await this.writeText(target, this.restoreStyle(current.text, after), guard, signal, sandboxPolicy)
    return { version: result.version, before, after }
  }

  private checkMutation(sandboxPolicy?: SandboxExecutionPolicy): void {
    if (sandboxPolicy?.mode === 'read-only') throw new FsError('The current session is read-only.', 'FS_SANDBOX_DENIED')
  }

  private async read(target: FsTarget, offset: number, limit: number, whole: boolean, signal?: AbortSignal): Promise<Uint8Array> {
    const data = await this.call('read', this.processPath(target), { offset, limit, whole }, z.base64(), signal)
    return Buffer.from(data, 'base64')
  }

  private async call<T>(operation: string, path: string, arguments_: object, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    await this.runtime.ensure(this.sessionId)
    signal?.throwIfAborted()
    const command = ['/usr/bin/python3', '-I', '/usr/local/lib/yharness/files.py', this.root]
    const [program, ...argv] = this.runtime.execArgv(this.sessionId, command, { stdin: true })
    try {
      const child = exec(program, argv, { signal, timeout: 30_000, maxBuffer: MAX_TEXT_BYTES * 2 })
      child.child.stdin?.on('error', (error) => { void error })
      child.child.stdin?.end(JSON.stringify({ operation, path, ...arguments_ }))
      const { stdout } = await child
      const response: unknown = JSON.parse(stdout)
      const failure = workerFailure.safeParse(response)
      if (failure.success) throw new FsError(failure.data.message, failure.data.error)
      return z.object({ value: schema }).parse(response).value
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof FsError) throw error
      throw new FsError('The VPS Bot file operation could not complete.', 'FS_IO_ERROR')
    }
  }
}
