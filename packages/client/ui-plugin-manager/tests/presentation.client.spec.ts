/** Package descriptions retain the text published by their owner. */
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packageText, rowText } from '../src/client/presentation.ts'

afterEach(() => { vi.unstubAllEnvs() })

const resolveText: Parameters<typeof packageText>[1] = text => typeof text === 'string' ? text : text.alt ?? text.en

describe('package description display', () => {
  it('retains current first-party product copy after locale resolution without changing metadata or titles', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const name = '@yharness/agent'
    const raw = 'Y Harness-backed tools for Y Harness; DeepSeek Account; MIT copyright DeepSeek'
    const meta = {
      title: 'Y Harness technical title',
      description: { en: 'Unused English description', alt: raw },
    }
    expect(packageText({ name, meta }, resolveText)).toEqual({ title: meta.title, description: raw, beta: false })
    expect(rowText({ moduleName: `${name}/entry`, meta }, resolveText)).toEqual({ title: meta.title, description: raw })
    expect(meta.description.alt).toBe(raw)
  })

  it.each(['@acme/dsh-agent', '@yharness/cordis', '@yharness/cordis-plugin-hmr', '@yharness/agent', 'dsh-agent'])('preserves upstream, provider and legal description %s', (name) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const description = 'Upstream DeepSeek Harness credit; Y Harness; MIT licence'
    const meta = { description }
    expect(packageText({ name, meta }, resolveText)).toMatchObject({ title: name, description })
    expect(rowText({ moduleName: name, meta }, resolveText)).toEqual({ title: name, description })
  })

  it('keeps unselected locale text and technical title fallbacks', () => {
    const name = '@yharness/agent'
    for (const description of [
      'Y Harness extension; DeepSeek provider; MIT licence',
      { en: 'Y Harness tools', alt: 'Alternate-language tool description' },
    ]) {
      const resolved = resolveText(description)
      expect(packageText({ name, meta: { description } }, resolveText)).toEqual({ title: name, description: resolved, beta: false })
      expect(rowText({ moduleName: name, meta: { description } }, resolveText)).toEqual({ title: name, description: resolved })
    }
    expect(packageText({ name }, resolveText)).toEqual({ title: name, description: undefined, beta: false })
    expect(rowText({ moduleName: name, meta: { description: { en: '' } } }, resolveText)).toEqual({ title: name, description: undefined })
    expect(packageText({ name, meta: { description: { en: 'Y Harness fallback' } } }, resolveText).description).toBe('Y Harness fallback')
    expect(packageText({ name: '@yharness/experimental-inspector' }, resolveText).beta).toBe(true)
    expect(packageText({ name: '@deepseek-ai/dsh-experimental-inspector' }, resolveText).beta).toBe(true)
    expect(packageText({ name: '@acme/dsh-experimental-inspector' }, resolveText).beta).toBe(false)
  })

  it('keeps current first-party manifest descriptions unchanged', () => {
    const root = fileURLToPath(new URL('../../../..', import.meta.url))
    const selected = globSync('packages/*/*/package.json', { cwd: root })
      .map(path => JSON.parse(readFileSync(join(root, path), 'utf8')) as { name: string; description?: string })
      .filter(meta => meta.name.startsWith('@yharness/') && meta.description?.includes('Y Harness'))
    expect(selected.length).toBeGreaterThan(0)
    for (const meta of selected) {
      const raw = meta.description!
      expect(packageText({ name: meta.name, meta: { description: raw } }, resolveText).description, meta.name).toBe(raw)
      expect(rowText({ moduleName: meta.name, meta: { description: raw } }, resolveText).description, meta.name).toBe(raw)
      expect(meta.description).toBe(raw)
    }
  })
})
