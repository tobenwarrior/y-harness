/** macOS launcher ownership checks use controlled ps fixtures without launching the app. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin')('finds only the exact workspace development app through the portable owner helper', () => {
  const python = process.env.DSH_DESKTOP_TEST_PYTHON ?? '/usr/bin/python3'
  const result = spawnSync(python, ['-B', fileURLToPath(new URL('./development_owner_test.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr + result.stdout).toBeNull()
  expect(result.status, result.stderr + result.stdout).toBe(0)
})
