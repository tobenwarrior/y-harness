/** Direct foreground SDK reads retain only safe project-relative observations. */
import { expect, it } from 'vitest'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'
import { ClaudeRootObservations } from '../src/root-observations.ts'
import { assistantBody } from './sdk-message-fixture.ts'

it.each([
  ['src/source.ts', 'src/source.ts'],
  ['/project/src/source.ts', 'src/source.ts'],
  ['src/../notes/guide.md', 'notes/guide.md'],
  ['../outside.ts', undefined],
  ['/project-sibling/source.ts', undefined],
  ['src/.hidden.ts', undefined],
  ['.cache/source.ts', undefined],
  ['src/credential.json', undefined],
  ['src/PASSWORD.md', undefined],
  ['auth/source.ts', undefined],
  ['src/image.png', undefined],
  [`src/${'a'.repeat(249)}.ts`, `src/${'a'.repeat(249)}.ts`],
  [`src/${'a'.repeat(250)}.ts`, undefined],
] as const)('admits only normalized project read paths: %s', (path, expected) => {
  const observed: SkillLearningNativeItem[] = []
  const reader = new ClaudeRootObservations('profile', 'session', 'send', 1, item => observed.push(item), '/project')
  reader.observe({
    type: 'assistant', uuid: '00000000-0000-4000-8000-000000000001', session_id: 'session', parent_tool_use_id: null,
    message: assistantBody([{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: path } }]),
  })
  expect(observed).toHaveLength(1)
  expect(observed[0]?.procedure).toEqual(expected === undefined ? undefined : { kind: 'read', path: expected })
})
