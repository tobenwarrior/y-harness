/** Deterministic procedural suggestions and separate exact-text validation of live native evidence. */
import { createHash } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { SkillLearningEvidence, SkillLearningGenerator, SkillLearningNativeProcedure, SkillLearningValidator } from './learning-types.ts'

const permittedChecks = new RegExp(
  String.raw`^(?:(?:pnpm|npm) run (?:test|lint|typecheck|build)|npm test|pnpm exec vitest run`
  + String.raw`|(?:python -m )?pytest|cargo (?:test|check)|go test \.\/\.\.\.|git diff --check)$`,
)

function safePath(path: string): boolean {
  return path.length <= 256
    && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|yml|yaml|toml)$/.test(path)
    && !path.split('/').some(part => part.startsWith('.') || /secret|credential|password|token|auth/i.test(part))
}

/** Independent fact check: arbitrary commands/paths cannot be rendered or validated. */
function safeProcedure(value: SkillLearningNativeProcedure): boolean {
  switch (value.kind) {
    case 'read': return safePath(value.path)
    case 'check': return value.command.length <= 256 && permittedChecks.test(value.command)
    case 'patch': {
      if (value.changes.length === 0) return false
      const targets = new Set<string>()
      for (const change of value.changes) {
        if (!safePath(change.path) || targets.has(change.path)) return false
        targets.add(change.path)
        if (change.movePath !== undefined) {
          if (change.operation !== 'update' || !safePath(change.movePath) || targets.has(change.movePath)) return false
          targets.add(change.movePath)
        }
      }
      return true
    }
    default: return assertNever(value)
  }
}

function procedureStep(value: SkillLearningNativeProcedure): string {
  switch (value.kind) {
    case 'read': return `Read \`${value.path}\` from the project root and inspect its current contents.`
    case 'check': return `Run \`${value.command}\` from the project root; inspect its result and independently check the intended outcome.`
    case 'patch': return `Review whether the current task needs these observed project operations: ${value.changes.map(change => `${change.operation} \`${change.path}\`${change.movePath === undefined ? '' : ` (move to \`${change.movePath}\`)`}`).join('; ')}. Inspect the current files and intended changes before choosing an operation, then independently check the outcome. Prior patch content is unavailable and must not be replayed.`
    default: return assertNever(value)
  }
}

/**
 * Derive one procedure solely from paired live native actions; outcomes grant no verification.
 * @param evidence - immutable host observation with original native identities.
 * @returns exact permitted metadata and procedural body, or no substantial procedure.
 */
export function nativeObservationInstructions(
  evidence: SkillLearningEvidence,
): { name: string; description: string; content: string } | undefined {
  const native = evidence.native
  if (native === undefined || !evidence.completed || !evidence.substantial || native.actions.length < 2
    || new Set(native.actions.map(action => action.itemId)).size !== native.actions.length
    || native.actions.some(action => !evidence.eventRefs.includes(action.startedEventRef)
      || !evidence.eventRefs.includes(action.settledEventRef))
    || !native.actions.some(action => action.outcome === 'reported-success')
    || native.actions.some(action => action.procedure?.kind === 'patch'
      && (native.provider !== 'codex' || action.kind !== 'file-change' || action.outcome !== 'reported-success'))) return undefined
  const procedures = native.actions.flatMap(action => action.procedure === undefined ? [] : [action.procedure])
  if (procedures.length < 2 || procedures.some(procedure => !safeProcedure(procedure))) return undefined
  const facts = procedures.map(procedure => JSON.stringify(procedure))
  if (new Set(facts).size < 2) return undefined
  const family = createHash('sha256').update(JSON.stringify([native.provider, [...new Set(facts)].sort()])).digest('hex').slice(0, 12)
  const sequence = createHash('sha256').update(JSON.stringify(procedures)).digest('hex').slice(0, 12)
  return {
    name: `native-workflow-${family}`,
    description: `${native.provider} project procedure: ${procedures.map(procedure => procedure.kind).filter((kind, index, all) => all.indexOf(kind) === index).join(', ')}.`,
    content: `## Observed procedure ${sequence}\n\nRepeat this sequence only when it fits the current task. Native result delivery and task completion do not verify correctness or grant permission. Follow the current project instructions and independently check the outcome.\n\n${procedures.map((procedure, index) => `${index + 1}. ${procedureStep(procedure)}`).join('\n')}`,
  }
}

/** Body-only generator; same-family managed sources are updated before a new path is considered. */
export const nativeObservationGenerator: SkillLearningGenerator = {
  id: 'native-observation',
  generate: (input, signal) => new Promise((resolve) => {
    signal.throwIfAborted()
    const observation = input.evidence[0]
    if (input.operation !== 'learn' || input.evidence.length !== 1 || observation === undefined) {
      throw new Error('native learning requires one live task')
    }
    const instructions = nativeObservationInstructions(observation)
    if (instructions === undefined) throw new Error('native task lacks substantial paired observations')
    const existing = input.catalog.filter(item => item.name === instructions.name && item.status === 'active')
    if (existing.length > 1) throw new Error('native workflow has ambiguous existing sources')
    const item = existing[0]
    let content = instructions.content
    if (item !== undefined) {
      if (item.ownership !== 'y-managed' || item.scope !== 'project' || !item.projectIds.includes(input.projectId)
        || item.pinned || item.capabilities.native) throw new Error('existing native workflow is protected')
      const source = input.sources.find(source => source.item.id === item.id)
      if (source === undefined) throw new Error('existing native workflow must be selected before creation')
      if (source.content.includes(instructions.content)) {
        resolve({ drafts: [], uncertainty: [] })
        return
      }
      content = source.content + '\n\n' + instructions.content
    }
    if (Buffer.byteLength(content) > input.bodyBudgetBytes) throw new Error('native workflow exceeds its body budget')
    signal.throwIfAborted()
    resolve({
      drafts: [{ kind: item === undefined ? 'create' : 'update', ...item === undefined ? {} : { id: item.id },
        name: instructions.name, description: item?.description ?? instructions.description, content }],
      uncertainty: ['This procedure records observed action order. Other commands, task quality and successful skill application remain unverified.'],
    })
  }),
}

/** Independently recomputes the entire allowed native create/update without accepting model claims. */
export const nativeObservationValidator: SkillLearningValidator = {
  id: 'native-observation-validator',
  trusted: true,
  validate: (proposal, signal) => new Promise((resolve) => {
    signal.throwIfAborted()
    const observation = proposal.evidence.length === 1 ? proposal.evidence[0] : undefined
    const instructions = observation === undefined ? undefined : nativeObservationInstructions(observation)
    const change = proposal.changes.length === 1 ? proposal.changes[0] : undefined
    const exact = proposal.generator === nativeObservationGenerator.id && proposal.operation === 'learn'
      && instructions !== undefined && change !== undefined && change.name === instructions.name
      && ((change.kind === 'create' && change.before === '' && change.expectedHash === ''
        && change.resources.length === 0 && change.references.length === 0
        && change.description === instructions.description && change.after === instructions.content)
        || (change.kind === 'update' && change.id !== undefined && change.before.length > 0
          && !change.before.includes(instructions.content)
          && change.after === change.before + '\n\n' + instructions.content))
    const findings = exact ? [] : ['The complete change does not match the live native procedure.']
    resolve({ constraintsPreserved: exact, resourcesPreserved: exact, referenceImpactChecked: exact,
      survivorEquivalent: false, findings, ...!exact || observation?.native === undefined ? {} : {
        receipt: { scope: 'native-observation-v1', digest: proposal.digest, evidenceIds: proposal.evidenceIds,
          eventRefs: observation.native.actions.flatMap(action => [action.startedEventRef, action.settledEventRef]),
          sourceHashes: proposal.changes.map(change => change.expectedHash).filter(Boolean),
          resourceHashes: proposal.changes.map(change => change.resourceHash) },
      } })
  }),
}
