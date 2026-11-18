/** Native Windows coverage for owner-private ACL creation and refusal. */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertOwnerPrivateWin32, createOwnerPrivateDirectoryWin32 } from '../src/windows-private.ts'

describe('native Windows owner-private security', () => {
  it.skipIf(process.platform !== 'win32')('accepts the natural inherited temp structure and refuses an untrusted ACL', () => {
    const parent = mkdtempSync(join(tmpdir(), 'yh-windows-private-native-'))
    const root = join(parent, '.local', 'share', 'y-harness', 'compound-skills')
    const file = join(root, 'current.json')
    const unsafe = join(parent, 'unsafe')
    try {
      createOwnerPrivateDirectoryWin32(root)
      expect(() => { assertOwnerPrivateWin32(root, 'directory', true) }).not.toThrow()
      writeFileSync(file, '{}', { mode: 0o600 })
      expect(() => { assertOwnerPrivateWin32(file, 'file') }).not.toThrow()

      createOwnerPrivateDirectoryWin32(unsafe)
      execFileSync('icacls.exe', [unsafe, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore' })
      expect(() => { assertOwnerPrivateWin32(unsafe, 'directory', true) }).toThrow(/untrusted ACE/u)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
