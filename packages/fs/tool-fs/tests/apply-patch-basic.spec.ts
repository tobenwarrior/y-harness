/** End-to-end apply_patch execution through the existing ToolRuntime and local provider. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@yharness/cordis'
import { ToolCallId } from '@yharness/llm'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import LocalFileSystem from '@yharness/fs-local'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@yharness/fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome, FsEditOutcome, FsEditRequest, FsDeleteOutcome, FsMoveOutcome } from '@yharness/fs'
import SandboxPolicyService from '@yharness/sandbox-policy'
import SessionProjectionRegistry from '@yharness/session-projection'
import * as ToolFs from '../src/index.ts'

const signal = new AbortController().signal
let callId = 0

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'yharness-apply-patch-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(ToolFs, { applyPatch: true })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, root }
}

/** A confined in-memory provider that records the base used to resolve patch paths. */
class ConfinedFakeFs extends FileSystem {
  readonly resolvedCwds: (string | undefined)[] = []
  readonly lstatCwds: (string | undefined)[] = []
  private readonly files = new Map<string, string>()

  override get sandboxMode() { return 'workspace-write' as const }
  override watch(): never { throw new Error('watch is not used by this fixture') }
  override async resolve(path: string, opts?: { cwd?: string }): Promise<FsTarget> {
    this.resolvedCwds.push(opts?.cwd)
    return { targetKey: FsTargetKey(`key:${path}`), displayPath: `/abs/${path}` }
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }
  override contains(parent: FsTarget, child: FsTarget): boolean { return child.targetKey === parent.targetKey }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(target.targetKey)
    return content === undefined ? undefined : { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async lstat(_path: string, opts?: { cwd?: string }): Promise<FsPathInfo | undefined> {
    this.lstatCwds.push(opts?.cwd)
    return undefined
  }
  override async readText(target: FsTarget): Promise<string> { return this.files.get(target.targetKey) ?? '' }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }
  override async readBytes(): Promise<Uint8Array> { return new Uint8Array() }
  override async readByteRange(): Promise<Uint8Array> { return new Uint8Array() }
  override async listDir(): Promise<FsDirEntry[]> { return [] }
  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.files.get(target.targetKey) ?? null
    this.files.set(target.targetKey, content)
    return { operation: before === null ? 'create' : 'update', version: FsVersion('v2'), before, after: content }
  }
  override async editText(_target: FsTarget, _edit: FsEditRequest, _expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    throw new Error('edit is not used by this fixture')
  }
  override async patchText(): Promise<never> { throw new Error('patch is not used by this fixture') }
  override async deleteFile(): Promise<FsDeleteOutcome> { throw new Error('delete is not used by this fixture') }
  override async moveFile(): Promise<FsMoveOutcome> { throw new Error('move is not used by this fixture') }
}

describe('apply_patch execution', () => {
  it('applies add, update, delete, and move operations in one call', async () => {
    const { ctx, root } = await setup()
    const edit = join(root, 'edit.txt')
    const remove = join(root, 'remove.txt')
    const source = join(root, 'source.txt')
    const created = join(root, 'created.txt')
    const moved = join(root, 'moved.txt')
    await writeFile(edit, 'old\n')
    await writeFile(remove, 'gone\n')
    await writeFile(source, 'old\n')
    const input = [
      '*** Begin Patch',
      `*** Update File: ${edit}`,
      '@@',
      '-old',
      '+new',
      `*** Add File: ${created}`,
      '+created',
      `*** Delete File: ${remove}`,
      `*** Update File: ${source}`,
      `*** Move to: ${moved}`,
      '@@',
      '-old',
      '+renamed',
      '*** End Patch',
    ].join('\n')
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId(`apply-patch-${++callId}`), name: 'apply_patch', arguments: { input },
    })
    expect(result.isError, result.content.map(block => block.type === 'text' ? block.text : '').join('')).toBe(false)
    if (result.isError) throw new Error('expected patch success')
    expect(result.value).toMatchObject({ operations: [
      { status: 'completed' }, { status: 'completed' }, { status: 'completed' }, { status: 'completed' },
    ] })
    expect(await readFile(edit, 'utf8')).toBe('new\n')
    expect(await readFile(created, 'utf8')).toBe('created\n')
    await expect(readFile(remove, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(moved, 'utf8')).toBe('renamed\n')
    await expect(readFile(source, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a malformed patch before touching the filesystem', async () => {
    const { ctx, root } = await setup()
    const target = join(root, 'target.txt')
    await writeFile(target, 'old\n')
    const result = await ctx.tools.execute({
      signal, callId: ToolCallId(`apply-patch-${++callId}`), name: 'apply_patch', arguments: { input: 'not a patch' },
    })
    expect(result.isError).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('old\n')
  })

  it('reports an I/O failure as unchanged when the provider retains the original version', async () => {
    const { ctx, root } = await setup()
    const target = join(root, 'target.txt')
    await writeFile(target, 'old\n')
    vi.spyOn(ctx.fs, 'patchText').mockRejectedValueOnce(new FsError('Provider refused the write.', 'FS_IO_ERROR'))

    const result = await ctx.tools.execute({
      signal, callId: ToolCallId(`apply-patch-${++callId}`), name: 'apply_patch',
      arguments: { input: [
        '*** Begin Patch', `*** Update File: ${target}`, '@@', '-old', '+new', '*** End Patch',
      ].join('\n') },
    })
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'FS_IO_ERROR' } } })
    expect(result.content.some(block => block.type === 'text' && block.text.includes('Provider refused the write.'))).toBe(true)
    await expect(readFile(target, 'utf8')).resolves.toBe('old\n')
  })

  it('uses the agentless sandbox workspace root when planning a relative patch', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'yharness-apply-patch-workspace-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot })
    await ctx.plugin(ConfinedFakeFs)
    await ctx.plugin(ToolFs, { applyPatch: true })
    onTestFinished(async () => {
      await ctx.fiber.dispose()
      await rm(workspaceRoot, { recursive: true, force: true })
    })

    const result = await ctx.tools.execute({
      signal, callId: ToolCallId(`apply-patch-${++callId}`), name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Add File: external.txt\n+external\n*** End Patch' },
    })
    expect(result.isError, result.content.map(block => block.type === 'text' ? block.text : '').join('')).toBe(false)
    const fs = ctx.fs as ConfinedFakeFs
    expect(fs.resolvedCwds).toContain(workspaceRoot)

    const refused = await ctx.tools.execute({
      signal, callId: ToolCallId(`apply-patch-${++callId}`), name: 'apply_patch',
      arguments: { input: '*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch' },
    })
    expect(refused.isError).toBe(true)
    expect(fs.lstatCwds).toContain(workspaceRoot)
  })
})
