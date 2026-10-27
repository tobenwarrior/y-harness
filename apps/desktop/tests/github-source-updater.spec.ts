import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const python = ['python3', 'python'].find(command => spawnSync(command, [
  '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)',
]).status === 0)
const tests = fileURLToPath(new URL('.', import.meta.url))
const testBudget = Math.max(40_000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS) || 0)

describe.skipIf(process.platform === 'win32' || python === undefined)('GitHub source updater', () => {
  it('runs isolated updater, supervisor, bootstrap, and installer regressions', () => {
    const result = spawnSync(python!, ['-m', 'unittest', 'discover', '-s', tests, '-p', '*github*_test.py'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      timeout: testBudget - 5_000,
    })
    expect(result.signal).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests?/u)
    expect(result.stderr).toContain('OK')
  }, testBudget)
})
