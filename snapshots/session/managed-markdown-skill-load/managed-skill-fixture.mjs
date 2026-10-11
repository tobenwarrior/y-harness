import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'managed-markdown-skill-load-fixture'
export const inject = ['skillLibrary', 'llm']

/** Prepare the managed source through its public host service before the recorded turn. */
export function apply(ctx) {
  let instructions
  let selectedTopic
  let requests = 0
  ctx.on('llm/stream', async function* (options, next) {
    requests++
    assert.ok(instructions, 'the reviewed split is prepared before the first model request')
    const visible = JSON.stringify(options.messages)
    assert.ok(!visible.includes('DETAIL_CANARY_REVIEW'), 'the unselected topic never enters a model request')
    const tools = options.messages.filter(message => message.role === 'tool')
    const root = tools.find(message => message.toolCallId === 'call_skill_load')
    if (requests > 1) {
      assert.ok(root?.content.some(block => block.type === 'text' && block.text.includes(instructions)),
        'continuing requests contain the selected short generated instructions')
    }
    const topic = tools.find(message => message.toolCallId === 'call_topic_read')
    if (topic === undefined) {
      assert.ok(!visible.includes('DETAIL_CANARY'), 'the root-only request contains no detailed source')
      assert.ok(requests < 3, 'the final request requires the selected ordinary file read')
    } else {
      assert.equal(requests, 3, 'only the selected topic is read before the final response')
      assert.ok(topic.content.some(block => block.type === 'text' && block.text.includes(selectedTopic)),
        'the final model request receives every line of the selected topic through the read tool')
      assert.ok(visible.includes('DETAIL_CANARY_SETUP_001') && visible.includes('DETAIL_CANARY_SETUP_054'),
        'the selected topic detail reaches the final request')
    }
    yield* next()
  })
  ctx.on('agent/created', async () => {
    const entry = join(process.cwd(), 'skills/managed-demo/SKILL.md')
    const original = await readFile(entry, 'utf8')
    const inventory = await ctx.skillLibrary.list({})
    const item = inventory.items.find(item => item.name === 'managed-demo')
    assert.ok(item, 'the seeded directory skill is discoverable')
    await ctx.skillLibrary.adopt({ id: item.id, expectedHash: item.contentHash })
    const proposal = await ctx.skillLibrary.previewCleanup({ ids: [item.id] })
    assert.equal(proposal.changes.length, 1, 'the oversized managed source receives one reviewed split')
    const change = proposal.changes[0]
    assert.equal(change.before, original)
    assert.ok(change.markdownGeneration, 'cleanup publishes a complete topic generation')
    const fragments = change.markdownGeneration.files.filter(file => file.path.startsWith('source/'))
      .sort((a, b) => a.path.localeCompare(b.path))
    assert.equal(fragments.map(file => file.content).join(''), original, 'all original bytes remain in source fragments')
    assert.ok(change.after.split('\n').length < 40, 'the selected generated entry stays short')
    assert.ok(!change.after.includes('DETAIL_CANARY'), 'detailed source stays out of the entry loaded by the model')
    const applied = await ctx.skillLibrary.applyCleanup({ proposalId: proposal.id })
    assert.deepEqual(applied.revised, [item.id])
    assert.equal(await readFile(entry, 'utf8'), change.after)
    instructions = change.after.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
    const topic = change.markdownGeneration.files.find(file => file.path === 'topics/001-setup.md')
    assert.ok(topic, 'the Setup link has a complete generated topic')
    selectedTopic = topic.content.split('\n').slice(0, -1).map((line, index) => `${index + 1}: ${line}`).join('\n')
  })
}
