import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_YH_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_ENV,
  DSH_HOME_DIR_NAME,
  YH_HOME_ENV,
  YH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultYhHome,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  migrateLegacyHome,
  resolveYhHome,
  resolveDshHome,
  yhCachePath,
  yhHomeDisplay,
  yhHomePath,
} from '@yharness/home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(resolveYhHome(undefined, {}))
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.dsh')],
    ['', join(homedir(), '.dsh')],
    ['   ', join(homedir(), '.dsh')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Y Harness home compatibility', () => {
  it('uses YH_HOME before DSH_HOME for the canonical resolver', () => {
    const envHome = join(homedir(), 'env-yh')

    expect(resolveYhHome(undefined, { [YH_HOME_ENV]: '~/env-yh', [DSH_HOME_ENV]: '~/env-dsh' })).toBe(envHome)
    expect(resolveYhHome(undefined, { [DSH_HOME_ENV]: '~/env-dsh' })).toBe(join(homedir(), 'env-dsh'))
  })

  it('keeps the legacy resolver usable while accepting the canonical environment variable', () => {
    expect(resolveDshHome(undefined, { [YH_HOME_ENV]: '~/env-yh' })).toBe(join(homedir(), 'env-yh'))
  })

  it('routes old path helpers to the canonical default when both roots are new', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-legacy-helper-'))
    try {
      vi.stubEnv('HOME', root)
      vi.stubEnv(YH_HOME_ENV, '')
      vi.stubEnv(DSH_HOME_ENV, '')
      expect(resolveDshHome(undefined, {})).toBe(join(root, '.yharness'))
      expect(dshHomePath('profiles')).toBe(join(root, '.yharness', 'profiles'))
      expect(dshHomeDisplay(join(root, '.yharness'))).toBe('~/.yharness')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('derives canonical paths and symbolic displays from the Y Harness home', () => {
    vi.stubEnv(YH_HOME_ENV, defaultYhHome())
    expect(YH_HOME_DIR_NAME).toBe('.yharness')
    expect(DEFAULT_YH_HOME_DISPLAY).toBe('~/.yharness')
    expect(YH_HOME_ENV).toBe('YH_HOME')
    expect(defaultYhHome()).toBe(join(homedir(), '.yharness'))
    expect(yhHomePath('profiles', 'web')).toBe(join(defaultYhHome(), 'profiles', 'web'))
    expect(yhCachePath('models', 'index.json')).toBe(join(defaultYhHome(), 'cache', 'models', 'index.json'))
    expect(yhHomeDisplay(defaultYhHome())).toBe('~/.yharness')
    expect(yhHomeDisplay(join(homedir(), '.dsh'))).toBe('~/.dsh')
    expect(yhHomeDisplay('/some/other/root')).toBe('$YH_HOME')
  })

  it('keeps a populated legacy default when the canonical default is empty or partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-resolution-'))
    try {
      vi.stubEnv('HOME', root)
      const legacy = join(root, '.dsh')
      const canonical = join(root, '.yharness')
      await mkdir(join(legacy, 'profiles'), { recursive: true })
      await writeFile(join(legacy, 'profiles', 'web.json'), '{}\n')
      await mkdir(canonical)
      expect(resolveYhHome(undefined, {})).toBe(legacy)
      expect(resolveDshHome(undefined, {})).toBe(legacy)

      await mkdir(join(canonical, 'profiles'), { recursive: true })
      await writeFile(join(canonical, 'profiles', 'partial.json'), '{}\n')
      expect(resolveYhHome(undefined, {})).toBe(legacy)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses a populated canonical default when no legacy data exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-resolution-canonical-'))
    try {
      vi.stubEnv('HOME', root)
      const canonical = join(root, '.yharness')
      await mkdir(canonical)
      await writeFile(join(canonical, 'settings.json'), '{}\n')
      expect(resolveYhHome(undefined, {})).toBe(canonical)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies a legacy home without removing the source and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-'))
    const source = join(root, 'legacy')
    const target = join(root, 'canonical')
    try {
      await mkdir(join(source, 'profiles', 'web'), { recursive: true })
      await writeFile(join(source, 'profiles', 'web', 'package.json'), '{"name":"web"}\n')

      await expect(migrateLegacyHome({ source, target })).resolves.toEqual({
        source,
        target,
        status: 'migrated',
        copied: 3,
        unchanged: 0,
        conflicts: [],
      })
      await expect(readFile(join(target, 'profiles', 'web', 'package.json'), 'utf8')).resolves.toBe('{"name":"web"}\n')
      await expect(readFile(join(source, 'profiles', 'web', 'package.json'), 'utf8')).resolves.toBe('{"name":"web"}\n')

      await expect(migrateLegacyHome({ source, target })).resolves.toEqual({
        source,
        target,
        status: 'already-current',
        copied: 0,
        unchanged: 3,
        conflicts: [],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports conflicts without overwriting canonical data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-conflict-'))
    const source = join(root, 'legacy')
    const target = join(root, 'canonical')
    try {
      await mkdir(source, { recursive: true })
      await mkdir(target, { recursive: true })
      await writeFile(join(source, 'settings.json'), 'legacy\n')
      await writeFile(join(target, 'settings.json'), 'canonical\n')

      await expect(migrateLegacyHome({ source, target })).resolves.toEqual({
        source,
        target,
        status: 'conflicts',
        copied: 0,
        unchanged: 0,
        conflicts: [join(target, 'settings.json')],
      })
      await expect(readFile(join(target, 'settings.json'), 'utf8')).resolves.toBe('canonical\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies non-conflicting entries while retaining conflicting entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-mixed-'))
    const source = join(root, 'legacy')
    const target = join(root, 'canonical')
    try {
      await mkdir(join(source, 'profiles'), { recursive: true })
      await mkdir(target, { recursive: true })
      await writeFile(join(source, 'settings.json'), 'legacy\n')
      await writeFile(join(source, 'profiles', 'web.json'), '{}\n')
      await writeFile(join(target, 'settings.json'), 'canonical\n')

      await expect(migrateLegacyHome({ source, target })).resolves.toEqual({
        source,
        target,
        status: 'conflicts',
        copied: 2,
        unchanged: 0,
        conflicts: [join(target, 'settings.json')],
      })
      await expect(readFile(join(target, 'settings.json'), 'utf8')).resolves.toBe('canonical\n')
      await expect(readFile(join(target, 'profiles', 'web.json'), 'utf8')).resolves.toBe('{}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not create a destination when the explicit legacy source is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-missing-'))
    try {
      const source = join(root, 'missing')
      const target = join(root, 'canonical')
      await expect(migrateLegacyHome({ source, target })).resolves.toEqual({
        source,
        target,
        status: 'not-found',
        copied: 0,
        unchanged: 0,
        conflicts: [],
      })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses symlink roots instead of copying through them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-symlink-'))
    const source = join(root, 'legacy')
    const target = join(root, 'canonical')
    const destination = join(root, 'destination')
    try {
      await mkdir(source)
      await mkdir(destination)
      await symlink(destination, target, process.platform === 'win32' ? 'junction' : 'dir')
      await writeFile(join(source, 'settings.json'), 'legacy\n')

      await expect(migrateLegacyHome({ source, target })).rejects.toThrow('target is not a directory')
      await expect(readFile(join(destination, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a migration whose source and target are the same path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-same-'))
    try {
      await expect(migrateLegacyHome({ source: root, target: root })).rejects.toThrow('source and target must differ')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlink source instead of following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-source-symlink-'))
    const realSource = join(root, 'real-legacy')
    const source = join(root, 'legacy')
    const target = join(root, 'canonical')
    try {
      await mkdir(realSource)
      await symlink(realSource, source, process.platform === 'win32' ? 'junction' : 'dir')

      await expect(migrateLegacyHome({ source, target })).rejects.toThrow('source is not a directory')
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a migration whose homes are nested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-home-migration-nested-'))
    try {
      const source = join(root, 'legacy')
      await mkdir(source)
      await expect(migrateLegacyHome({ source, target: join(source, 'canonical') }))
        .rejects.toThrow('source and target must be separate directories')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
