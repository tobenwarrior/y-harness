import OTel from '@yharness/otel'
/** Shipped Desktop collection rows stay disabled, including with collector env vars. */
import { fileURLToPath } from 'node:url'
import { Context } from '@yharness/cordis'
import Loader from '@yharness/cordis-plugin-loader'
import { loadOverlayPatches } from '@yharness/app-boot'
import * as Telemetry from '@yharness/host-product-telemetry-otel'
import Analytics from '@yharness/client-product-analytics'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

it('keeps the Desktop analytics rows and services disabled with collector variables set', async () => {
  vi.stubEnv('DSH_CLIENT_VERSION', 'test-version')
  vi.stubEnv('YH_TELEMETRY_OTLP_URL', 'https://collector.example/v1/logs')
  vi.stubEnv('DSH_TELEMETRY_OTLP_URL', 'https://legacy.example/v1/logs')
  vi.stubEnv('DSH_PRODUCT_ANALYTICS_OTLP_URL', 'https://analytics.example/v1/logs')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: 'desktop', dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(OTel)
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.telemetry = Telemetry
  ctx.loader.builtins.analytics = Analytics
  const rows = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-product-telemetry' || row.id === 'product-analytics')
  expect(rows).toHaveLength(2)
  expect(rows.every(row => row.disabled === true)).toBe(true)
  expect(rows.every(row => row.config === undefined)).toBe(true)
  const entries = rows.map(row => ({ ...row, name: row.id === 'desktop-product-telemetry' ? 'cordis:telemetry' : 'cordis:analytics' }))
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  expect(ctx.loader.resolve('desktop-product-telemetry').disabled).toBe(true)
  expect(ctx.loader.resolve('product-analytics').disabled).toBe(true)
  expect(ctx.get('productTelemetry')).toBeUndefined()
  expect(ctx.get('productAnalytics')).toBeUndefined()
})

it.each(['desktop', 'web'])('does not enable product collection for the %s profile when a collector is configured', async (profile) => {
  vi.stubEnv('DSH_CLIENT_VERSION', 'test-version')
  vi.stubEnv('YH_TELEMETRY_OTLP_URL', 'https://collector.example/v1/logs')
  vi.stubEnv('DSH_TELEMETRY_OTLP_URL', 'https://legacy.example/v1/logs')
  vi.stubEnv('DSH_PRODUCT_ANALYTICS_OTLP_URL', 'https://analytics.example/v1/logs')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  await ctx.plugin(OTel)
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.telemetry = Telemetry
  ctx.loader.builtins.analytics = Analytics
  const rows = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-product-telemetry' || row.id === 'product-analytics')
  const entries = rows.map(row => ({ ...row, name: row.id === 'desktop-product-telemetry' ? 'cordis:telemetry' : 'cordis:analytics' }))
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  expect(ctx.loader.resolve('desktop-product-telemetry').disabled).toBe(true)
  expect(ctx.loader.resolve('product-analytics').disabled).toBe(true)
  expect(ctx.get('productTelemetry')).toBeUndefined()
  expect(ctx.get('productAnalytics')).toBeUndefined()
})
