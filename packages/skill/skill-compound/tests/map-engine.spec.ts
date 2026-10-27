import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const testBudget = Math.max(40_000, Number(process.env.DSH_COVERAGE_TEST_TIMEOUT_MS) || 0)


const python = ['python3', 'python'].find(command => spawnSync(command, [
  '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)',
]).status === 0)
const tests = fileURLToPath(new URL('.', import.meta.url))

describe.skipIf(python === undefined)('code map engine', () => {
  it('passes the Python index, resolver and refresh regressions', () => {
    const result = spawnSync(python!, ['-m', 'unittest', 'discover', '-s', tests, '-p', 'test_*.py'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      timeout: testBudget - 5_000,
    })
    expect(result.signal).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('OK')
  }, testBudget)
})
