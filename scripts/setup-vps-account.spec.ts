import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('sets up Cloud under a separate service account', () => {
  const suite = fileURLToPath(new URL('./setup-vps-account-test.py', import.meta.url))
  const result = spawnSync('python3', ['-B', suite], { encoding: 'utf8', timeout: 10_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
})
