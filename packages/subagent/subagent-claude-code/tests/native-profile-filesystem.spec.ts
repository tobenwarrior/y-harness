/** Actual owned filesystem entries exercise profile canonicalization without account reads. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { nativeProfile } from '../src/root-profile.ts'

function fixture() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profile-')))
  onTestFinished(() =>{  rmSync(path, { recursive: true, force: true }) })
  const home = join(path, 'home'); mkdirSync(home)
  return { path, home, policy: { mode: 'read-only' as const, workspaceRoot: join(path, 'project') } }
}

it('canonicalizes absent suffixes under an existing declared home', () => {
  const f = fixture()
  expect(nativeProfile({ HOME: f.home, USERPROFILE: f.home }, f.policy, [])).toEqual({ home: f.home, configDirectory: join(f.home,
    '.claude') })
})

it('refuses traversal, undeclared home and relative configured directories', () => {
  const f = fixture()
  for (const env of [{ HOME: join(f.home, '..', 'home') + '/.' }, { HOME: f.home + '/../home' }, {}, { HOME: f.home,
    CLAUDE_CONFIG_DIR: 'relative' }]) {
    expect(() => nativeProfile({ ...env, USERPROFILE: env.HOME }, f.policy, [])).toThrow()
  }
})

it('refuses broken links, symlink loops and non-directory profile ancestors', () => {
  const f = fixture(); const broken = join(f.path, 'broken'); const loop = join(f.path, 'loop'); const file = join(f.path, 'file')
  symlinkSync(join(f.path, 'absent'), broken); symlinkSync(loop, loop); writeFileSync(file, 'fixture')
  for (const path of [broken, loop, join(file, 'nested')]) expect(() => nativeProfile({ HOME: f.home, USERPROFILE: f.home,
    CLAUDE_CONFIG_DIR: path }, f.policy, [])).toThrow()
})
