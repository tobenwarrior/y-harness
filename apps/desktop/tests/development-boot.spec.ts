import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_CODEX_ENVIRONMENT_NAMES, desktopCodexNodePath, resolveDesktopCodexEnvironment } from '../src/codex-environment.ts'
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
    const primaryRuntime = join(root, 'runtime/primary-runtime')
    const nodeBin = join(primaryRuntime, 'dependencies/node/bin')
    mkdirSync(nodeBin, { recursive: true })
    cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))

    const paths = resolveDesktopPaths(home)
    await new DesktopProjectManager(paths, { dsh: project }).applyRelease()
    const codex = resolveDesktopCodexEnvironment({
      runtimeDir: project,
      trustedDevelopmentRoot: repository,
      dshHome: home,
      cwd: paths.profile,
      nodePath: desktopCodexNodePath(primaryRuntime),
    })
    expect(codex.reason).toBeUndefined()
    expect(codex.environment).toMatchObject({
      DSH_CODEX_NODE: desktopCodexNodePath(primaryRuntime),
      DSH_CODEX_HOME: join(home, 'native-codex'),
      DSH_CODEX_SHELL_HOME: join(home, 'native-codex-shell'),
      DSH_CODEX_CWD: paths.profile,
    })
    for (const name of DESKTOP_CODEX_ENVIRONMENT_NAMES) expect(codex.environment[name]).toEqual(expect.any(String))
    expect(realpathSync(codex.environment.DSH_CODEX_BINARY!)).toContain(realpathSync(repository))
    expect(codex.environment.DSH_CODEX_BINARY).toContain('@openai/codex')

    const hostEnvironment = {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_MODE: 'DISABLED',
      ...codex.environment,
    }
    const host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined, hostEnvironment)
    try {
      const ready = await host.start()
      expect(new URL(ready.url).hostname).toBe('127.0.0.1')

      // Exchange the one-time process token for the normal browser cookie before using the API.
      const authorization = await fetch(ready.url, { redirect: 'manual' })
      expect(authorization.status).toBe(303)
      const cookie = authorization.headers.get('set-cookie')?.split(';', 1)[0]
      expect(cookie).toBeDefined()
      const endpoint = new URL(ready.url)
      endpoint.pathname = '/api/codexBackend/getState'
      endpoint.search = ''
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookie! },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'development-boot-codex-state',
          method: 'codexBackend/getState',
          payload: { args: {} },
        }),
      })
      expect(response.status).toBe(200)
      const envelope = await response.json() as {
        readonly type: string
        readonly rpcId: string
        readonly result: { readonly ok: boolean; readonly value?: unknown }
      }
      expect(envelope).toMatchObject({
        type: 'server-response',
        rpcId: 'development-boot-codex-state',
        result: { ok: true, value: { enabled: false, connected: false, busy: false, running: 0, tiers: {} } },
      })
    } finally {
      await host.stop()
    }
  }, 30_000)
})
