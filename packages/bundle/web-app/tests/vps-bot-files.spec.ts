import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import { describe, expect, it, vi } from 'vitest'
import { VpsBotFileSystem } from '../src/vps-bot-files.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

describe('VPS Bot file provider', () => {
  it('uses its computer for guarded writes, edits, reads and moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-bot-files-'))
    const runtime = new VpsRuntime(root, 'localhost/test')
    const sessionId = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
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
})
