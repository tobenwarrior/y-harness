import { describe, expect, it } from 'vitest'
import { reduceInstructionRedundancy, mechanicalMaintenanceValid } from '../src/semantic-maintenance.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillLearningProposal, SkillLearningProposalId, SkillLibraryId } from '../src/types.ts'

function proposal(before: string, after: string): SkillLearningProposal {
  return { id: brandString<SkillLearningProposalId>('p'), projectId: 'project',
    operation: 'compress', state: 'review', createdAt: '', generator: 'instruction-redundancy',
    digest: 'digest', evidenceIds: [], evidence: [], uncertainty: [], findings: [], appliedIds: [],
    changes: [{ kind: 'compress', id: brandString<SkillLibraryId>('skill'), name: 'example',
      description: 'Example', path: '/skill', expectedHash: 'source', before, after, resources: [],
      resourceHash: 'resources', constraints: [], references: [] }] }
}
describe('independent instruction redundancy maintenance', () => {
  it('removes repeated exact reference entries within an explicit References list', () => {
    const before = '# Release\n\n1. Build\n2. Deploy\n\n## References\n- [Guide](resource.md)\n- [Guide](resource.md)'
    const after = '# Release\n\n1. Build\n2. Deploy\n\n## References\n- [Guide](resource.md)'
    expect(reduceInstructionRedundancy(before)).toBe(after)
    expect(mechanicalMaintenanceValid(proposal(before, after))).toBe(true)
  })
  it('retains action multiplicity and denies automatic action deletion even for adjacent exact text', () => {
    const before = '- Press the pump button.\n- Press the pump button.'
    const after = '- Press the pump button.'
    expect(reduceInstructionRedundancy(before)).toBe(before)
    expect(mechanicalMaintenanceValid(proposal(before, after))).toBe(false)
  })
  it('retains literal code, ordered instructions, indentation, links and contextual repeats', () => {
    const before = '```md\n- Check results.\n- Check results.\n```\n\n1. Check results.\n2. Check results.\n\n- Run `test`.\n- Run `test`.\n\n- Check results.\n\n# Another task\n- Check results.\n    - Check results.\n\n[Guide](resource.md)'
    expect(reduceInstructionRedundancy(before)).toBe(before)
    expect(reduceInstructionRedundancy('<pre>\n- Check results.\n- Check results.\n</pre>')).toBe(
      '<pre>\n- Check results.\n- Check results.\n</pre>')
    expect(reduceInstructionRedundancy(
      '- Check results.\n- Check results.\n    Retain the nested procedure.')).toBe(
      '- Check results.\n- Check results.\n    Retain the nested procedure.')
  })
  it('retains duplicate headings whose list item has distinct continuation content', () => {
    expect(reduceInstructionRedundancy('- [ ] Check results.\n- [ ] Check results.')).toBe('- [ ] Check results.\n- [ ] Check results.')
    for (const continuation of ['  Before rollout request approval.',
      '   Before rollout request approval.', '  - Request approval.', 'Before rollout request approval.',
      '\nBefore rollout request approval.']) {
      const before = '- Check results.\n- Check results.\n' + continuation
      expect(reduceInstructionRedundancy(before)).toBe(before)
    }
  })
  it('rejects uncertain rephrasing, reordering and whitespace-only transformation', () => {
    const orderedActions = '- Run migration\n- Check result\n- Run migration\n'
    expect(reduceInstructionRedundancy(orderedActions)).toBe(orderedActions)
    expect(mechanicalMaintenanceValid(proposal(
      '- Check results.\n- Request approval.\n- Check results.', '- Request approval.\n- Check results.'))).toBe(false)
    expect(mechanicalMaintenanceValid(proposal('Check results carefully.', 'Check results.'))).toBe(false)
    expect(mechanicalMaintenanceValid(proposal('Check results.\n\n', 'Check results.'))).toBe(false)
  })
  it('requires exact survivor resources and references for duplicate retirement', () => {
    const original = proposal('# References\n- [Guide](resource.md)\n- [Guide](resource.md)', '# References\n- [Guide](resource.md)')
    const change = original.changes[0]!
    const archive: SkillLearningProposal = { ...original, operation: 'deduplicate', changes: [{
      ...change, kind: 'archive', after: '', survivorId: brandString<SkillLibraryId>('survivor'),
      survivorHash: 'survivor-hash', survivorResourceHash: 'resources',
      survivorContent: '# References\n- [Guide](resource.md)', survivorResources: [], survivorReferences: [] }] }
    expect(mechanicalMaintenanceValid(archive)).toBe(true)
    expect(mechanicalMaintenanceValid({ ...archive, changes: [{ ...archive.changes[0]!,
      survivorContent: '- Different workflow.' }] })).toBe(false)
    expect(mechanicalMaintenanceValid({ ...archive, changes: [{ ...archive.changes[0]!,
      survivorResources: [{ path: 'run.sh', hash: 'different', bytes: 1 }] }] })).toBe(false)
  })
})
