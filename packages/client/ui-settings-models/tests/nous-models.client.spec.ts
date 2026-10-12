import { expect, it } from 'vitest'
import { countCopy, groupModels, modelLabel, starterModels, vendorOf } from '../src/client/nous-models.ts'
import type { NousModelView } from '@deepseek-ai/dsh-api-remotes/client'

const catalog: NousModelView[] = [
  { id: 'ling', name: 'inclusionAI: Ling 3.1 Flash', reasoning: false },
  { id: 'pareto', name: 'Pareto 26.10 Preview', reasoning: false },
  { id: 'sol-pro', name: 'OpenAI: GPT-6.1 Sol Pro', reasoning: true },
  { id: 'sol-batch', name: 'OpenAI: GPT-6.1 Sol (batch)', reasoning: true },
  { id: 'sonnet', name: 'Anthropic: Claude Sonnet 5.5', reasoning: true },
  { id: 'opus', name: 'Anthropic: Claude Opus 5.5', reasoning: true },
  { id: 'glm', name: 'Z.ai: GLM 5.3 Prime', reasoning: true },
  { id: 'qwen', name: 'Qwen: Qwen3.8 Max Prime', reasoning: true },
  { id: 'cohere', name: 'Cohere: Command A+', reasoning: false },
]

it('splits a vendor-prefixed name and leaves an unprefixed one whole', () => {
  expect(vendorOf('OpenAI: GPT-6.1 Sol')).toBe('OpenAI')
  expect(vendorOf('Pareto 26.10 Preview')).toBe('')
  expect(modelLabel('OpenAI: GPT-6.1 Sol')).toBe('GPT-6.1 Sol')
  expect(modelLabel('Pareto 26.10 Preview')).toBe('Pareto 26.10 Preview')
})

it('groups by vendor in first-appearance order without reordering members', () => {
  expect(groupModels(catalog).map(group => [group.vendor, group.models.length])).toEqual([
    ['inclusionAI', 1], ['', 1], ['OpenAI', 2], ['Anthropic', 2], ['Z.ai', 1], ['Qwen', 1], ['Cohere', 1],
  ])
})

it('publishes a small leading starter set and skips batch variants', () => {
  expect(starterModels(catalog)).toEqual(['ling', 'pareto', 'sol-pro', 'sonnet', 'opus'])
  expect(starterModels(catalog, 2)).toEqual(['ling', 'pareto'])
})

it('fills only the named count placeholders', () => {
  expect(countCopy('{enabled} of {total} models enabled', { enabled: 3, total: 118 }))
    .toBe('3 of 118 models enabled')
  expect(countCopy('{count} enabled', { count: 0 })).toBe('0 enabled')
  expect(countCopy('{count} enabled', { other: 1 })).toBe('{count} enabled')
})
