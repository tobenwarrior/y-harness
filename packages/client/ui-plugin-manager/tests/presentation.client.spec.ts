/** First-party package descriptions use the public product name only when displayed. */
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packageText, rowText } from '../src/client/presentation.ts'

afterEach(() => { vi.unstubAllEnvs() })

const resolveText: Parameters<typeof packageText>[1] = text => typeof text === 'string' ? text : text.zh ?? text.en

describe('first-party description display', () => {
  it.each([undefined, 'Y Harness', 'Atlas', '星图 $& $`'])('projects %s after locale resolution without changing metadata or titles', (displayName) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', displayName)
    const name = '@deepseek-ai/dsh-agent'
    const raw = 'DeepSeek-backed tools for DeepSeek Harness; DeepSeek Account; MIT copyright DeepSeek'
    const meta = {
      title: 'DeepSeek Harness technical title',
      description: { en: 'Unused English description', zh: raw },
    }
    const expected = `DeepSeek-backed tools for ${displayName ?? 'DeepSeek Harness'}; DeepSeek Account; MIT copyright DeepSeek`
    expect(packageText({ name, meta }, resolveText)).toEqual({ title: meta.title, description: expected, beta: false })
    expect(rowText({ moduleName: `${name}/entry`, meta }, resolveText)).toEqual({ title: meta.title, description: expected })
    expect(meta.description.zh).toBe(raw)
  })

  it.each(['@acme/dsh-agent', '@deepseek-ai/cordis', '@deepseek-ai/cordis-plugin-hmr', 'dsh-agent'])('preserves upstream and third-party description %s', (name) => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const description = 'Upstream DeepSeek Harness credit; Y Harness; MIT licence'
    const meta = { description }
    expect(packageText({ name, meta }, resolveText)).toMatchObject({ title: name, description })
    expect(rowText({ moduleName: name, meta }, resolveText)).toEqual({ title: name, description })
  })

  it('keeps unselected locale text and technical title fallbacks', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const name = '@deepseek-ai/dsh-agent'
    for (const description of [
      'Y Harness extension; DeepSeek provider; MIT licence',
      { en: 'DeepSeek Harness tools', zh: '当前语言的工具说明' },
    ]) {
      const resolved = resolveText(description)
      expect(packageText({ name, meta: { description } }, resolveText)).toEqual({ title: name, description: resolved, beta: false })
      expect(rowText({ moduleName: name, meta: { description } }, resolveText)).toEqual({ title: name, description: resolved })
    }
    expect(packageText({ name }, resolveText)).toEqual({ title: name, description: undefined, beta: false })
    expect(rowText({ moduleName: name, meta: { description: { en: '' } } }, resolveText)).toEqual({ title: name, description: undefined })
    expect(packageText({ name, meta: { description: { en: 'DeepSeek Harness fallback' } } }, resolveText).description).toBe('Atlas fallback')
    expect(packageText({ name: '@deepseek-ai/dsh-experimental-inspector' }, resolveText).beta).toBe(true)
  })

  it('projects current first-party manifest descriptions without rewriting published metadata', () => {
    vi.stubEnv('DSH_CLIENT_DISPLAY_NAME', 'Atlas')
    const root = fileURLToPath(new URL('../../../..', import.meta.url))
    const selected = globSync('packages/*/*/package.json', { cwd: root })
      .map(path => JSON.parse(readFileSync(join(root, path), 'utf8')) as { name: string; description?: string })
      .filter(meta => meta.name.startsWith('@deepseek-ai/dsh-') && meta.description?.includes('DeepSeek Harness'))
    expect(selected.length).toBeGreaterThan(0)
    for (const meta of selected) {
      const raw = meta.description!
      const expected = raw.replaceAll('DeepSeek Harness', 'Atlas')
      expect(packageText({ name: meta.name, meta: { description: raw } }, resolveText).description, meta.name).toBe(expected)
      expect(rowText({ moduleName: meta.name, meta: { description: raw } }, resolveText).description, meta.name).toBe(expected)
      expect(meta.description).toBe(raw)
    }
  })
})
