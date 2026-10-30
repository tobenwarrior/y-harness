import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { onTestFinished } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@yharness/app-boot'
import ConfigEditor from '@yharness/config-editor'
import Settings from '@yharness/settings'
import Hmr from '@yharness/hmr'
import Timer from '@yharness/cordis-plugin-timer'
import z from '@yharness/schemastery'
import ProviderConfigSync from '../src/index.ts'

const Probe = { Config: z.object({ providers: z.dict(z.object({
  displayName: z.string(), apiKeyEnv: z.string(), api: z.string(), baseURL: z.string(),
  headers: z.dict(z.string()), models: z.array(z.object({ id: z.string().required(), name: z.string() })),
})).default({}).volatile() }), apply() {} }

export async function fixture(name: string, sharedPath?: string, providers: Record<string, unknown> = {}, disabled = false, hmr = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'provider-sync-loader-')))
  const dir = join(home, 'profiles', name)
  onTestFinished(() =>{  rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle'); mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"sync-fixture"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'llm-pi-ai', name: 'cordis:probe', disabled, config: { providers: {} } },
    { id: 'provider-config-sync', name: 'cordis:sync', config: sharedPath === undefined ? {} : { sharedPath } },
  ] }]))
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: 'llm-pi-ai', config: { providers } }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name, startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('sync-test', join(dir, 'cordis.yml'), readProfilePatches('sync-test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, probe: Probe, sync: ProviderConfigSync })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  if (hmr) {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  return { ctx, home, profile, values: () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')?.user as { providers?: Record<string, unknown> } | undefined }
}
