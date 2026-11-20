/** Exercise the owner roster's publication and shutdown against a temporary directory. */

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BotId } from '@yharness/bots'
import { SessionId } from '@yharness/session/types'
import { describe, expect, it, vi } from 'vitest'
import { VpsBrowserRoster, type VpsBrowserRosterEntry } from '../src/vps-browser-roster.ts'

const alpha = {
  bot: BotId('bot-alpha'), session: SessionId('bot-session-12345678-1234-4abc-8def-1234567890ab'),
}
const zeta = {
  bot: BotId('bot-zeta'), session: SessionId('bot-session-abcdefab-cdef-4abc-9abc-abcdefabcdef'),
}

async function withRoster(run: (directory: string, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'yh-browser-roster-'))
  try {
    await chmod(directory, 0o2750)
    await run(directory, join(directory, 'roster.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('private Browser owner roster', () => {
  it('publishes a sorted owner-only roster and keeps the same file for reordered assignments', async () => {
    await withRoster(async (directory, path) => {
      const read = vi.fn(async () => [alpha, zeta]).mockResolvedValueOnce([zeta, alpha])
      const roster = new VpsBrowserRoster(path, read)
      await roster.sync()
      const initial = await lstat(path)
      expect(initial.mode & 0o7777).toBe(0o640)
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify([alpha, zeta]) + '\n')
      await roster.sync()
      expect(read).toHaveBeenCalledOnce()
      roster.invalidate()
      await roster.sync()
      expect(read).toHaveBeenCalledTimes(2)
      expect((await lstat(path)).ino).toBe(initial.ino)
      expect(await readdir(directory)).toEqual(['roster.json'])
      await roster.close()
    })
  })

  it('coalesces concurrent operations and publishes the newest assignments', async () => {
    await withRoster(async (_directory, path) => {
      const old = Promise.withResolvers<VpsBrowserRosterEntry[]>()
      const read = vi.fn(async () => [zeta]).mockReturnValueOnce(old.promise)
      const roster = new VpsBrowserRoster(path, read)
      const first = roster.sync()
      const second = roster.sync()
      roster.invalidate()
      old.resolve([alpha])
      await Promise.all([first, second])
      expect(read).toHaveBeenCalledTimes(2)
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify([zeta]) + '\n')
    })
  })

  it('keeps the last published roster when new assignments are malformed or ambiguous', async () => {
    await withRoster(async (directory, path) => {
      const read = vi.fn(async () => [alpha])
      const roster = new VpsBrowserRoster(path, read)
      await roster.sync()
      const invalidAssignments = [
        Array<VpsBrowserRosterEntry>(65).fill(alpha),
        [alpha, { ...zeta, bot: alpha.bot }],
        [alpha, { ...zeta, session: alpha.session }],
        [{ ...alpha, bot: BotId('invalid') }],
        [{ ...alpha, session: SessionId('invalid') }],
      ]
      for (const entries of invalidAssignments) {
        read.mockResolvedValueOnce(entries)
        roster.invalidate()
        await expect(roster.sync()).rejects.toThrow('The isolated browser roster contains an invalid Bot assignment.')
        expect(await readFile(path, 'utf8')).toBe(JSON.stringify([alpha]) + '\n')
      }
      expect(await readdir(directory)).toEqual(['roster.json'])
    })
  })

  it('requires the installer-owned directory and refuses directory links or broader access', async () => {
    await withRoster(async (directory, path) => {
      const link = join(directory, 'link')
      await symlink(directory, link)
      const other = new VpsBrowserRoster(join(link, 'roster.json'), async () => [alpha])
      await expect(other.sync()).rejects.toThrow('The isolated browser roster directory is unavailable.')
      const roster = new VpsBrowserRoster(path, async () => [alpha])
      const identity = vi.spyOn(process, 'geteuid').mockReturnValue((await lstat(directory)).uid + 1)
      try {
        await expect(roster.sync()).rejects.toThrow('The isolated browser roster directory is unavailable.')
      } finally {
        identity.mockRestore()
      }
      await chmod(directory, 0o2755)
      await expect(roster.sync()).rejects.toThrow('The isolated browser roster directory is unavailable.')
      expect(await readdir(directory)).toEqual(['link'])
    })
  })

  it('removes the temporary file when publication fails and allows a retry', async () => {
    await withRoster(async (directory, path) => {
      await mkdir(path)
      const roster = new VpsBrowserRoster(path, async () => [alpha])
      await expect(roster.sync()).rejects.toMatchObject({ code: 'EISDIR' })
      expect(await readdir(directory)).toEqual(['roster.json'])
      await rm(path, { recursive: true })
      await roster.sync()
      expect(await readFile(path, 'utf8')).toBe(JSON.stringify([alpha]) + '\n')
    })
  })

  it('rejects a waiting operation when the roster closes before publication', async () => {
    await withRoster(async (_directory, path) => {
      const snapshot = Promise.withResolvers<readonly VpsBrowserRosterEntry[]>()
      const roster = new VpsBrowserRoster(path, () => snapshot.promise)
      const syncing = roster.sync()
      const rejected = expect(syncing).rejects.toThrow('The isolated browser roster is unavailable.')
      const closing = roster.close()
      snapshot.resolve([alpha])
      await Promise.all([closing, rejected])
      await expect(roster.sync()).rejects.toThrow('The isolated browser roster is unavailable.')
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('settles shutdown even when the outstanding assignment read fails', async () => {
    await withRoster(async (_directory, path) => {
      const snapshot = Promise.withResolvers<readonly VpsBrowserRosterEntry[]>()
      const roster = new VpsBrowserRoster(path, () => snapshot.promise)
      const failure = new Error('The owner roster read failed.')
      const rejected = expect(roster.sync()).rejects.toBe(failure)
      const closing = roster.close()
      snapshot.reject(failure)
      await Promise.all([closing, rejected])
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
