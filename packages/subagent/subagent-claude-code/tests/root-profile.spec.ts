/** Execution-world path conventions are tested without invoking a native provider. */
import { win32, posix } from 'node:path'
import { it, expect } from 'vitest'
import { containsProfilePath, nativeHome } from '../src/root-profile.ts'

it('distinguishes Windows profile ancestors, sibling directories and drives', () => {
  expect(containsProfilePath('C:\\Users\\person\\.claude', 'C:\\Users\\person\\.claude\\cache', win32)).toBe(true)
  expect(containsProfilePath('C:\\workspace', 'C:\\outside\\profile', win32)).toBe(false)
  expect(containsProfilePath('C:\\workspace', 'D:\\workspace', win32)).toBe(false)
  expect(containsProfilePath('C:\\workspace', 'C:\\workspace-two', win32)).toBe(false)
})
it('distinguishes POSIX profile ancestors from parent traversal and sibling prefixes', () => {
  expect(containsProfilePath('/home/person/.claude', '/home/person/.claude/cache', posix)).toBe(true)
  expect(containsProfilePath('/workspace', '/outside/profile', posix)).toBe(false)
  expect(containsProfilePath('/workspace', '/workspace-two', posix)).toBe(false)
})

it('binds the actual POSIX or Windows native home variable without account inference', () => {
  expect(nativeHome({ HOME: '/home/native', USERPROFILE: 'C:\\Users\\other' }, 'darwin')).toBe('/home/native')
  expect(nativeHome({ USERPROFILE: 'C:\\Users\\native' }, 'win32')).toBe('C:\\Users\\native')
  expect(nativeHome({ HOME: 'C:\\wrong', USERPROFILE: 'C:\\Users\\native' }, 'win32')).toBe('C:\\Users\\native')
})
