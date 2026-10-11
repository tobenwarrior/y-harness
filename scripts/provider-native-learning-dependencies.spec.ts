/** Provider entrypoint bundles do not require the optional Skill learning package. */
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { Rolldown } from 'tsdown'

const root = fileURLToPath(new URL('..', import.meta.url))

it.each(['packages/llm/llm-pi-ai', 'packages/subagent/subagent-claude-code'])('bundles %s with its optional Skill library unavailable', async (directory) => {
  const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    peerDependencies: Record<string, string>
  }
  const packages = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
  const bundle = await Rolldown.rolldown({
    input: join(root, directory, 'src/index.ts'),
    external: id => isBuiltin(id) || packages.some(name => name !== '@deepseek-ai/dsh-skill-library'
      && (id === name || id.startsWith(`${name}/`))),
    plugins: [{ name: 'absent-optional-learning-package', resolveId(id) {
      if (id === '@deepseek-ai/dsh-skill-library' || id.startsWith('@deepseek-ai/dsh-skill-library/')) {
        throw new Error(`Optional Skill library is unavailable: ${id}`)
      }
    } }],
  })
  try {
    const artifact = await bundle.generate({ format: 'esm' })
    expect(artifact.output.some(output => output.type === 'chunk' && output.isEntry)).toBe(true)
  } finally { await bundle.close() }
})
