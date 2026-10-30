import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@yharness/native-command'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from '../src/default-directory.ts'

describe('system Documents directory', () => {
  it.each([
    ['darwin', '/Users/a/\u{6587}\u{6863}/\n', '/Users/a/\u{6587}\u{6863}/Y Harness/default-workspace', 'osascript'],
    ['win32', 'D:\\Redirected Documents\r\n', 'D:\\Redirected Documents\\Y Harness\\default-workspace', 'powershell.exe'],
    ['linux', '/home/a/My Documents\n', '/home/a/My Documents/Y Harness/default-workspace', 'xdg-user-dir'],
  ] as const)('uses the %s account directory and preserves spaces and Unicode', async (platform, stdout, path, command) => {
    const run = vi.fn<NativeCommandRunner>(async () => ({ stdout, stderr: '' }))
    const signal = new AbortController().signal
    await expect(defaultWorkspaceDirectory(undefined, signal, { platform, run })).resolves.toBe(path)
    expect(run).toHaveBeenCalledWith(command, expect.any(Array), signal, 'hidden')
  })

  it('uses the configured directory without a system lookup', async () => {
    const run = vi.fn<NativeCommandRunner>()
    await expect(defaultWorkspaceDirectory('/documents', new AbortController().signal, { platform: 'linux', run }))
      .resolves.toBe('/documents/Y Harness/default-workspace')
    expect(run).not.toHaveBeenCalled()
  })

  it('reuses the legacy default Workspace path when it already exists', async () => {
    const documents = await mkdtemp(join(tmpdir(), 'yharness-default-directory-'))
    const legacy = join(documents, 'deepseek-harness', 'default-workspace')
    try {
      await mkdir(legacy, { recursive: true })
      await expect(defaultWorkspaceDirectory(documents, new AbortController().signal, { platform: 'linux' }))
        .resolves.toBe(legacy)
    } finally {
      await rm(documents, { recursive: true, force: true })
    }
  })

  it.each(['', '\r\n', '/home/a\n'])('rejects an unavailable XDG directory %j', async (stdout) => {
    const run: NativeCommandRunner = async () => ({ stdout, stderr: '' })
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'linux', home: '/home/a', run }))
      .rejects.toThrow('unavailable')
  })

  it('propagates lookup failure and cancellation', async () => {
    const run: NativeCommandRunner = async () => { throw new Error('lookup denied') }
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'darwin', run }))
      .rejects.toThrow('lookup denied')
    await expect(defaultWorkspaceDirectory('/documents', AbortSignal.abort(), { platform: 'linux' }))
      .rejects.toThrow()
    await expect(defaultWorkspaceDirectory(undefined, new AbortController().signal, { platform: 'freebsd' }))
      .rejects.toThrow('unavailable')
  })

  it.each(['relative', 'C:relative', '\\rooted'])('rejects a Windows path without a fully qualified root: %s', (path) => {
    expect(() => validateDocumentsDirectory(path, 'win32')).toThrow('fully qualified')
  })

  it('accepts redirected UNC Documents directories', () => {
    expect(validateDocumentsDirectory('\\\\server\\share\\Documents', 'win32')).toBe('\\\\server\\share\\Documents')
    expect(() => validateDocumentsDirectory('relative', 'linux')).toThrow('fully qualified')
  })
})
