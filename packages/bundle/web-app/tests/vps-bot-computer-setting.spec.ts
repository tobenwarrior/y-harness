import { chmod, lstat, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VpsBotComputerSetting } from '../src/vps-bot-computer-setting.ts'

const SESSION = 'bot-session-12345678-1234-4abc-8def-1234567890ab'
const OTHER_SESSION = 'bot-session-abcdefab-cdef-4abc-9abc-abcdefabcdef'

describe.skipIf(process.platform === 'win32')('VPS Bot Computer setting', () => {
  it('keeps the network and shared workspace choices independent across reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-shared-setting-'))
    try {
      await new VpsBotComputerSetting(root, 'network').set(SESSION, true)
      await new VpsBotComputerSetting(root, 'shared-workspace').set(SESSION, false)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(true)
      await expect(new VpsBotComputerSetting(root, 'shared-workspace').get(SESSION)).resolves.toBe(false)
      expect(await readFile(join(root, '.network-access', SESSION), 'utf8')).toBe('{"version":1,"enabled":true}\n')
      expect(await readFile(join(root, '.shared-workspace-access', SESSION), 'utf8')).toBe('{"version":1,"enabled":false}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves construction side-effect free and treats a missing override as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      expect(await policy.get(SESSION)).toBeUndefined()
      await expect(lstat(join(root, '.network-access'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a cold Computer root absent when reading its defaults', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'cold')
    try {
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBeUndefined()
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('persists both decisions and reloads them through a fresh instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await policy.set(SESSION, true)
      await policy.set(OTHER_SESSION, false)
      const reloaded = new VpsBotComputerSetting(root, 'network')
      await expect(reloaded.get(SESSION)).resolves.toBe(true)
      await expect(reloaded.get(OTHER_SESSION)).resolves.toBe(false)
      await reloaded.set(SESSION, false)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes same-root operations and leaves one canonical file per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await Promise.all([policy.set(SESSION, true), policy.set(SESSION, false), policy.get(SESSION)])
      await expect(policy.get(SESSION)).resolves.toBe(false)
      const directory = join(root, '.network-access')
      expect(await readdir(directory)).toEqual([SESSION])
      const file = await lstat(join(directory, SESSION))
      expect(file.isFile()).toBe(true)
      expect(file.isSymbolicLink()).toBe(false)
      expect(file.nlink).toBe(1)
      expect(file.mode & 0o7777).toBe(0o600)
      expect(await readFile(join(directory, SESSION), 'utf8')).toBe('{"version":1,"enabled":false}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed, extra-field, and duplicate-key policy values without exposing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o700 })
      const target = join(directory, SESSION)
      for (const value of [
        '{"version":1,"enabled":"true"}\n',
        '{"version":1,"enabled":true,"extra":false}\n',
        '{"version":1,"enabled":true,"enabled":false}\n',
      ]) {
        await writeFile(target, value, { mode: 0o600 })
        await expect(new VpsBotComputerSetting(root, 'network').get(SESSION))
          .rejects.toThrow('VPS Bot computer setting is invalid')
        await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.not.toThrow(root)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked roots, directories, files, and hard-linked files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    try {
      await mkdir(root, { mode: 0o700 })
      await mkdir(outside, { mode: 0o700 })
      await writeFile(join(outside, SESSION), '{"version":1,"enabled":true}\n', { mode: 0o600 })
      await symlink(outside, join(root, '.network-access'))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await rm(join(root, '.network-access'))
      await mkdir(join(root, '.network-access'), { mode: 0o700 })
      await symlink(join(outside, SESSION), join(root, '.network-access', SESSION))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await rm(join(root, '.network-access', SESSION))
      await link(join(outside, SESSION), join(root, '.network-access', SESSION))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await symlink(root, join(base, 'root-link'))
      await expect(new VpsBotComputerSetting(join(base, 'root-link'), 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects damaged directory and file permissions instead of repairing or granting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o755 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
      await chmod(directory, 0o700)
      await writeFile(join(directory, SESSION), '{"version":1,"enabled":true}\n', { mode: 0o644 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal-shaped session names before touching the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await expect(policy.get('../outside')).rejects.toThrow('invalid')
      await expect(policy.set('bot-session-12345678-1234-4abc-8def-1234567890ab/../outside', true))
        .rejects.toThrow('invalid')
      await expect(lstat(join(root, '.network-access'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
