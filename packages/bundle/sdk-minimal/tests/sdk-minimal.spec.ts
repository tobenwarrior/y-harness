/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@yharness/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@yharness/sdk-app'],
      ['sdk-jsonrpc-server', '@yharness/sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@yharness/deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@yharness/session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@yharness/plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@yharness/llm-deepseek-api-key'],
      ['sandbox', '@yharness/sandbox-local'],
      ['session-projection', '@yharness/session-projection'],
      ['sandbox-policy', '@yharness/sandbox-policy'],
      ['subprocess', '@yharness/subprocess-local'],
      ['pty', '@yharness/terminal'],
      ['terminal-bash', '@yharness/terminal-bash'],
      ['terminal-pwsh', '@yharness/terminal-bash'],
      ['timer', '@yharness/cordis-plugin-timer'],
      ['llm', '@yharness/llm'],
      ['session', '@yharness/session'],
      ['session-title', '@yharness/session-title'],
      ['system-prompt', '@yharness/system-prompt'],
      ['tools', '@yharness/tools'],
      ['mcp-resources', '@yharness/mcp-resources'],
      ['agent', '@yharness/agent'],
      ['llm-retry', '@yharness/llm-retry'],
      ['jobs', '@yharness/jobs-local'],
      ['agent-loop', '@yharness/agent-loop'],
      ['persistent-bash', '@yharness/tool-bash-persistent'],
      ['persistent-pwsh', '@yharness/tool-pwsh-persistent'],
      ['sessions', '@yharness/session-persistence-jsonl'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
