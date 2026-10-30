import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubReleasePlan, publishGitHubRelease } from '../scripts/publish-github-release.ts'
import { desktopArtifactBase } from '../scripts/desktop-artifact-name.mjs'

const version = '0.2.1-rc.2'
const roots: string[] = []

function digest(bytes: Buffer): { size: number; sha512: string } {
  return { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }
}

async function target(root: string, name: 'mac-arm64' | 'mac-x64' | 'win-x64'): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const [os, arch] = name === 'win-x64' ? ['win', 'x64'] : ['mac', name === 'mac-arm64' ? 'arm64' : 'x64']
  const base = desktopArtifactBase(version, os, arch)
  const extension = name === 'win-x64' ? 'exe' : 'zip'
  const updateBytes = Buffer.from(`${name}-update`)
  const updateName = `${base}.${extension}`
  await writeFile(join(directory, updateName), updateBytes)
  const updateDigest = digest(updateBytes)
  const metadataName = name === 'win-x64' ? 'latest.yml' : 'latest-mac.yml'
  await writeFile(join(directory, metadataName), dump({ version, files: [{ url: updateName, ...updateDigest }] }))
  const extras = name === 'win-x64'
    ? [`${base}.exe.blockmap`]
    : [`${base}.dmg`, `${base}.zip.blockmap`]
  for (const extra of extras) await writeFile(join(directory, extra), Buffer.from(`${name}-${extra}`))
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('GitHub Desktop release publisher', () => {
  it('validates all signed targets and merges the two macOS update entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yharness-github-release-test-'))
    roots.push(root)
    for (const name of ['mac-arm64', 'mac-x64', 'win-x64'] as const) await target(root, name)
    const plan = await createGitHubReleasePlan({ version, input: root })
    expect(plan.repository).toBe('tobenwarrior/y-harness')
    expect(plan.tag).toBe(`v${version}`)
    expect(plan.assets.map(asset => asset.filename)).toEqual([
      `${desktopArtifactBase(version, 'mac', 'arm64')}.dmg`,
      `${desktopArtifactBase(version, 'mac', 'arm64')}.zip`,
      `${desktopArtifactBase(version, 'mac', 'arm64')}.zip.blockmap`,
      `${desktopArtifactBase(version, 'mac', 'x64')}.dmg`,
      `${desktopArtifactBase(version, 'mac', 'x64')}.zip`,
      `${desktopArtifactBase(version, 'mac', 'x64')}.zip.blockmap`,
      `${desktopArtifactBase(version, 'win', 'x64')}.exe`,
      `${desktopArtifactBase(version, 'win', 'x64')}.exe.blockmap`,
      'latest-mac.yml', 'latest.yml',
    ])
    if (plan.stagingDirectory !== undefined) await rm(plan.stagingDirectory, { recursive: true, force: true })
  })

  it('finds target directories below downloaded artifact roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yharness-github-release-test-'))
    roots.push(root)
    for (const name of ['mac-arm64', 'mac-x64', 'win-x64'] as const) {
      await target(join(root, `desktop-${name}`), name)
    }
    const plan = await createGitHubReleasePlan({ version, input: root })
    expect(plan.assets).toHaveLength(10)
    if (plan.stagingDirectory !== undefined) await rm(plan.stagingDirectory, { recursive: true, force: true })
  })

  it('publishes only to the fixed repository and verifies the tag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yharness-github-release-test-'))
    roots.push(root)
    for (const name of ['mac-arm64', 'mac-x64', 'win-x64'] as const) await target(root, name)
    const plan = await createGitHubReleasePlan({ version, input: root })
    const calls: string[][] = []
    await publishGitHubRelease(plan, async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'release' && args[1] === 'view') throw new Error('release not found')
      return { stdout: '', stderr: '' }
    })
    expect(calls[0]).toEqual(['gh', 'release', 'view', `v${version}`, '--repo', 'tobenwarrior/y-harness'])
    expect(calls[1]?.slice(0, 8)).toEqual(['gh', 'release', 'create', `v${version}`, '--repo', 'tobenwarrior/y-harness', '--verify-tag', '--title'])
    expect(calls[1]).toContain('--prerelease')
    expect(calls[1]?.some(value => value.endsWith('/latest.yml'))).toBe(true)
    expect(calls[1]?.some(value => value.endsWith('/latest-mac.yml'))).toBe(true)
  })

  it('refuses to mutate an existing release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yharness-github-release-test-'))
    roots.push(root)
    for (const name of ['mac-arm64', 'mac-x64', 'win-x64'] as const) await target(root, name)
    const plan = await createGitHubReleasePlan({ version, input: root })
    const calls: string[][] = []
    await expect(publishGitHubRelease(plan, async (command, args) => {
      calls.push([command, ...args])
      return { stdout: '', stderr: '' }
    })).rejects.toThrow(/refusing to mutate/u)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['gh', 'release', 'view', `v${version}`, '--repo', 'tobenwarrior/y-harness'])
  })
})
