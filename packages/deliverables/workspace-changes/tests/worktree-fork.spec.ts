/**
 * createForkWorktree / removeForkWorktree: slug derivation, refusals, the
 * cleanup path, and result-typed git failures. GitRunner is faked (no git
 * process runs), but the worktrees root is a real temporary directory so the
 * module's directory preparation is genuinely exercised.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitRunner, GitRunOptions, GitRunResult } from '../src/git.ts'
import {
  canForkIntoWorktree,
  createForkWorktree,
  removeForkWorktree,
  slugifyLabel,
} from '../src/worktree-fork.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A real, writable worktrees root per test. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wt-fork-'))
  roots.push(root)
  return root
}

interface Call {
  readonly args: readonly string[]
  readonly cwd: string
}

function result(exitCode: number, stdout = '', stderr = ''): GitRunResult {
  return { exitCode, stdout, stderr, truncated: false }
}

/** Scripted runner: matches on the joined args prefix. */
function gitStub(script: readonly (readonly [string, GitRunResult])[]): GitRunner & { calls: Call[] } {
  const calls: Call[] = []
  return Object.assign(Object.create(null) as GitRunner, {
    calls,
    async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
      calls.push({ args, cwd: options.cwd })
      for (const [prefix, response] of script) {
        if (args.join(' ').startsWith(prefix)) return response
      }
      return result(0, '')
    },
  })
}

const SIGNAL = new AbortController().signal
const SOURCE = '/repo/sub'

/** The happy path: a normal repository on a commit with a free branch. */
function healthy(): GitRunner & { calls: Call[] } {
  return gitStub([
    ['rev-parse --show-toplevel', result(0, '/repo\n')],
    ['rev-parse HEAD', result(0, 'abc123\n')],
    ['rev-parse --verify --quiet refs/heads/', result(1)],
  ])
}

describe('slugifyLabel', () => {
  it('produces a ref-safe slug', () => {
    expect(slugifyLabel('Fix the parser bug')).toBe('fix-the-parser-bug')
    expect(slugifyLabel('  Weird//Chars__Here!  ')).toBe('weird-chars-here')
  })

  it('returns empty when nothing usable remains', () => {
    expect(slugifyLabel('***')).toBe('')
    expect(slugifyLabel('')).toBe('')
  })

  it('caps length without a trailing dash', () => {
    const slug = slugifyLabel('a'.repeat(80))
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('createForkWorktree', () => {
  it('creates a branch and checkout from HEAD', async () => {
    const root = tempRoot()
    const git = healthy()
    const outcome = await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'Fix the parser bug',
      worktreesRoot: root,
      signal: SIGNAL,
    })
    expect(outcome).toEqual({
      kind: 'created',
      path: join(root, 'fix-the-parser-bug'),
      branch: 'dsh/fork/fix-the-parser-bug',
      repositoryRoot: '/repo',
      baseCommit: 'abc123',
    })
    const add = git.calls.find(call => call.args[0] === 'worktree')
    expect(add?.args).toEqual([
      'worktree', 'add', '-b', 'dsh/fork/fix-the-parser-bug',
      join(root, 'fix-the-parser-bug'), 'abc123',
    ])
  })

  it('disambiguates same-labeled forks with a suffix', async () => {
    const root = tempRoot()
    const outcome = await createForkWorktree(healthy(), {
      sourceDir: SOURCE,
      label: 'Fix the parser bug',
      worktreesRoot: root,
      suffix: 'Ab12Cd34',
      signal: SIGNAL,
    })
    expect(outcome).toMatchObject({
      kind: 'created',
      path: join(root, 'fix-the-parser-bug-ab12cd34'),
      branch: 'dsh/fork/fix-the-parser-bug-ab12cd34',
    })
  })

  it('honors an explicit start point', async () => {
    const git = healthy()
    await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'Fix the parser bug',
      worktreesRoot: tempRoot(),
      startPoint: 'origin/main',
      signal: SIGNAL,
    })
    const add = git.calls.find(call => call.args[0] === 'worktree')
    expect(add?.args.at(-1)).toBe('origin/main')
  })

  it('refuses a non-repository instead of failing', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(128, '', 'fatal: not a git repository (or any of the parent directories)')],
    ])
    expect(await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'x',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })).toEqual({ kind: 'refused', reason: 'not-a-repository', detail: SOURCE })
  })

  it('refuses a repository with no commits', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(0, '/repo\n')],
      ['rev-parse HEAD', result(128, '', 'fatal: ambiguous argument HEAD')],
    ])
    const outcome = await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'x',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'not-a-repository' })
  })

  it('refuses an unusable label before running git', async () => {
    const git = healthy()
    const outcome = await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: '***',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'invalid-label' })
    expect(git.calls).toHaveLength(0)
  })

  it('refuses when the branch already exists', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(0, '/repo\n')],
      ['rev-parse HEAD', result(0, 'abc123\n')],
      ['rev-parse --verify --quiet refs/heads/', result(0, 'deadbeef\n')],
    ])
    expect(await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'Fix the parser bug',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })).toEqual({
      kind: 'refused',
      reason: 'already-exists',
      detail: 'dsh/fork/fix-the-parser-bug',
    })
  })

  it('reports worktree-add failure with its stage and stderr tail', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(0, '/repo\n')],
      ['rev-parse HEAD', result(0, 'abc123\n')],
      ['rev-parse --verify --quiet refs/heads/', result(1)],
      ['worktree add', result(128, '', "fatal: 'dsh/fork/x' is already checked out")],
    ])
    const outcome = await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'Fix the parser bug',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })
    expect(outcome).toEqual({
      kind: 'failed',
      stage: 'worktree-add',
      exitCode: 128,
      stderr: "fatal: 'dsh/fork/x' is already checked out",
    })
  })

  it('propagates an unexpected rev-parse failure as failed, not refused', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(128, '', 'fatal: dubious ownership detected')],
    ])
    const outcome = await createForkWorktree(git, {
      sourceDir: SOURCE,
      label: 'x',
      worktreesRoot: tempRoot(),
      signal: SIGNAL,
    })
    expect(outcome).toMatchObject({ kind: 'failed', stage: 'rev-parse', exitCode: 128 })
  })
})

describe('removeForkWorktree', () => {
  it('removes the worktree then the branch', async () => {
    const git = gitStub([['worktree remove', result(0)]])
    expect(await removeForkWorktree(git, '/repo', '/repo/.worktrees/x', 'dsh/fork/x', SIGNAL))
      .toEqual({ kind: 'removed' })
    expect(git.calls.map(call => call.args[0])).toEqual(['worktree', 'branch'])
  })

  it('prunes and drops the branch when the directory is already gone', async () => {
    const git = gitStub([
      ['worktree remove', result(128, '', "fatal: '/repo/.worktrees/x' is not a working tree")],
    ])
    expect(await removeForkWorktree(git, '/repo', '/repo/.worktrees/x', 'dsh/fork/x', SIGNAL))
      .toEqual({ kind: 'missing' })
    const verbs = git.calls.map(call => call.args.slice(0, 2).join(' '))
    expect(verbs).toContain('worktree prune')
    expect(verbs).toContain('branch -D')
  })

  it('reports an unexpected removal failure', async () => {
    const git = gitStub([
      ['worktree remove', result(1, '', 'error: cannot lock ref')],
    ])
    expect(await removeForkWorktree(git, '/repo', '/repo/.worktrees/x', undefined, SIGNAL))
      .toEqual({ kind: 'failed', exitCode: 1, stderr: 'error: cannot lock ref' })
  })

  it('rejects a relative path (programming error)', async () => {
    const git = gitStub([])
    await expect(removeForkWorktree(git, '/repo', 'relative/x', undefined, SIGNAL))
      .rejects.toThrow(/absolute/)
  })
})

describe('canForkIntoWorktree', () => {
  it('is true for a repository with a commit', async () => {
    const git = gitStub([
      ['rev-parse --show-toplevel', result(0, '/repo\n')],
      ['rev-parse --verify --quiet HEAD', result(0, 'abc123\n')],
    ])
    expect(await canForkIntoWorktree(git, SOURCE, SIGNAL)).toBe(true)
  })

  it('is false outside a repository or without commits', async () => {
    const outside = gitStub([['rev-parse --show-toplevel', result(128, '', 'fatal: not a git repository')]])
    expect(await canForkIntoWorktree(outside, SOURCE, SIGNAL)).toBe(false)
    const empty = gitStub([
      ['rev-parse --show-toplevel', result(0, '/repo\n')],
      ['rev-parse --verify --quiet HEAD', result(1)],
    ])
    expect(await canForkIntoWorktree(empty, SOURCE, SIGNAL)).toBe(false)
  })

  it('is false when git cannot spawn', async () => {
    const broken = Object.assign(Object.create(null) as GitRunner, {
      run: vi.fn(async () => { throw new Error('ENOENT') }),
    })
    expect(await canForkIntoWorktree(broken, SOURCE, SIGNAL)).toBe(false)
  })
})
