/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@yharness/cordis-plugin-include'
import { evaluate } from '@yharness/cordis-plugin-loader'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE !== 'DISABLED' && !(process.env.YH_TELEMETRY_OTLP_URL?.trim() || process.env.DSH_TELEMETRY_OTLP_URL?.trim())",
    })
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'",
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(manifest.dependencies).not.toHaveProperty('@yharness/subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@yharness/subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@yharness/web-fetch-http')
  })

  it('keeps telemetry opt-in and gives the canonical URL precedence over the legacy one', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const row = parsed.flatMap(patch => patch.insert ?? []).find(candidate => candidate.id === 'session-telemetry-otel')
    if (row === undefined) throw new Error('base patch must mount session telemetry')
    const disabled = row.disabled as { __jsExpr?: string } | undefined
    const exporter = row.config?.['exporter'] as { url?: { __jsExpr?: string } } | undefined
    if (disabled?.__jsExpr === undefined || exporter?.url?.__jsExpr === undefined) {
      throw new Error('base telemetry row must expose endpoint and disabled expressions')
    }
    const evaluateTelemetry = (env: Record<string, string | undefined>) => ({
      disabled: Boolean(evaluate({ process: { env } }, disabled.__jsExpr!)),
      endpoint: evaluate({ process: { env } }, exporter.url!.__jsExpr!),
    })
    expect(evaluateTelemetry({})).toEqual({ disabled: true, endpoint: undefined })
    expect(evaluateTelemetry({ YH_TELEMETRY_OTLP_URL: '   ' })).toEqual({ disabled: true, endpoint: undefined })
    expect(evaluateTelemetry({ DSH_TELEMETRY_OTLP_URL: '  https://legacy.example/v1/logs  ' })).toEqual({
      disabled: false, endpoint: 'https://legacy.example/v1/logs',
    })
    expect(evaluateTelemetry({
      YH_TELEMETRY_OTLP_URL: '  https://canonical.example/v1/logs  ',
      DSH_TELEMETRY_OTLP_URL: 'https://legacy.example/v1/logs',
    })).toEqual({ disabled: false, endpoint: 'https://canonical.example/v1/logs' })
    expect(evaluateTelemetry({ DSH_TELEMETRY_MODE: 'DISABLED' })).toEqual({ disabled: false, endpoint: undefined })
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
