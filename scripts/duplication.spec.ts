import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runJscpd } from 'jscpd'
import { expect, it } from 'vitest'

const config = '.jscpd.json'
const sample = `export function summarizeReadings(readings: readonly number[]) {
  const finiteReadings = readings.filter(reading => Number.isFinite(reading))
  const totalReading = finiteReadings.reduce((total, reading) => total + reading, 0)
  const highestReading = Math.max(...finiteReadings)
  const lowestReading = Math.min(...finiteReadings)
  const averageReading = totalReading / finiteReadings.length
  return { totalReading, highestReading, lowestReading, averageReading }
}
`

function check(root: string, status: number, ...flags: string[]): string {
  const result = runJscpd(['--config', config, ...flags, 'packages', 'scripts'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  const output = result.stdout + result.stderr
  expect(result.status, output).toBe(status)
  return output
}

it('allows inherited clones and rejects new clones and empty input', () => {
  const root = mkdtempSync(join(tmpdir(), 'yharness-duplication-'))
  try {
    copyFileSync(join(import.meta.dirname, '..', config), join(root, config))
    mkdirSync(join(root, 'packages'))
    mkdirSync(join(root, 'scripts'))
    const original = join(root, 'packages', 'source.ts')
    const copy = join(root, 'scripts', 'copy.ts')
    const extra = join(root, 'scripts', 'extra.ts')
    writeFileSync(original, sample)
    writeFileSync(copy, sample)
    check(root, 0, '--update-baseline')
    expect(check(root, 0)).toContain('Found 1 clones.')

    writeFileSync(copy, sample.replaceAll('\n', '\r\n'))
    expect(check(root, 0)).toContain('Found 1 clones.')

    writeFileSync(extra, sample)
    expect(check(root, 1)).toContain('Found 2 clones (1 new).')
    rmSync(extra)

    const changed = sample.replaceAll('Reading', 'Observation').replaceAll('reading', 'observation')
    writeFileSync(original, changed)
    writeFileSync(copy, changed)
    expect(check(root, 1)).toContain('Found 1 clones (1 new).')

    rmSync(original)
    rmSync(copy)
    expect(check(root, 1)).toContain('jscpd analyzed no files')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
