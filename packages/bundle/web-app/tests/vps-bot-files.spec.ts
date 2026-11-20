import { rmSync, symlinkSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@yharness/cordis'
import { parsePatch } from '@yharness/fs-patch'
import { describe, expect, it, vi } from 'vitest'
import { VpsBotFileSystem } from '../src/vps-bot-files.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const SESSION_ID = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'

function localRuntime(root: string, workspace: 'private' | 'shared' = 'private'): VpsRuntime {
  const runtime = new VpsRuntime(root, 'localhost/test', {}, workspace === 'shared' ? { sharedWorkspace: true } : {})
  if (workspace === 'private') vi.spyOn(runtime, 'workspace').mockReturnValue(root)
  else Object.defineProperty(runtime, 'sharedRoot', { configurable: true, value: root })
  vi.spyOn(runtime, 'ensure').mockResolvedValue()
  vi.spyOn(runtime, 'execArgv').mockImplementation((_sessionId, command) => {
    if (workspace === 'shared' || command[2] === '-c') {
      const worker = command[3]
      if (worker === undefined) throw new Error('Missing bundled filesystem worker')
      return ['/usr/bin/env', 'TMPDIR=' + root, 'python3', '-I', '-c', worker, root]
    }
    return ['/usr/bin/env', 'TMPDIR=' + root, 'python3', 'scripts/vps-bot/files.py', root]
  })
  return runtime
}

describe('VPS Bot file provider', () => {
  it('rejects retained shared file access after the owner revokes the grant', async () => {
    const ctx = new Context()
    const sessionId = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
    const policy = { get: vi.fn().mockResolvedValue(false), set: vi.fn() }
    const runtime = new VpsRuntime('/yharness-test', 'localhost/test', undefined, { sharedWorkspacePolicy: policy })
    const ensure = vi.spyOn(runtime, 'ensure').mockResolvedValue()
    try {
      const shared = new VpsBotFileSystem(ctx, runtime, sessionId, 'shared')
      await expect(shared.resolve('notes.txt')).rejects.toThrow('This Bot does not have shared workspace access.')
      expect(policy.get).toHaveBeenCalledExactlyOnceWith(sessionId)
      expect(ensure).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  // This fixture runs the POSIX worker's fcntl locks and no-follow filesystem opens.
  it.skipIf(process.platform === 'win32')('uses its computer for guarded writes, edits, reads and moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-'))
    const runtime = new VpsRuntime(root, 'localhost/test')
    const sessionId = SESSION_ID
    vi.spyOn(runtime, 'workspace').mockReturnValue(root)
    vi.spyOn(runtime, 'ensure').mockResolvedValue()
    vi.spyOn(runtime, 'execArgv').mockReturnValue(['/usr/bin/env', 'TMPDIR=' + root, 'python3', 'scripts/vps-bot/files.py', root])
    const ctx = new Context()
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, sessionId)
      const first = await fs.resolve('notes.txt')
      const created = await fs.writeText(first, 'Hello\r\nWorld\r\n', { kind: 'createIfAbsent' })
      expect(created).toMatchObject({ operation: 'create', after: 'Hello\nWorld\n' })
      const edited = await fs.editText(first, { oldString: 'World', newString: '$&', replaceAll: true }, { version: created.version })
      expect(edited.after).toBe('Hello\n$&\n')
      await expect(fs.writeText(first, 'stale', { kind: 'replaceIfVersion', version: created.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
      const second = await fs.resolve('new/notes.txt')
      await expect(fs.moveFile(first, second, { expectedDestination: { kind: 'createIfAbsent' } })).resolves.toMatchObject({ sourceDeleted: true })
      await expect(fs.readText(second)).resolves.toBe('Hello\r\n$&\r\n')
      await expect(fs.stat(first)).resolves.toBeUndefined()
      await expect(fs.resolve('../outside')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  // The local fixture runs the same bounded Python worker used by a private Computer.
  it.skipIf(process.platform === 'win32')('covers private reads, versions, edits, patches, and removals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-'))
    const workspace = await realpath(root)
    const runtime = localRuntime(workspace)
    const ctx = new Context()
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      const rootTarget = await fs.resolve('.')
      const nested = await fs.resolve('nested/file.txt')
      const sibling = await fs.resolve('sibling.txt')
      expect(rootTarget.displayPath).toBe('.')
      expect(fs.processPath(rootTarget)).toBe(workspace)
      expect(fs.fileUrl(rootTarget)).toBe(pathToFileURL(workspace).href)
      expect(fs.contains(rootTarget, rootTarget)).toBe(true)
      expect(fs.contains(rootTarget, nested)).toBe(true)
      expect(fs.contains(nested, rootTarget)).toBe(false)
      expect(fs.contains(nested, sibling)).toBe(false)
      await expect(fs.stat(nested)).resolves.toBeUndefined()
      await expect(fs.lstat('missing.txt')).resolves.toBeUndefined()

      const created = await fs.writeText(nested, 'Hello\r\nWorld\r\n', { kind: 'createIfAbsent' })
      expect(created).toMatchObject({ operation: 'create', before: null, after: 'Hello\nWorld\n' })
      await expect(fs.stat(nested)).resolves.toMatchObject({ type: 'file', size: 14 })
      await expect(fs.lstat('nested/file.txt')).resolves.toMatchObject({ type: 'file', size: 14 })
      await expect(fs.readText(nested)).resolves.toBe('Hello\r\nWorld\r\n')
      await expect(fs.readBytes(nested, undefined, 8 * 1024 * 1024 + 1)).resolves.toEqual(Buffer.from('Hello\r\nWorld\r\n'))
      await expect(fs.readByteRange(nested, { offset: 7, length: 5 })).resolves.toEqual(Buffer.from('World'))
      await expect(fs.readByteRange(nested, { offset: 100, length: 5 })).resolves.toEqual(Buffer.alloc(0))
      await expect(fs.writeText(await fs.resolve('too-large.txt'), 'x'.repeat(8 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
      await expect(fs.listDir(rootTarget)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'nested', type: 'directory' }),
      ]))

      const updated = await fs.writeText(nested, 'Hello\r\nWorld!\r\n')
      expect(updated).toMatchObject({ operation: 'update', before: 'Hello\nWorld\n', after: 'Hello\nWorld!\n' })
      const edited = await fs.editText(nested, { oldString: 'World!', newString: 'Universe', replaceAll: false })
      expect(edited).toMatchObject({ before: 'Hello\nWorld!\n', after: 'Hello\nUniverse\n' })
      await expect(fs.editText(nested, { oldString: 'not present', newString: 'x', replaceAll: false })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
      await expect(fs.editText(nested, { oldString: '', newString: 'x', replaceAll: false })).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })

      const repeated = await fs.resolve('repeated.txt')
      await fs.writeText(repeated, 'same same')
      await expect(fs.editText(repeated, { oldString: 'same', newString: 'different', replaceAll: false })).rejects.toMatchObject({ code: 'FS_AMBIGUOUS_EDIT' })
      await expect(fs.editText(repeated, { oldString: 'same', newString: 'different', replaceAll: true })).resolves.toMatchObject({ after: 'different different' })

      const patchTarget = await fs.resolve('patch.txt')
      const patchCreated = await fs.writeText(patchTarget, 'one\r\ntwo\r\n')
      const [patchOperation] = parsePatch('*** Begin Patch\n*** Update File: patch.txt\n@@\n-one\n+ONE\n two\n*** End Patch')
      if (patchOperation?.kind !== 'update') throw new Error('Expected an update patch')
      await expect(fs.patchText(patchTarget, patchOperation.hunks, { version: patchCreated.version })).resolves.toMatchObject({ before: 'one\ntwo\n', after: 'ONE\ntwo\n' })
      await expect(fs.patchText(patchTarget, [{ lineNumber: 1, oldLines: ['missing'], newLines: ['x'], isEndOfFile: false }])).rejects.toMatchObject({ code: 'FS_PATCH_MISMATCH' })
      await expect(fs.editText(await fs.resolve('absent.txt'), { oldString: 'x', newString: 'y', replaceAll: false })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

      const deleted = await fs.resolve('delete.txt')
      const deletedVersion = await fs.writeText(deleted, 'delete me')
      await expect(fs.deleteFile(deleted, { version: deletedVersion.version })).resolves.toEqual({ before: 'delete me' })
      await expect(fs.stat(deleted)).resolves.toBeUndefined()
      await expect(fs.deleteFile(deleted, { version: deletedVersion.version })).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })

      const binary = join(workspace, 'binary.bin')
      await writeFile(binary, Buffer.from([0xff]))
      const binaryTarget = await fs.resolve('binary.bin')
      await expect(fs.readText(binaryTarget)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      const binaryStream = await fs.streamText(binaryTarget)
      await expect((async () => { for await (const _chunk of binaryStream) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      await expect(fs.deleteFile(binaryTarget)).resolves.toEqual({ before: null })

      const nul = join(workspace, 'nul.bin')
      await writeFile(nul, Buffer.from([0]))
      const nulTarget = await fs.resolve('nul.bin')
      await expect(fs.readText(nulTarget)).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      const nulStream = await fs.streamText(nulTarget)
      await expect((async () => { for await (const _chunk of nulStream) void _chunk })()).rejects.toMatchObject({ code: 'FS_NOT_TEXT' })
      await fs.deleteFile(nulTarget)

      const empty = await fs.resolve('empty.txt')
      await fs.writeText(empty, '')
      const emptyStream = await fs.streamText(empty)
      const emptyChunks: string[] = []
      for await (const chunk of emptyStream) emptyChunks.push(chunk)
      expect(emptyChunks).toEqual([])

      const largeText = 'a'.repeat(262_143) + '😀tail'
      const large = await fs.resolve('large.txt')
      await fs.writeText(large, largeText)
      const chunks: string[] = []
      const stream = await fs.streamText(large)
      for await (const chunk of stream) chunks.push(chunk)
      expect(chunks.join('')).toBe(largeText)

      const largeMove = await fs.resolve('large-move.txt')
      await fs.writeText(largeMove, 'x'.repeat(512 * 1024 + 1))
      const largeDestination = await fs.resolve('large-destination.txt')
      await expect(fs.moveFile(largeMove, largeDestination, {})).resolves.toMatchObject({ sourceBefore: null, sourceDeleted: true, destination: { before: null, operation: 'create' } })
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('publishes imported skills in the Computer workspace, not the Host placeholder', async () => {
    const container = await mkdtemp(join(tmpdir(), 'yh-bot-skill-computer-'))
    const host = await mkdtemp(join(tmpdir(), 'yh-bot-skill-host-'))
    const hostFile = join(host, '.agents', 'skills', 'container-skill', 'SKILL.md')
    await mkdir(join(host, '.agents', 'skills', 'container-skill'), { recursive: true })
    await writeFile(hostFile, 'host-only')
    const runtime = localRuntime(container)
    const ctx = new Context()
    const content = '---\nname: container-skill\ndescription: "Computer"\n---\n\nRun in the Computer.\n'
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      await expect(fs.installSkill('container-skill', content, true)).resolves.toBe(true)
      await expect(fs.lstat('.agents')).resolves.toBeUndefined()
      await expect(fs.installSkill('container-skill', content, false)).resolves.toBe(true)
      await expect(readFile(join(container, '.agents', 'skills', 'container-skill', 'SKILL.md'), 'utf8'))
        .resolves.toBe(content)
      await expect(fs.installSkill('container-skill', content, false)).resolves.toBe(false)
      await expect(readFile(hostFile, 'utf8')).resolves.toBe('host-only')
      await expect(fs.installSkill('container-skill', content + 'changed\n', false))
        .rejects.toThrow(/already exists with different content/)
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(container, { recursive: true, force: true })
      await rm(host, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('preserves one concurrent skill publication and rejects a conflicting one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-race-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const firstContent = '---\nname: race\ndescription: "First"\n---\n\nFirst.\n'
    const secondContent = '---\nname: race\ndescription: "Second"\n---\n\nSecond.\n'
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      const identical = await Promise.all([
        fs.installSkill('race', firstContent, false),
        fs.installSkill('race', firstContent, false),
      ])
      expect(identical.sort()).toEqual([false, true])
      await expect(readFile(join(root, '.agents', 'skills', 'race', 'SKILL.md'), 'utf8')).resolves.toBe(firstContent)

      const conflicting = await Promise.allSettled([
        fs.installSkill('conflict', firstContent, false),
        fs.installSkill('conflict', secondContent, false),
      ])
      expect(conflicting.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(conflicting.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(conflicting.some(result => result.status === 'rejected' && result.reason instanceof Error
        && result.reason.message.includes('different content'))).toBe(true)
      const conflictFile = await readFile(join(root, '.agents', 'skills', 'conflict', 'SKILL.md'), 'utf8')
      expect([firstContent, secondContent]).toContain(conflictFile)
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a Computer skill directory swapped before the bundled worker opens it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-swap-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const skillDirectory = join(root, '.agents', 'skills', 'raced')
    const replacement = join(root, 'replacement')
    const content = '---\nname: raced\ndescription: "Raced"\n---\n\nRaced.\n'
    try {
      await mkdir(skillDirectory, { recursive: true })
      await mkdir(replacement, { recursive: true })
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      vi.spyOn(runtime, 'execArgv').mockImplementation((_sessionId, command) => {
        const worker = command[3]
        if (worker === undefined) throw new Error('Missing bundled filesystem worker')
        rmSync(skillDirectory, { recursive: true, force: true })
        symlinkSync(replacement, skillDirectory)
        return ['/usr/bin/env', 'TMPDIR=' + root, 'python3', '-I', '-c', worker, root]
      })
      await expect(fs.installSkill('raced', content, false)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(readFile(join(replacement, 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a skill moved after publication but before lexical verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-verify-race-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const skillDirectory = join(root, '.agents', 'skills', 'raced')
    const movedDirectory = join(root, 'raced-moved')
    const marker = join(root, 'worker-published')
    const gate = join(root, 'worker-release')
    const content = '---\nname: raced\ndescription: "Raced"\n---\n\nRaced.\n'
    let pending: Promise<boolean> | undefined
    try {
      await mkdir(skillDirectory, { recursive: true })
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      vi.spyOn(runtime, 'execArgv').mockImplementation((_sessionId, command) => {
        const worker = command[3]
        if (worker === undefined) throw new Error('Missing bundled filesystem worker')
        const verification = '                if not verify_skill(root_fd, parts, published, content):'
        if (!worker.includes(verification)) throw new Error('Missing skill verification barrier')
        const paused = worker.replace(verification,
          `                with open(${JSON.stringify(marker)}, 'w'):\n                    pass\n                while not os.path.exists(${JSON.stringify(gate)}):\n                    __import__('time').sleep(0.01)\n${verification}`)
        return ['/usr/bin/env', 'TMPDIR=' + root, 'python3', '-I', '-c', paused, root]
      })
      pending = fs.installSkill('raced', content, false)
      const waitForMarker = async (): Promise<void> => {
        for (;;) {
          try {
            await stat(marker)
            return
          } catch (error: unknown) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
            await setImmediate()
          }
        }
      }
      await Promise.race([
        waitForMarker(),
        pending.then(() => { throw new Error('The worker finished before the publication barrier.') }, (error: unknown) => { throw error }),
      ])
      await rename(skillDirectory, movedDirectory)
      await writeFile(gate, '')
      await expect(pending).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(readFile(join(movedDirectory, 'SKILL.md'), 'utf8')).resolves.toBe(content)
      await expect(readFile(join(skillDirectory, 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await writeFile(gate, '').catch(() => undefined)
      await pending?.catch(() => undefined)
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects skill directory and file symlinks before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-links-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const content = '---\nname: linked\ndescription: "Linked"\n---\n\nLinked.\n'
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      await mkdir(join(root, 'real-agents'), { recursive: true })
      await symlink(join(root, 'real-agents'), join(root, '.agents'))
      await expect(fs.installSkill('linked', content, false)).rejects.toThrow(/symbolic link directory/)
      await rm(join(root, '.agents'))

      await mkdir(join(root, '.agents', 'skills', 'linked'), { recursive: true })
      const outside = join(root, 'outside.md')
      await writeFile(outside, 'outside')
      await symlink(outside, join(root, '.agents', 'skills', 'linked', 'SKILL.md'))
      await expect(fs.installSkill('linked', content, false)).rejects.toThrow(/symbolic link file/)
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('honors cancellation before touching the Computer workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-cancel-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const controller = new AbortController()
    controller.abort(new Error('synthetic import cancelled'))
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      await expect(fs.installSkill('cancelled', 'content', false, controller.signal)).rejects.toThrow('synthetic import cancelled')
      await expect(fs.lstat('.agents')).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('reads an existing skill through the protected bundled worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-skill-readback-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    const content = '---\nname: readback\ndescription: "Readback"\n---\n\nRead back.\n'
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      await expect(fs.installSkill('readback', content, false)).resolves.toBe(true)
      await writeFile(join(root, '.agents', 'skills', 'readback', 'SKILL.md'), 'tampered')
      await expect(fs.installSkill('readback', content, false)).rejects.toThrow(/already exists with different content/)
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('covers private symlinks, moves, policy denials, and worker failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      const source = await fs.resolve('source.txt')
      const destination = await fs.resolve('destination.txt')
      const sourceCreated = await fs.writeText(source, 'before\r\nline\r\n')
      const destinationCreated = await fs.writeText(destination, 'old destination')
      const moved = await fs.moveFile(source, destination, {
        expectedSource: { version: sourceCreated.version },
        expectedDestination: { kind: 'replaceIfVersion', version: destinationCreated.version },
      })
      expect(moved).toMatchObject({ sourceBefore: 'before\nline\n', sourceDeleted: true, destination: { before: 'old destination', after: 'before\nline\n' } })

      const patchSource = await fs.resolve('patch-source.txt')
      const patchDestination = await fs.resolve('patch-destination.txt')
      const patchSourceCreated = await fs.writeText(patchSource, 'first\r\nsecond\r\n')
      const [movePatch] = parsePatch('*** Begin Patch\n*** Update File: patch-source.txt\n@@\n-first\n+changed\n second\n*** End Patch')
      if (movePatch?.kind !== 'update') throw new Error('Expected an update patch')
      await expect(fs.moveFile(patchSource, patchDestination, {
        expectedSource: { version: patchSourceCreated.version },
        expectedDestination: { kind: 'createIfAbsent' },
        hunks: movePatch.hunks,
      })).resolves.toMatchObject({ sourceBefore: 'first\nsecond\n', sourceDeleted: true, destination: { after: 'changed\nsecond\n' } })
      await expect(fs.moveFile(patchDestination, patchDestination, {})).rejects.toMatchObject({ code: 'FS_SAME_TARGET' })

      const protectedSource = await fs.resolve('protected/source.txt')
      const published = await fs.resolve('published/destination.txt')
      const protectedCreated = await fs.writeText(protectedSource, 'retained source')
      await chmod(join(root, 'protected'), 0o500)
      try {
        await expect(fs.moveFile(protectedSource, published, {
          expectedSource: { version: protectedCreated.version },
          expectedDestination: { kind: 'createIfAbsent' },
        })).resolves.toMatchObject({
          sourceBefore: 'retained source', sourceDeleted: false,
          sourceFailure: { code: 'FS_IO_ERROR' }, destination: { operation: 'create' },
        })
      } finally {
        await chmod(join(root, 'protected'), 0o700)
      }

      const linked = join(root, 'linked.txt')
      await symlink('patch-destination.txt', linked)
      await expect(fs.lstat('linked.txt')).resolves.toMatchObject({ type: 'symlink' })
      const listed = await fs.listDir(await fs.resolve('.'))
      expect(listed.find(entry => entry.name === 'linked.txt')).toMatchObject({ type: 'file' })

      const policy = { mode: 'read-only' as const, workspaceRoot: root }
      await expect(fs.writeText(destination, 'denied', undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.editText(destination, { oldString: 'before', newString: 'denied', replaceAll: false }, undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.patchText(destination, [], undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.deleteFile(destination, undefined, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
      await expect(fs.moveFile(destination, await fs.resolve('denied-destination.txt'), {}, undefined, policy)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('uses the shared worker for granted project files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-shared-'))
    const runtime = localRuntime(root, 'shared')
    const ctx = new Context()
    try {
      const shared = new VpsBotFileSystem(ctx, runtime, SESSION_ID, 'shared')
      const rootTarget = await shared.resolve('.')
      const file = await shared.resolve('shared.txt')
      await expect(shared.writeText(file, 'shared content', { kind: 'createIfAbsent' })).resolves.toMatchObject({ operation: 'create', after: 'shared content' })
      await expect(shared.stat(file)).resolves.toMatchObject({ type: 'file' })
      await expect(shared.lstat('shared.txt')).resolves.toMatchObject({ type: 'file' })
      await expect(shared.readText(file)).resolves.toBe('shared content')
      await expect(shared.listDir(rootTarget)).resolves.toEqual([expect.objectContaining({ name: 'shared.txt', type: 'file' })])

      await symlink('shared.txt', join(root, 'shared-link'))
      await expect(shared.stat(await shared.resolve('shared-link'))).resolves.toMatchObject({ type: 'other' })
      await expect(shared.lstat('shared-link')).resolves.toMatchObject({ type: 'symlink' })
      await expect(shared.listDir(rootTarget)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'shared-link', type: 'other' }),
      ]))
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a shared provider when this runtime has no shared project', async () => {
    const ctx = new Context()
    try {
      const runtime = new VpsRuntime('/yharness-test', 'localhost/test')
      expect(() => new VpsBotFileSystem(ctx, runtime, SESSION_ID, 'shared')).toThrow('Shared project files are unavailable on this Computer')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('reports malformed worker output as an I/O error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-error-'))
    const runtime = localRuntime(root)
    const ctx = new Context()
    vi.spyOn(runtime, 'execArgv').mockReturnValue(['/usr/bin/env', 'python3', '-c', 'import os; os.close(0); print("not-json")'])
    try {
      const fs = new VpsBotFileSystem(ctx, runtime, SESSION_ID)
      await expect(fs.resolve('x'.repeat(1_000_000))).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    } finally {
      await ctx.fiber.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
