import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const reporter = fileURLToPath(new URL('./coverage-uncovered-locations.cjs', import.meta.url))
const recorded = 'packages/example/owner/src/recorded.ts'
const newFile = 'packages/example/owner/src/new.ts'
const source = 'export const value = 1\n'
const firstGap = '1:1 uncovered statement'
const roots: string[] = []

const replay = `
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const [reporter, projectRoot, baselineFile] = process.argv.slice(1)
const report = new (require(reporter))({ projectRoot, baselineFile })
report.onStart()
for (const [name, starts] of Object.entries(JSON.parse(readFileSync(0, 'utf8')))) {
  const statementMap = {}
  const s = {}
  for (const [index, start] of starts.entries()) {
    s[index] = 0
    const position = { line: start, column: 0 }
    statementMap[index] = { start: position, end: position }
  }
  report.onDetail({ getFileCoverage: () => ({ path: resolve(projectRoot, name), statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} }) })
}
report.onEnd()
`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(locations = [firstGap]) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-coverage-baseline-'))
  roots.push(projectRoot)
  const knownSource = join(projectRoot, recorded)
  mkdirSync(dirname(knownSource), { recursive: true })
  writeFileSync(knownSource, source)
  writeFileSync(join(projectRoot, newFile), source)
  const baselineFile = join(projectRoot, 'baseline.json')
  const manifest = {
    version: 1,
    platform: process.platform,
    job: 42,
    files: { [recorded]: { sha256: createHash('sha256').update(source).digest('hex'), uncovered: locations } },
  }
  const writeBaseline = () => { writeFileSync(baselineFile, JSON.stringify(manifest)) }
  writeBaseline()
  const report = (files: Record<string, number[]>) => spawnSync(
    process.execPath, ['--input-type=commonjs', '-e', replay, reporter, projectRoot, baselineFile], {
      input: JSON.stringify(files), encoding: 'utf8', timeout: 10_000,
    },
  )
  return { report, knownSource, manifest, writeBaseline }
}

it('accepts a measured subset of existing gaps and portable checkout line endings', () => {
  const { report, knownSource } = fixture([firstGap, firstGap])
  writeFileSync(knownSource, source.replaceAll('\n', '\r\n'))
  const result = report({ [recorded]: [1], [newFile]: [] })
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('accepted 1 existing gaps across 2 measured files')
})

it('rejects an added occurrence at the same source location', () => {
  const { report } = fixture()
  const result = report({ [recorded]: [1, 1] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('rejected 1 results')
  expect(result.stderr).toContain(`${recorded}:${firstGap}`)
})

it('rejects a new gap even when another location in the same file was covered', () => {
  const { report } = fixture()
  const result = report({ [recorded]: [2] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}:2:1 uncovered statement`)
})

it('rejects uncovered code in a new file', () => {
  const { report } = fixture()
  const result = report({ [recorded]: [1], [newFile]: [1] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${newFile}:${firstGap}`)
})

it('requires full coverage once the recorded source changes', () => {
  const { report, knownSource } = fixture()
  writeFileSync(knownSource, 'export const value = 2\n')
  const failed = report({ [recorded]: [1] })
  expect(failed.status).toBe(1)
  expect(failed.stderr).toContain(`${recorded}: changed source still has 1 uncovered locations`)
  expect(report({ [recorded]: [] }).status).toBe(0)
})

it('rejects an absent measurement for a recorded file still in the checkout', () => {
  const { report, knownSource } = fixture()
  const result = report({ [newFile]: [] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}: expected coverage measurement is missing`)
  rmSync(knownSource)
  expect(report({ [newFile]: [] }).status).toBe(0)
})

it('fails when no source files were measured', () => {
  const { report } = fixture()
  const result = report({})
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('No source files were measured')
})

it('rejects an uncovered entry without a usable source location', () => {
  const { report } = fixture()
  const result = report({ [recorded]: [0] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}: 1 uncovered locations could not be identified`)
})

it('refuses a baseline for another platform', () => {
  const { report, manifest, writeBaseline } = fixture()
  manifest.platform = process.platform === 'win32' ? 'linux' : 'win32'
  writeBaseline()
  const result = report({ [recorded]: [1] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Invalid coverage baseline for this platform')
})
