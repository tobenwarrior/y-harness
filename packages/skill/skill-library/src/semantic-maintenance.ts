/** Deterministic maintenance has no model calls or task-success authority. */
import type { SkillLearningGenerator, SkillLearningProposal, SkillLearningValidator } from './types.ts'

/**
 * Delete exact duplicate standalone link entries within a complete References list.
 * @param content - exact instruction body.
 * @returns the original bytes except duplicate entries; non-link list content prevents reduction.
 */
export function reduceInstructionRedundancy(content: string): string {
  if (/^[ \t]/m.test(content) || /<!--|<\/?[a-z][^>]*>/i.test(content)) return content
  const lines = content.match(/[^\n]*(?:\n|$)/g)?.filter(line => line !== '') ?? []
  const kept: string[] = []
  let fence: { marker: string; length: number } | undefined
  const referenceEntry = /^[-*+] \[[^[\]\\`]+\]\([^\s()\\`]+\)$/
  const textOf = (line: string) => line.replace(/\r?\n$/, '')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''; const text = textOf(line)
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1]
    if (fence !== undefined) {
      kept.push(line)
      if (marker?.[0] === fence.marker && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(text)) fence = undefined
      continue
    }
    if (marker !== undefined) { fence = { marker: marker.charAt(0), length: marker.length }; kept.push(line); continue }
    kept.push(line)
    if (!/^#{1,6} References$/.test(text)) continue
    let end = index + 1
    while (end < lines.length && !/^#{1,6} /.test(textOf(lines[end] ?? ''))) end++
    const list = lines.slice(index + 1, end)
    // Continuation text can attach meaning to any preceding entry in this list.
    if (!list.every(entry => textOf(entry) === '' || referenceEntry.test(textOf(entry)))) continue
    const seen = new Set<string>()
    for (const entry of list) {
      const value = textOf(entry)
      if (value === '') kept.push(entry)
      else if (!seen.has(value)) { seen.add(value); kept.push(entry) }
    }
    index = end - 1
  }
  const result = kept.join('')
  const reduced = content.endsWith('\n') ? result : result.replace(/\r?\n$/, '')
  return !content.endsWith('\n') && reduced.endsWith('\n') ? content : reduced
}

/**
 * Recompute the complete mechanical invariant, independent of generator claims.
 * @param proposal - immutable complete source diff.
 * @returns whether every change has exact checkable redundancy or duplicate-retirement coverage.
 */
export function mechanicalMaintenanceValid(proposal: SkillLearningProposal): boolean {
  return proposal.changes.length > 0 && proposal.changes.every((change) => {
    if (change.kind === 'compress') return change.before !== change.after
      && Buffer.byteLength(change.after) < Buffer.byteLength(change.before)
      && reduceInstructionRedundancy(change.before) === change.after
    if (change.kind !== 'archive' || change.survivorId === undefined || change.survivorId === change.id
      || change.survivorContent === undefined || change.survivorResources === undefined
        || change.survivorReferences === undefined) return false
    return reduceInstructionRedundancy(change.before) === reduceInstructionRedundancy(change.survivorContent)
      && JSON.stringify(change.resources) === JSON.stringify(change.survivorResources)
      && JSON.stringify([...change.references].sort()) === JSON.stringify([...change.survivorReferences].sort())
      && !proposal.changes.some(other => other.kind === 'archive' && other.id === change.survivorId)
  })
}

/** Separate Host validator binds exact full-proposal hashes without claiming successful task use. */
export const maintenanceValidator: SkillLearningValidator = {
  id: 'instruction-redundancy-validator', trusted: true,
  validate: (proposal, signal) => Promise.resolve().then(() => {
    signal.throwIfAborted(); const valid = mechanicalMaintenanceValid(proposal)
    return { constraintsPreserved: valid, resourcesPreserved: valid, referenceImpactChecked: valid, survivorEquivalent: valid,
      findings: [
        valid ? 'Exact duplicate standalone entries in complete reference lists or equal bodies were checked mechanically; actions, other bytes and first-reference order are retained.' : 'This rewrite has no exact redundancy invariant; review is required.'],
      ...valid ? { receipt: { scope: 'instruction-redundancy-v1' as const, digest: proposal.digest,
        evidenceIds: proposal.evidenceIds, eventRefs: [],
        sourceHashes: proposal.changes.flatMap(change => [change.expectedHash, ...(
          change.survivorHash === undefined ? [] : [change.survivorHash])]).filter(Boolean),
        resourceHashes: proposal.changes.flatMap(change => [change.resourceHash, ...(
          change.survivorResourceHash === undefined ? [] : [change.survivorResourceHash])]) } } : {} }
  }),
}

/** Suggest only exact reference-list reduction and exact duplicate retirement. */
export const maintenanceGenerator: SkillLearningGenerator = {
  id: 'instruction-redundancy',
  generate: (input, signal) => Promise.resolve().then(() => {
    signal.throwIfAborted()
    const drafts = input.operation === 'compress' ? input.sources.flatMap((source) => {
      const content = reduceInstructionRedundancy(source.content)
      return content === source.content ? [] : [{ kind: 'compress' as const, id: source.item.id,
        name: source.item.name, description: source.item.description, content }]
    }) : input.operation === 'deduplicate' ? input.sources.flatMap((source, index) => {
      const survivor = input.sources.slice(0, index).find(other => reduceInstructionRedundancy(
        other.content) === reduceInstructionRedundancy(source.content)
        && JSON.stringify(other.resources) === JSON.stringify(source.resources))
      return survivor === undefined || source.item.ownership !== 'y-managed' || source.item.pinned ? []
        : [{ kind: 'archive' as const, id: source.item.id, name: source.item.name,
          description: source.item.description, content: '', survivorId: survivor.item.id }]
    }) : []
    return { drafts, uncertainty: [] }
  }),
}
