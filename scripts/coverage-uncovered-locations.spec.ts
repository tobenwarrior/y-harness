import { execFileSync, spawnSync } from 'node:child_process'
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

type Measurement = (number | readonly [number, number])[] | {
  functions: readonly (readonly [line: number, ordinal: number, count: number])[]
}

const replay = `
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const [reporter, projectRoot, baselineFile] = process.argv.slice(1)
const report = new (require(reporter))({ projectRoot, baselineFile })
report.onStart()
for (const [name, measurement] of Object.entries(JSON.parse(readFileSync(0, 'utf8')))) {
  const statementMap = {}
  const s = {}
  const fnMap = {}
  const f = {}
  const starts = Array.isArray(measurement) ? measurement : []
  for (const [index, location] of starts.entries()) {
    s[index] = 0
    const [start, end] = Array.isArray(location) ? location : [location, location]
    statementMap[index] = { start: { line: start, column: 0 }, end: { line: end, column: 0 } }
  }
  for (const [index, [line, ordinal, count]] of (measurement.functions ?? []).entries()) {
    const point = { line, column: 0 }
    const loc = { start: point, end: point }
    fnMap[index] = { decl: loc, loc, name: '(anonymous_' + ordinal + ')' }
    f[index] = count
  }
  report.onDetail({ getFileCoverage: () => ({ path: resolve(projectRoot, name), statementMap, s, fnMap, f, branchMap: {}, b: {} }) })
}
report.onEnd()
`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(locations = [firstGap], originalSource = source) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'dsh-coverage-baseline-'))
  roots.push(projectRoot)
  const knownSource = join(projectRoot, recorded)
  mkdirSync(dirname(knownSource), { recursive: true })
  writeFileSync(knownSource, originalSource)
  writeFileSync(join(projectRoot, newFile), source)
  const baselineFile = join(projectRoot, 'baseline.json')
  const manifest = {
    version: 1,
    platform: process.platform,
    job: 42,
    files: { [recorded]: { sha256: createHash('sha256').update(originalSource).digest('hex'), uncovered: locations } },
  }
  const writeBaseline = (sourceTree?: string) => { writeFileSync(baselineFile, JSON.stringify({ ...manifest, sourceTree })) }
  writeBaseline()
  const report = (files: Record<string, Measurement>) => spawnSync(
    process.execPath, ['--input-type=commonjs', '-e', replay, reporter, projectRoot, baselineFile], {
      input: JSON.stringify(files), encoding: 'utf8', timeout: 10_000,
    },
  )
  return { report, knownSource, manifest, writeBaseline, projectRoot }
}

function pinSource({ projectRoot, writeBaseline }: ReturnType<typeof fixture>) {
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(projectRoot, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()

  git('init', '--quiet', '--template=')
  git('add', '--', recorded)
  writeBaseline(git('write-tree'))
}

const monitor = [
  'export class Monitor {',
  '  read() {',
  '    return -1',
  '  }',
  '  write() {',
  '    return 2',
  '  }',
  '}',
  '',
].join('\n')

it('retains a measured range in an unchanged method when another method changes', () => {
  const f = fixture(['2:1 uncovered statement (to 3:1)'], monitor)
  pinSource(f)
  writeFileSync(f.knownSource, ('export const state = 0\n' + monitor.replace('return 2', 'return 3')).replaceAll('\n', '\r\n'))
  const result = f.report({ [recorded]: [[3, 4]], [newFile]: [] })
  expect(result).toMatchObject({ status: 0, stderr: '' })
  expect(result.stdout).toContain('accepted 1 existing gaps across 2 measured files')
})

it.each([
  ['changed method body', monitor.replace('return -1', 'return -2')],
  ['changed class declaration', monitor.replace('class Monitor', 'class Monitor extends Base')],
  ['duplicate method', monitor.replace('  write()', '  read() {\n    return -1\n  }\n  write()')],
])('rejects a previously uncovered statement in a %s', (_name, current) => {
  const f = fixture(['3:1 uncovered statement'], monitor)
  pinSource(f)
  writeFileSync(f.knownSource, current)
  const result = f.report({ [recorded]: [3] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}:3:1 uncovered statement`)
})

it('rejects another copy of an uncovered path after the location moves', () => {
  const f = fixture(['3:1 uncovered statement'], monitor)
  pinSource(f)
  writeFileSync(f.knownSource, 'export const state = 0\n' + monitor)
  const result = f.report({ [recorded]: [4, 4] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('rejected 1 results')
  expect(result.stderr).toContain(`${recorded}:4:1 uncovered statement`)
})

it('matches a unique anonymous function after its generated ordinal changes', () => {
  const f = fixture(['3:1 uncovered function (anonymous_7)'], monitor)
  pinSource(f)
  writeFileSync(f.knownSource, 'export const installed = () => true\n' + monitor)
  expect(f.report({ [recorded]: { functions: [[4, 8, 0]] } }).status).toBe(0)
  const duplicate = f.report({ [recorded]: { functions: [[4, 8, 0], [4, 9, 1]] } })
  expect(duplicate.status).toBe(1)
  expect(duplicate.stderr).toContain(`${recorded}:4:1 uncovered function (anonymous_8)`)
})

it('rejects a measured declaration that changes order', () => {
  const f = fixture(['2:1 uncovered statement'], 'const start = 1\nconst finish = 2\n')
  pinSource(f)
  writeFileSync(f.knownSource, 'const finish = 2\nconst start = 1\n')
  const result = f.report({ [recorded]: [1] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}:1:1 uncovered statement`)
})

it('requires the original file in the measured tree to match its recorded digest', () => {
  const f = fixture(['3:1 uncovered statement'], monitor)
  f.manifest.files[recorded].sha256 = '0'.repeat(64)
  pinSource(f)
  writeFileSync(f.knownSource, 'export const state = 0\n' + monitor)
  const result = f.report({ [recorded]: [4] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}: measured source does not match the recorded digest`)
})

it('rejects an allowance when the measured source tree is missing', () => {
  const f = fixture()
  pinSource(f)
  f.writeBaseline('0'.repeat(40))
  writeFileSync(f.knownSource, 'export const newValue = 2\n' + source)
  const result = f.report({ [recorded]: [2] })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(`${recorded}: measured coverage source is unavailable`)
})

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
