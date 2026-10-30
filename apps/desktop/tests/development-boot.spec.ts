import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
const roots: string[] = []

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!existsSync(builtHost))('built Desktop development boot', () => {
  it('boots the built Host from the canonical packages in a prepared development project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-development-boot-'))
    roots.push(root)
    const home = join(root, 'home')
    mkdirSync(home)
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')

    const project = prepareDevelopmentProject({
      projectDir: join(root, 'project'),
      cliDir: join(repository, 'apps/cli'),
      hostDir: join(repository, 'apps/desktop-host'),
      dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
      release: {
        schemaVersion: 1,
        version: version(join(repository, 'apps/desktop/package.json')),
        pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
        nodeVersion: process.versions.node,
        hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      },
      target: 'mac-x64',
    })
    const cliPackage = join(project, 'node_modules/@yharness/cli')
    const hostPackage = join(project, 'node_modules/@yharness/desktop-host')
    expect(realpathSync(join(cliPackage, 'package.json')))
      .toBe(realpathSync(join(repository, 'apps/cli/package.json')))
    expect(realpathSync(join(hostPackage, 'lib/index.js'))).toBe(realpathSync(builtHost))
    expect(existsSync(join(project, 'node_modules/@deepseek-ai/dsh'))).toBe(false)

    // The real Host composition expects the development primary-runtime support tree.
    cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
    const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
    mkdirSync(nodeBin, { recursive: true })
    cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))

    const paths = resolveDesktopPaths(home)
    await new DesktopProjectManager(paths, { dsh: project }).applyRelease()
    const host = new DesktopHostProcess(process.execPath, project, paths.profile)
    try {
      const ready = await host.start()
      expect(new URL(ready.url).hostname).toBe('127.0.0.1')
    } finally {
      await host.stop()
    }
  }, 30_000)
})
