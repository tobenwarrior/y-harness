/** Durable uncertain suggestions with independently authorized semantic application. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { learningDraftSchema, learningEvidenceSchema, learningValidationSchema } from './learning-record.ts'
import { maintenanceGenerator, maintenanceValidator, mechanicalMaintenanceValid,
  reduceInstructionRedundancy } from './semantic-maintenance.ts'
import { nativeObservationInstructions, nativeObservationValidator } from './native-observation.ts'
import type { SkillLibrary } from './library.ts'
import type {
  SkillLibraryId,
  SkillLearningAvailability,
  SkillLearningApplyRequest,
  SkillLearningAutomaticRequest,
  SkillLearningChange,
  SkillLearningEvidence,
  SkillLearningEvidenceId,
  SkillLearningGenerator,
  SkillLearningListRequest,
  SkillLearningObservation,
  SkillLearningOptIn,
  SkillLearningPolicy,
  SkillLearningPolicyId,
  SkillLearningPolicyRequest,
  SkillLearningProposal,
  SkillLearningProposalId,
  SkillLearningProposalRequest,
  SkillLearningProposalSummary,
  SkillLearningProposeRequest,
  SkillLearningResource,
  SkillLearningSource,
  SkillLearningStatus,
  SkillLearningValidator,
  SkillLearningCleanupRequest,
  SkillLearningRevokePolicyRequest,
} from './types.ts'

/** Durable table access, supplied by the host domain owner. */
export interface SkillLearningStore<K extends string, V> {
  /**
   * Read or persist the selected durable learning value.
   * @param id - row identity.
   * @returns durable value when present.
   */
  get(id: K): V | undefined
  /**
   * Read or persist the selected durable learning value.
   * @returns current retained rows.
   */
  entries(): IterableIterator<[K, V]>
  /**
   * Read or persist the selected durable learning value.
   * @param id - row identity.
   * @param value - complete value.
   * @returns publication completion.
   */
  put(id: K, value: V): Promise<void>
}
/** Explicit request and resource bounds; semantic writes reuse the library's journal owner. */
export interface SkillLearningOptions {
  readonly library: SkillLibrary
  readonly evidence: SkillLearningStore<SkillLearningEvidenceId, SkillLearningEvidence>
  readonly proposals: SkillLearningStore<SkillLearningProposalId, SkillLearningProposal>
  readonly policies: SkillLearningStore<SkillLearningPolicyId, SkillLearningPolicy>
  readonly optIns: SkillLearningStore<SkillLibraryId, SkillLearningOptIn>
  readonly bodyBudgetBytes: number
  readonly maxInputBytes: number
  readonly maxSources: number
  readonly maxEvidence: number
  readonly maxResourceFiles: number
  readonly maxResourceBytes: number
  readonly maintenanceMaxOperations: number
  readonly maintenanceIntervalMs: number
  readonly operationTimeoutMs: number
  readonly automaticProjectSkillLimit: number
  readonly signal: AbortSignal
}

/** Owns immutable observations, full proposals and separate semantic consent. */
export class SkillLearning {
  private readonly generators = new Map<string, SkillLearningGenerator>()
  private readonly validators = new Map<string, SkillLearningValidator>()
  private readonly availability = new Map<string, SkillLearningAvailability>()
  private tail = Promise.resolve()
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly providerTasks = new Set<Promise<unknown>>()
  private readonly operationTasks = new Set<Promise<unknown>>()
  constructor(private readonly options: SkillLearningOptions) { }
  /**
   * Register a suggestion provider without evidence authority.
   * @param provider - suggestion capability without evidence authority.
   * @returns registration disposer.
   */
  registerGenerator(provider: SkillLearningGenerator): () => void {
    if (this.generators.has(provider.id)) throw new Error('duplicate learning generator')
    this.generators.set(provider.id, provider)
    return () => { if (this.generators.get(provider.id) === provider) this.generators.delete(provider.id) }
  }
  /**
   * Register an independently owned validation provider.
   * @param provider - independently owned check capability.
   * @returns registration disposer.
   */
  registerValidator(provider: SkillLearningValidator): () => void {
    if (this.validators.has(provider.id)) throw new Error('duplicate learning validator')
    this.validators.set(provider.id, provider)
    return () => { if (this.validators.get(provider.id) === provider) this.validators.delete(provider.id) }
  }
  /**
   * Publish observed route support.
   * @param projectId - registered project.
   * @param value - observed route support.
   */
  setAvailability(projectId: string, value: Omit<SkillLearningAvailability, 'projectId'>): void {
    this.availability.set(
      projectId,
      {
        projectId,
        ...value,
      },
    )
  }
  /**
   * Capture immutable host observations.
   * @param observation - host-captured task events and explicit check observations.
   * @returns immutable retained evidence.
   */
  recordEvidence(observation: SkillLearningObservation): Promise<SkillLearningEvidence> {
    return this.enqueue(async () => {
      this.assertOpen()
      const value = learningEvidenceSchema.parse({ ...observation, id: randomUUID(), createdAt: new Date().toISOString() })
      if (bytes(value) > this.options.maxInputBytes) throw new Error('learning evidence exceeds configured input budget')
      if (value.native !== undefined) {
        if (new Set(value.native.actions.map(action => action.itemId)).size !== value.native.actions.length
        || value.native.actions.some(action => !value.eventRefs.includes(action.startedEventRef)
          || !value.eventRefs.includes(action.settledEventRef))) throw new Error(
          'native actions require unique paired observed event identities')
        const native = value.native
        const prior = [...this.options.evidence.entries()].map(([, row]) => row).find(row => row.projectId === value.projectId
        && row.native?.provider === native.provider && row.native.connectionId === native.connectionId
        && row.native.sessionId === native.sessionId
        && (row.native.provider === 'codex' && native.provider === 'codex' && row.native.turnId === native.turnId
          || row.native.provider === 'claude-code' && native.provider === 'claude-code' && row.native.sendId === native.sendId))
        if (prior !== undefined) {
          const actionIdentity = (row: SkillLearningEvidence) => row.native?.actions.map(action => (
            { itemId: action.itemId, sourceMessageId: action.sourceMessageId, resultMessageId: action.resultMessageId,
              kind: action.kind, name: action.name, outcome: action.outcome,
              skillReadPath: action.skillReadPath, procedure: action.procedure }))
          if (JSON.stringify(actionIdentity(prior)) !== JSON.stringify(actionIdentity(
            value))) throw new Error('divergent native evidence replay is protected')
          return structuredClone(prior)
        }
      }
      const prior = value.native === undefined ? [...this.options.evidence.entries()].map(([, row]) => row)
        .find(row => row.native === undefined && row.projectId === value.projectId && row.sessionId === value.sessionId
        && row.eventRefs.at(-1) === value.eventRefs.at(-1))
        : undefined
      if (prior !== undefined) return structuredClone(prior)
      if (value.checks.some(check => !value.eventRefs.includes(check.eventRef))) throw new Error(
        'check must reference an observed source event')
      await this.options.evidence.put(value.id, value); return structuredClone(value)
    })
  }
  /**
   * Read recorded task observations.
   * @param request - project selector.
   * @returns retained observation records without success inference.
   */
  listEvidence(request: SkillLearningListRequest): readonly SkillLearningEvidence[] {
    return [...this.options.evidence.entries()].map(([, value]) => structuredClone(value))
      .filter(value => request.projectId === undefined
        || value.projectId === request.projectId)
  }
  /**
   * Read learning capabilities and separate consent.
   * @returns registered capabilities, approved policies and independent semantic consent.
   */
  status(): SkillLearningStatus {
    return {
      availability: [...this.availability.values()],
      generators: [...this.generators.keys()],
      validators: [...this.validators.values()].map(value => ({ id: value.id, trusted: value.trusted })),
      policies: [...this.options.policies.entries()].map(([, value]) => structuredClone(value)),
      optIns: [...this.options.optIns.entries()].map(([, value]) => structuredClone(value)),
      evidence: this.listEvidence({}),
    }
  }
  /**
   * Generate and retain a complete review suggestion.
   * @param request - selected meaningful task observations and local targets.
   * @param expiresAt - optional absolute deadline shared with the enclosing bounded maintenance pass.
   * @returns durable review-only suggestion.
   */
  propose(request: SkillLearningProposeRequest, expiresAt?: number): Promise<SkillLearningProposal> {
    return this.enqueue(async () => {
      this.assertOpen()
      if ((request.evidenceIds.length === 0 && (request.generatorId !== maintenanceGenerator.id || request.operation === 'learn'))
      || request.evidenceIds.length > this.options.maxEvidence) throw new Error('select bounded substantial completed task evidence')
      const evidence = request.evidenceIds.map((id) => {
        const value = this.options.evidence.get(id)
        if (value === undefined || value.projectId !== request.projectId || !value.completed || !value.substantial
        || value.observations.length === 0) throw new Error('substantial completed task observations are required')
        return structuredClone(value)
      })
      const generator = request.generatorId === undefined ? [...this.generators.values()].find(
        value => value.id !== maintenanceGenerator.id && value.id !== 'native-observation')
        : this.generators.get(request.generatorId)
      if (generator === undefined) throw new Error('no learning generator is available')
      const inventory = await this.options.library.list({ projectId: request.projectId })
      const project = inventory.projects.find(project => project.id === request.projectId)
      if (project === undefined) throw new Error('project is no longer registered')
      const catalog = inventory.items.filter(item => item.status !== 'archived'
      && (item.scope === 'shared'
        || item.projectIds.includes(request.projectId)))
      const queryWords = evidence.flatMap(value => value.task.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
      const automaticTargets = request.operation === 'learn'
        ? catalog.filter(item => item.ownership === 'y-managed' && !item.pinned && !item.capabilities.native
        && queryWords.some(word => (item.name + ' ' + item.description).toLowerCase().includes(word)))
          .slice(
            0,
            this.options.maxSources,
          )
          .map(item => item.id)
        : []
      const targets = [...new Set(request.targetIds ?? automaticTargets)]
      if (targets.length > this.options.maxSources) throw new Error('selected source count exceeds configured budget')
      const sources: SkillLearningSource[] = []
      for (const id of targets) {
        const item = catalog.find(item => item.id === id)
        if (item === undefined || item.capabilities.native) throw new Error('target is outside the project loading scope')
        sources.push(await this.source(id))
      }
      if (request.operation !== 'deduplicate'
      && sources.some(source => source.item.ownership !== 'y-managed'
        || source.item.pinned)) throw new Error('protected skill must be deliberately adopted before learning')
      const input = {
        projectId: request.projectId,
        operation: request.operation,
        evidence,
        catalog,
        sources,
        bodyBudgetBytes: this.options.bodyBudgetBytes,
      }
      if (bytes(input) > this.options.maxInputBytes) throw new Error(
        'learning input exceeds configured budget; select fewer observations or sources')
      const output = learningDraftSchema.parse(await this.runProvider(signal => generator.generate(freeze(input), signal), expiresAt))
      if (bytes(output) > this.options.maxInputBytes
      || output.drafts.length > this.options.maxSources) throw new Error('learning output exceeds configured budget')
      const changes: SkillLearningChange[] = []
      for (const draft of output.drafts) {
        if ((request.operation === 'learn' && draft.kind !== 'create' && draft.kind !== 'update')
        || (request.operation === 'compress' && draft.kind !== 'compress')
        || (request.operation === 'deduplicate'
          && draft.kind !== 'archive')) throw new Error('generator operation does not match the requested operation')
        if (draft.kind === 'create') {
          if (request.operation !== 'learn'
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name)) throw new Error('invalid new skill operation or name')
          if (catalog.some(item => similarMetadata(
            item.name,
            item.description,
            draft.name,
            draft.description,
          ))) throw new Error('existing relevant skill must be considered for update before creation')
          this.assertBody(draft.content)
          changes.push({
            kind: 'create',
            name: draft.name,
            description: draft.description,
            path: join(project.path, '.dsh', 'skills', draft.name, 'SKILL.md'),
            expectedHash: '',
            before: '',
            after: draft.content,
            resourceHash: digest([]),
            resources: [],
            constraints: [],
            references: [],
          })
          continue
        }
        const source = sources.find(source => source.item.id === draft.id)
        if (source === undefined
        || source.item.ownership !== 'y-managed'
        || source.item.pinned) throw new Error('generator selected an unadopted, pinned or unselected source')
        if (draft.name !== source.item.name
        || draft.description !== source.item.description) throw new Error('source metadata cannot be changed by body learning')
        if ((request.operation === 'compress' && draft.kind !== 'compress')
        || (request.operation === 'deduplicate'
          && draft.kind !== 'archive')) throw new Error('generator operation does not match the requested operation')
        let survivorHash: string | undefined
        let survivorResourceHash: string | undefined
        let survivor: SkillLearningSource | undefined
        if (draft.kind === 'archive') {
          survivor = sources.find(value => value.item.id === draft.survivorId)
          if (survivor === undefined
          || survivor.item.id === source.item.id
          || survivor.item.status !== 'active') throw new Error('archive requires a selected active survivor')
          survivorHash = survivor.item.contentHash; survivorResourceHash = survivor.resourceHash
        } else {
          this.assertBody(draft.content)
          if (draft.kind === 'compress'
          && Buffer.byteLength(draft.content) >= Buffer.byteLength(source.content)) throw new Error(
            'semantic compression must reduce body bytes')
        }
        changes.push({
          kind: draft.kind,
          id: source.item.id,
          name: source.item.name,
          description: source.item.description,
          path: source.item.path,
          expectedHash: source.item.contentHash,
          before: source.content,
          after: draft.kind === 'archive' ? '' : draft.content,
          resourceHash: source.resourceHash,
          resources: source.resources,
          constraints: source.constraints,
          references: draft.kind === 'archive' ? archiveReferences(source) : source.references,
          ...(draft.survivorId === undefined ? {} : { survivorId: draft.survivorId }),
          ...(survivorHash === undefined ? {} : {
            survivorHash,
            survivorResourceHash,
            survivorContent: survivor?.content,
            survivorResources: survivor?.resources,
            survivorReferences: survivor === undefined ? undefined : archiveReferences(survivor),
          }),
        })
      }
      if (changes.some(change => change.survivorId !== undefined
      && changes.some(other => other.kind === 'archive'
        && other.id === change.survivorId))) throw new Error('archive survivor must remain active after the complete proposal')
      if (new Set(changes.map(change => change.path)).size !== changes.length) throw new Error('proposal selects one source more than once')
      const immutable = {
        projectId: request.projectId,
        operation: request.operation,
        generator: generator.id,
        changes,
        evidenceIds: evidence.map(value => value.id),
        evidence,
      }
      const value: SkillLearningProposal = {
        ...immutable,
        id: brandString<SkillLearningProposalId>(randomUUID()),
        state: 'review',
        createdAt: new Date().toISOString(),
        digest: digest(immutable),
        uncertainty: [...output.uncertainty, ...(evidence.some(value => !verified(value))
          ? ['Task observations are unverified; completion and tool delivery do not establish successful skill use.']
          : [])],
        findings: [],
        appliedIds: [],
      }
      if (bytes(value) > this.options.maxInputBytes) throw new Error('complete proposal exceeds configured byte budget')
      if (value.changes.length > 0) await this.options.proposals.put(value.id, value); return structuredClone(value)
    })
  }
  /**
   * Read proposal summaries without source bodies.
   * @param request - project selector.
   * @returns summaries without source bodies.
   */
  list(request: SkillLearningListRequest): readonly SkillLearningProposalSummary[] {
    return [...this.options.proposals.entries()].map(([, value]) => value)


      .filter(value => request.projectId === undefined
        || value.projectId === request.projectId)

      .map(value => ({
        id: value.id,
        projectId: value.projectId,
        operation: value.operation,
        state: value.state,
        createdAt: value.createdAt,
        generator: value.generator,
        changeCount: value.changes.length,
        uncertainty: value.uncertainty,
        findings: value.findings,
        beforeBytes: value.changes.reduce((sum, change) => sum + Buffer.byteLength(change.before), 0),
        afterBytes: value.changes.reduce((sum, change) => sum + Buffer.byteLength(change.after), 0),
      }))
  }
  /**
   * Load one retained full proposal.
   * @param request - durable proposal identity.
   * @returns complete retained diff and evidence.
   */
  detail(request: SkillLearningProposalRequest): Promise<SkillLearningProposal> {
    return new Promise((resolve) => { resolve(structuredClone(this.requireProposal(request.proposalId))) })
  }
  /**
   * Retain explicit rejection without deleting history.
   * @param request - proposal to reject without deleting its history.
   * @returns retained rejected proposal.
   */
  reject(request: SkillLearningProposalRequest): Promise<SkillLearningProposal> {
    return this.enqueue(async () => {
      const value = this.requirePending(request.proposalId)
      const rejected: SkillLearningProposal = { ...value, state: 'rejected' }
      await this.options.proposals.put(value.id, rejected)
      return structuredClone(rejected)
    })
  }
  /**
   * Check a complete suggestion with an independent provider.
   * @param request - exact full suggestion.
   * @param expiresAt - optional absolute deadline shared with the enclosing bounded maintenance pass.
   * @returns independently checked retained proposal.
   */
  validate(request: SkillLearningProposalRequest, expiresAt?: number): Promise<SkillLearningProposal> {
    return this.enqueue(async () => {
      const proposal = this.requirePending(request.proposalId)
      const validator = request.validatorId === undefined
        ? [...this.validators.values()].find(value => value.id !== proposal.generator
          && value.id !== maintenanceValidator.id && value.id !== 'native-observation-validator')
        : this.validators.get(request.validatorId)
      if (validator === undefined) throw new Error('no independent learning validator is available')
      await this.preflight(proposal, false)
      const result = learningValidationSchema.parse(await this.runProvider(
        signal => validator.validate(freeze(structuredClone(proposal)), signal), expiresAt))
      const value: SkillLearningProposal = {
        ...proposal,
        state: 'validated',
        validation: {
          ...result,
          validatorId: validator.id,
          trusted: validator.trusted,
          independent: validator.id !== proposal.generator,
          digest: proposal.digest,
          checkedAt: new Date().toISOString(),
        },
        findings: [...proposal.findings, ...result.findings],
      }
      if (bytes(value) > this.options.maxInputBytes) throw new Error('complete validated proposal exceeds configured byte budget')
      await this.options.proposals.put(value.id, value); return structuredClone(value)
    })
  }
  /**
   * Approve semantic operations without enabling a file.
   * @param request - selected validator and permitted semantic operations.
   * @returns separately approved policy; no file is enabled.
   */
  approvePolicy(request: SkillLearningPolicyRequest): Promise<SkillLearningPolicy> {
    return this.enqueue(async () => {
      const validator = this.validators.get(request.validatorId)
      if (validator === undefined
        || !validator.trusted
        || request.operations.length === 0) throw new Error('policy requires an available trusted independent validator')
      if (request.operations.includes('create') && (request.projectId === undefined || request.generatorId !== 'native-observation'
        || request.validatorId !== 'native-observation-validator')) throw new Error(
        'automatic creation requires explicit project native observation policy')
      if (request.projectId !== undefined && !(await this.options.library.list({})).projects.some(
        project => project.id === request.projectId)) throw new Error('policy project is no longer registered')
      const value: SkillLearningPolicy = {
        id: brandString<SkillLearningPolicyId>(randomUUID()),
        approvedAt: new Date().toISOString(),
        validatorId: request.validatorId,
        operations: [...new Set(request.operations)],
        enabled: true,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.generatorId === undefined ? {} : { generatorId: request.generatorId }),
      }
      await this.options.policies.put(value.id, value)
      return structuredClone(value)
    })
  }
  /**
   * Enable or revoke per-file semantic consent.
   * @param request - unchanged unpinned managed file and explicit policy consent.
   * @returns semantic opt-in distinct from whitespace cleanup.
   */
  setAutomatic(request: SkillLearningAutomaticRequest): Promise<SkillLearningOptIn> {
    return this.enqueue(async () => {
      if (!request.enabled) {
        const prior = this.options.optIns.get(request.id)
        if (prior === undefined) throw new Error('no semantic opt-in exists')
        const revoked = { ...prior, enabled: false }
        await this.options.optIns.put(request.id, revoked)
        return structuredClone(revoked)
      }
      ;
      const source = await this.source(request.id)
      if (source.item.ownership !== 'y-managed' || source.item.pinned
        || source.item.status !== 'active' || source.item.shadowed || source.item.capabilities.native
        || source.item.contentHash !== request.expectedHash
        || this.options.policies.get(request.policyId) === undefined || this.options.policies.get(
        request.policyId)?.enabled === false) throw new Error(
        'semantic opt-in requires unchanged managed source and approved policy')
      const value: SkillLearningOptIn = {
        id: request.id,
        contentHash: request.expectedHash,
        policyId: request.policyId,
        enabled: request.enabled,
      }
      await this.options.optIns.put(value.id, value)
      return structuredClone(value)
    })
  }
  /**
   * Apply unchanged suggestions through the existing source journal.
   * @param request - explicit reviewed or independently authorized application.
   * @param expiresAt - optional absolute deadline shared with the enclosing bounded maintenance pass.
   * @returns durable application state and changed identities.
   */
  apply(request: SkillLearningApplyRequest, expiresAt?: number): Promise<SkillLearningProposal> {
    return this.enqueue(async () => {
      const deadline = Math.min(Date.now() + this.options.operationTimeoutMs, expiresAt ?? Number.POSITIVE_INFINITY)
      const checkDeadline = () => { this.assertOpen(); if (Date.now() > deadline) throw new Error(
        'semantic application exceeded configured time budget') }
      let proposal = await this.reconcile(this.requirePending(request.proposalId))
      if (request.mode === 'automatic'
        && proposal.changes.length > this.options.maintenanceMaxOperations) throw new Error(
        'semantic application exceeds configured operation budget')
      await this.preflight(proposal, true, request.mode === 'automatic')
      if (request.mode === 'automatic') await this.authorizeAutomatic(proposal)
      checkDeadline()
      proposal = { ...proposal, state: 'applying',
        applicationMode: proposal.applicationMode ?? request.mode }; await this.options.proposals.put(
        proposal.id, proposal)
      for (const change of proposal.changes) {
        if (await this.alreadyApplied(change, proposal)) {
          await this.settleConsent(change, proposal, proposal.applicationMode ?? request.mode)
          continue
        }
        const verify = async () => {
          await this.preflight(proposal, true, request.mode === 'automatic')
          if (request.mode === 'automatic') await this.authorizeAutomatic(proposal)
          checkDeadline()
        }
        let id: SkillLibraryId
        if (change.kind === 'create') {
          id = (await this.options.library.createLearning(
            { projectId: proposal.projectId, name: change.name, description: change.description,
              content: change.after, expectedPath: change.path },
            verify,
          )).item.id
        }
        else if (change.kind === 'archive') {
          if (change.id === undefined) throw new Error('missing archive identity')
          id = (await this.options.library.archiveLearning({ id: change.id, expectedHash: change.expectedHash }, verify)).item.id
        }
        else {
          if (change.id === undefined) throw new Error('missing source identity')
          id = (await this.options.library.reviseLearning(
            {
              id: change.id,
              expectedHash: change.expectedHash,
              content: change.after,
            },
            verify,
          )).item.id
        }
        proposal = {
          ...proposal,
          appliedIds: [...proposal.appliedIds, id],
        }
        await this.settleConsent(change, proposal, proposal.applicationMode ?? request.mode)
        await this.options.proposals.put(proposal.id, proposal)
      }
      proposal = {
        ...proposal,
        state: 'applied',
      }
      await this.options.proposals.put(
        proposal.id,
        proposal,
      )
      return structuredClone(proposal)
    })
  }
  /**
   * Abort provider admission and drain queued writes and underlying provider work.
   * @returns completion after admitted work settles, including providers that ignore cancellation.
   */
  async dispose(): Promise<void> {
    this.closed = true; this.lifetime.abort(new Error('skill learning is disposed'))
    await this.tail
    await Promise.allSettled([...this.operationTasks, ...this.providerTasks])
  }

  /**
   * Revoke policy authority while retaining proposal and revision history.
   * @param request - approved policy identity.
   * @returns retained policy with automatic authority disabled.
   */
  revokePolicy(request: SkillLearningRevokePolicyRequest): Promise<SkillLearningPolicy> {
    return this.enqueue(async () => {
      const policy = this.options.policies.get(request.policyId)
      if (policy === undefined) throw new Error('semantic policy is unavailable')
      const value = { ...policy, enabled: false }; await this.options.policies.put(value.id, value); return value
    })
  }

  /**
   * Run a bounded deterministic maintenance pass for current opted-in managed sources.
   * @param request - project/source selection; force requests an immediate pass and preserves every guard.
   * @returns complete durable proposals; only independently validated admitted changes are applied.
   */
  cleanup(request: SkillLearningCleanupRequest): Promise<readonly SkillLearningProposal[]> {
    return this.trackOperation(() => this.cleanupPass(request))
  }

  private async cleanupPass(request: SkillLearningCleanupRequest): Promise<readonly SkillLearningProposal[]> {
    this.assertOpen(); const deadline = Date.now() + this.options.operationTimeoutMs
    const inventory = await this.options.library.list({ ...(request.projectId === undefined ? {} : { projectId: request.projectId }) })
    this.assertOpen()
    if (request.ids !== undefined
      && request.ids.length > this.options.maintenanceMaxOperations) throw new Error(
      'cleanup selection exceeds configured operation budget')
    const items = inventory.items.filter((item) => {
      if (item.status !== 'active' || item.shadowed || item.ownership !== 'y-managed' || item.pinned || item.capabilities.native
        || (request.ids !== undefined && !request.ids.includes(item.id))) return false
      const consent = this.options.optIns.get(item.id)
      const policy = consent === undefined ? undefined : this.options.policies.get(consent.policyId)
      const projectId = request.projectId ?? policy?.projectId ?? item.projectIds[0] ?? (
        item.scope === 'shared' ? inventory.projects[0]?.id : undefined)
      return consent?.enabled === true && consent.contentHash === item.contentHash && policy?.enabled !== false
        && policy?.validatorId === maintenanceValidator.id && projectId !== undefined
          && inventory.projects.some(project => project.id === projectId)
        && (policy.projectId === undefined || policy.projectId === projectId)
        && (policy.generatorId === undefined || policy.generatorId === maintenanceGenerator.id)
        && policy.operations.some(operation => operation === 'compress' || operation === 'archive')
        && (request.force === true || consent.lastMaintenanceAt === undefined
          || Date.now() - Date.parse(consent.lastMaintenanceAt) >= this.options.maintenanceIntervalMs)
    }).sort((a, b) => {
      const checkedAt = (id: SkillLibraryId) => Date.parse(this.options.optIns.get(id)?.lastMaintenanceAt ?? '') || 0
      return checkedAt(a.id) - checkedAt(b.id) || a.path.localeCompare(b.path)
    }).slice(0, this.options.maintenanceMaxOperations)
    const results: SkillLearningProposal[] = []; let operations = 0
    for (const item of items) {
      if (operations >= this.options.maintenanceMaxOperations || Date.now() > deadline) break
      const consent = this.options.optIns.get(item.id)
      const policy = consent === undefined ? undefined : this.options.policies.get(consent.policyId)
      if (consent?.enabled !== true || consent.contentHash !== item.contentHash || policy?.enabled === false
        || policy?.validatorId !== maintenanceValidator.id) continue
      const projectId = request.projectId ?? policy.projectId ?? item.projectIds[0] ?? (
        item.scope === 'shared' ? inventory.projects[0]?.id : undefined)
      if (projectId === undefined || policy.projectId !== undefined && policy.projectId !== projectId) continue
      await this.enqueue(async () => {
        const current = this.options.optIns.get(item.id)
        if (current?.enabled === true && current.contentHash === item.contentHash
          && current.policyId === consent.policyId) await this.options.optIns.put(item.id, { ...current,
          lastMaintenanceAt: new Date().toISOString() })
      })
      const source = await this.source(item.id)
      let operation: 'compress' | 'deduplicate' | undefined
      let targets = [item.id]
      if (policy.operations.includes('archive')) {
        const survivors = inventory.items.filter(candidate => candidate.id !== item.id && candidate.status === 'active'
          && !candidate.shadowed && !candidate.capabilities.native && candidate.path.localeCompare(item.path) < 0
          && (candidate.scope === 'shared' || candidate.projectIds.includes(projectId))).sort((a, b) => a.path.localeCompare(b.path))
        const offset = survivors.findIndex(candidate => candidate.id === consent.lastMaintenanceSurvivorId) + 1
        for (const candidate of [...survivors.slice(offset), ...survivors.slice(0, offset)].slice(0, this.options.maxSources)) {
          const admitted = await this.enqueue(async () => {
            const current = this.options.optIns.get(item.id)
            if (current?.enabled !== true || current.contentHash !== item.contentHash || current.policyId !== consent.policyId) return false
            await this.options.optIns.put(item.id, { ...current, lastMaintenanceSurvivorId: candidate.id }); return true
          })
          if (!admitted || Date.now() > deadline) break
          const survivor = await this.source(candidate.id)
          if (reduceInstructionRedundancy(survivor.content) === reduceInstructionRedundancy(source.content)
            && JSON.stringify(survivor.resources) === JSON.stringify(source.resources)) {
            operation = 'deduplicate'; targets = [candidate.id, item.id]; break }
          if (Date.now() > deadline) break
        }
      }
      if (operation === undefined && policy.operations.includes('compress')
        && reduceInstructionRedundancy(source.content) !== source.content) operation = 'compress'
      if (operation === undefined || Date.now() > deadline) continue
      operations++
      const proposal = await this.propose({ projectId, operation, targetIds: targets, evidenceIds: [
      ], generatorId: maintenanceGenerator.id }, deadline)
      if (proposal.changes.length === 0) continue
      await this.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id }, deadline)
      if (Date.now() > deadline) break
      results.push(await this.apply({ proposalId: proposal.id, mode: 'automatic' }, deadline))
    }
    return results
  }

  /**
   * Suggest an exact native procedure and apply only under an explicitly approved project policy.
   * @param evidence - immutable retained live observation; caller data cannot replace its contents.
   * @returns retained review/applied proposal, or no change for an already recorded procedure.
   */
  autoLearnEvidence(evidence: SkillLearningEvidence): Promise<SkillLearningProposal | undefined> {
    return this.trackOperation(() => this.autoLearnPass(evidence))
  }

  private async autoLearnPass(evidence: SkillLearningEvidence): Promise<SkillLearningProposal | undefined> {
    this.assertOpen(); const deadline = Date.now() + this.options.operationTimeoutMs
    const recorded = this.options.evidence.get(evidence.id)
    if (recorded === undefined || digest(recorded) !== digest(evidence)) throw new Error(
      'native automatic learning requires unchanged retained evidence')
    const instructions = nativeObservationInstructions(recorded)
    if (instructions === undefined) return undefined
    const inventory = await this.options.library.list({ projectId: recorded.projectId })
    const targets = inventory.items.filter(item => item.status === 'active' && item.name === instructions.name).map(item => item.id)
    const proposal = await this.propose({ projectId: recorded.projectId, operation: 'learn',
      targetIds: targets, evidenceIds: [recorded.id], generatorId: 'native-observation' }, deadline)
    if (proposal.changes.length === 0) return undefined
    const policy = [...this.options.policies.entries()].map(([, value]) => value).find(value => value.enabled !== false
      && value.projectId === recorded.projectId && value.generatorId === proposal.generator
        && value.validatorId === 'native-observation-validator')
    if (policy === undefined) return proposal
    if (Date.now() > deadline) throw new Error('native automatic learning exceeded configured time budget')
    await this.validate({ proposalId: proposal.id, validatorId: policy.validatorId }, deadline)
    return this.apply({ proposalId: proposal.id, mode: 'automatic' }, deadline)
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { this.assertOpen() }
    catch (error: unknown) { return Promise.reject(error instanceof Error ? error : new Error('skill learning is disposed')) }
    const task = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.operationTasks.add(task)
    void task.then(() => { this.operationTasks.delete(task) }, () => { this.operationTasks.delete(task) })
    return task
  }

  private async runProvider<T>(operation: (signal: AbortSignal) => Promise<T>, expiresAt?: number): Promise<T> {
    this.assertOpen()
    if (this.providerTasks.size !== 0) throw new Error('previous learning provider work is still settling')
    const deadline = Math.min(Date.now() + this.options.operationTimeoutMs, expiresAt ?? Number.POSITIVE_INFINITY)
    const expired = new Error('learning provider exceeded configured time budget')
    if (Date.now() >= deadline) throw expired
    const controller = new AbortController(); const signal = AbortSignal.any([this.options.signal, this.lifetime.signal, controller.signal])
    const timer = setTimeout(() => { controller.abort(expired) }, Math.max(1, deadline - Date.now()))
    let abort: () => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('learning provider aborted')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    const task = Promise.resolve().then(() => operation(signal)); this.providerTasks.add(task)
    void task.then(() => { this.providerTasks.delete(task) }, () => { this.providerTasks.delete(task) })
    try {
      const result = await Promise.race([task, aborted])
      signal.throwIfAborted(); if (Date.now() > deadline) throw expired
      return result
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }
  private assertOpen(): void { this.options.signal.throwIfAborted(); if (this.closed) throw new Error('skill learning is disposed') }
  private assertBody(content: string): void {
    if (content.trim() === '' || Buffer.byteLength(content) > this.options.bodyBudgetBytes
      || /^---\r?\n/.test(content)) throw new Error(
      'instruction body exceeds configured budget or includes metadata; arbitrary truncation is prohibited')
  }
  private requireProposal(id: SkillLearningProposalId): SkillLearningProposal {
    const value = this.options.proposals.get(id)
    if (value === undefined) throw new Error('learning proposal is unavailable')
    return value
  }
  private requirePending(id: SkillLearningProposalId): SkillLearningProposal {
    const value = this.requireProposal(id)
    if (value.state === 'applied' || value.state === 'rejected') throw new Error('proposal is already applied or rejected')
    if (digest({
      projectId: value.projectId,
      operation: value.operation,
      generator: value.generator,
      changes: value.changes,
      evidenceIds: value.evidenceIds,
      evidence: value.evidence,
    }) !== value.digest) throw new Error('proposal digest changed')
    return value
  }
  private async source(id: SkillLibraryId): Promise<SkillLearningSource> {
    const value = await this.options.library.learningSource(id)
    const resources = await resourceManifest(
      value.bundlePath,
      value.item.path,
      this.options.maxResourceFiles,
      this.options.maxResourceBytes,
    )
    return {
      item: value.item,
      content: value.content,
      resources,
      resourceHash: digest(resources),
      constraints: constraints(value.content),
      references: [...new Set([...value.content.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)].map((match) => {
        const target = match[1]
        if (target === undefined) throw new Error('skill reference capture is unavailable')
        return target
      }))],
    }
  }
  private async preflight(proposal: SkillLearningProposal, applying: boolean, automatic = false): Promise<void> {
    const inventory = await this.options.library.list({})
    const project = inventory.projects.find(project => project.id === proposal.projectId)
    if (project === undefined) throw new Error('proposal project is no longer registered')
    for (const change of proposal.changes) {
      if (await this.alreadyApplied(change, proposal)) continue
      if (change.kind === 'create') {
        this.assertBody(change.after)
        if (change.path !== join(project.path, '.dsh', 'skills', change.name,
          'SKILL.md')) throw new Error('proposal destination changed with the registered project path')
        if (inventory.items.some(item => item.status !== 'archived'
          && (item.scope === 'shared'
            || item.projectIds.includes(proposal.projectId))
          && similarMetadata(
            item.name,
            item.description,
            change.name,
            change.description,
          ))) throw new Error('existing skill requires update before creation')
        if (automatic && proposal.generator === 'native-observation' && inventory.items.filter(item => item.status !== 'archived'
          && item.ownership === 'y-managed' && item.scope === 'project' && item.projectIds.includes(
          proposal.projectId)).length >= this.options.automaticProjectSkillLimit) throw new Error(
          'automatic project skill growth exceeds configured limit')
        continue
      }
      if (change.id === undefined) throw new Error('missing source identity')
      const source = await this.source(change.id)
      if (source.item.contentHash !== change.expectedHash
        || source.item.ownership !== 'y-managed'
        || source.item.pinned || source.item.status !== 'active' || source.item.shadowed
        || source.item.scope !== 'shared' && !source.item.projectIds.includes(proposal.projectId)
        || proposal.generator === 'native-observation'
          && source.item.scope !== 'project') throw new Error('source changed, left its project scope or is protected')
      if (source.resourceHash !== change.resourceHash) throw new Error('bundle resource changed; generate a new proposal')
      if (source.content !== change.before || source.item.name !== change.name || source.item.description !== change.description
        || source.item.path !== change.path || digest(source.resources) !== digest(change.resources)
        || !same(source.constraints, change.constraints)
        || !same(change.kind === 'archive' ? archiveReferences(source) : source.references,
          change.references)) throw new Error('source snapshot does not match the exact current instructions and resources')
      if (change.kind === 'archive') {
        if (change.survivorId === undefined) throw new Error('archive survivor is missing')
        const survivor = await this.source(change.survivorId)
        if (survivor.content !== change.survivorContent || digest(survivor.resources) !== digest(change.survivorResources)
          || !same(archiveReferences(survivor), change.survivorReferences ?? [])) throw new Error('archive survivor snapshot changed')
        if (survivor.item.contentHash !== change.survivorHash || survivor.resourceHash !== change.survivorResourceHash
          || survivor.item.status !== 'active'
          || survivor.item.shadowed
          || (source.item.invocation.modelInvocable && !survivor.item.invocation.modelInvocable)
          || (source.item.invocation.userInvocable
            && !survivor.item.invocation.userInvocable)) throw new Error('archive survivor changed or is unavailable')
        if ((source.item.scope === 'shared' && survivor.item.scope !== 'shared')
          || (survivor.item.scope !== 'shared'
            && !source.item.projectIds.every(id => survivor.item.projectIds.includes(
              id)))) throw new Error('archive survivor does not preserve project scope')
        if (applying && survivor.content !== change.before
          && !(proposal.validation?.trusted === true && proposal.validation.independent
            && this.validators.get(proposal.validation.validatorId)?.trusted === true
            && proposal.validation.digest === proposal.digest
            && proposal.validation.constraintsPreserved
            && proposal.validation.resourcesPreserved
            && proposal.validation.referenceImpactChecked
            && proposal.validation.survivorEquivalent
            && this.validReceipt(proposal))) throw new Error(
          'archive requires exact body equivalence or independently scoped survivor verification')
        if (!change.constraints.every(value => survivor.content.includes(value))
          || !change.references.every(value => archiveReferences(survivor).includes(value))
          || !change.resources.every(resource => survivor.resources.some(other => other.path === resource.path
            && other.hash === resource.hash))) throw new Error('archive survivor must preserve constraints, resources and references')
        if (inventory.items.some(item => item.id !== change.id
          && item.references.some(reference => reference.resolvedId === change.id
            || reference.target === change.name
            || reference.target === change.path))) throw new Error(
          'archive has incoming references requiring explicit repair before application')
      } else {
        this.assertBody(change.after)
        if (applying
          && !change.constraints.every(value => change.after.includes(value))) throw new Error(
          'permission constraints or literal code were removed')
        if (applying
          && !change.references.every(value => change.after.includes(value))) throw new Error('explicit resource reference was removed')
      }
    }
  }
  private async authorizeAutomatic(proposal: SkillLearningProposal): Promise<void> {
    const validation = proposal.validation
    const validator = validation === undefined
      ? undefined
      : this.validators.get(validation.validatorId)
    if (validation === undefined || !validation.trusted || !validation.independent || validator?.trusted !== true
      || validation.digest !== proposal.digest
      || !validation.constraintsPreserved
      || !validation.resourcesPreserved
      || !validation.referenceImpactChecked) throw new Error('automatic semantic application requires independent trusted validation')
    if (!this.validReceipt(proposal)) throw new Error(
      'automatic application requires scoped independent receipts and verified source checks')
    if (validation.receipt?.scope === 'native-observation-v1') {
      if (proposal.generator !== 'native-observation'
        || validator.id !== 'native-observation-validator') throw new Error(
        'native observation receipt requires the dedicated independent validator')
      const policy = this.projectPolicy(proposal)
      if (policy === undefined || proposal.changes.some(change => !policy.operations.includes(
        change.kind))) throw new Error('native automatic changes require explicit matching project policy')
      const result = learningValidationSchema.parse(await nativeObservationValidator.validate(
        freeze(structuredClone(proposal)), this.options.signal))
      if (!result.constraintsPreserved || !result.resourcesPreserved || !result.referenceImpactChecked
        || JSON.stringify(result.receipt) !== JSON.stringify(validation.receipt)) throw new Error(
        'native observation invariant or receipt changed')
    }
    /* Host registration assigns trust; generation cannot issue this receipt. */
    for (const change of proposal.changes) {
      if (change.id !== undefined && proposal.appliedIds.includes(change.id)) continue
      if (change.kind === 'create') {
        if (this.projectPolicy(proposal)?.operations.includes('create') !== true
          || validation.receipt?.scope !== 'native-observation-v1') throw new Error(
          'new skills require explicit project policy and native observation validation')
        continue
      }
      if (change.id === undefined) throw new Error('missing managed source identity')
      const consent = this.options.optIns.get(change.id)
      const policy = consent === undefined
        ? undefined
        : this.options.policies.get(consent.policyId)
      if (consent?.enabled !== true || consent.contentHash !== change.expectedHash
        || policy?.validatorId !== validation.validatorId
        || policy.enabled === false || (policy.projectId !== undefined && policy.projectId !== proposal.projectId)
        || (policy.generatorId !== undefined && policy.generatorId !== proposal.generator)
        || !policy.operations.includes(change.kind)) throw new Error(
        'automatic application requires separate per-file semantic opt-in and approved policy')
      if (change.kind === 'archive'
        && !validation.survivorEquivalent) throw new Error('semantic archive requires reviewed survivor equivalence')
    }
    if (validation.receipt?.scope === 'full-proposal') throw new Error(
      'automatic application requires a known independently checkable transformation; generic claims remain reviewable')
  }
  private validReceipt(proposal: SkillLearningProposal): boolean {
    const validation = proposal.validation; const receipt = validation?.receipt
    const receiptScope: { readonly scope: string } | undefined = receipt
    if (receipt === undefined || receipt.digest !== proposal.digest
      || !same(receipt.evidenceIds, proposal.evidenceIds)
      || !same(
        receipt.sourceHashes,
        proposal.changes.flatMap(change => [change.expectedHash, ...(change.survivorHash === undefined ? [] : [change.survivorHash])])
          .filter(Boolean),
      )
      || !same(
        receipt.resourceHashes,
        proposal.changes.flatMap(change => [change.resourceHash, ...(change.survivorResourceHash === undefined
          ? []
          : [change.survivorResourceHash])]),
      )
    ) return false
    if (receiptScope?.scope === 'instruction-redundancy-v1') return validation?.validatorId === maintenanceValidator.id
      && mechanicalMaintenanceValid(proposal) && receipt.eventRefs.length === 0
    if (receiptScope?.scope === 'native-observation-v1') return proposal.evidence.length > 0
      && receipt.eventRefs.length > 0 && receipt.eventRefs.every(ref => proposal.evidence.some(value => value.eventRefs.includes(ref)))
    if (receiptScope?.scope !== 'full-proposal' || receipt.eventRefs.length === 0 || !proposal.evidence.every(verified)
      || !receipt.eventRefs.every(ref => proposal.evidence.some(value => value.checks.some(check => check.eventRef === ref
        && check.result === 'passed'
        && check.scope === 'task-verification'
        && check.issuer !== undefined
        && check.issuer !== proposal.generator
        && check.inputHash !== undefined
        && (check.inputHash === proposal.digest || receipt.sourceHashes.includes(check.inputHash))
        && check.outputHash !== undefined)))) return false
    return true
  }
  private projectPolicy(proposal: SkillLearningProposal): SkillLearningPolicy | undefined {
    return [...this.options.policies.entries()].map(([, policy]) => policy).find(policy => policy.enabled !== false
      && policy.projectId === proposal.projectId && policy.generatorId === proposal.generator
      && policy.validatorId === proposal.validation?.validatorId && proposal.changes.every(
      change => policy.operations.includes(change.kind)))
  }
  private async settleConsent(change: SkillLearningChange, proposal: SkillLearningProposal, mode: 'automatic' | 'reviewed'): Promise<void> {
    const path = change.id === undefined ? await realpath(change.path) : undefined
    const id = change.id ?? (await this.options.library.list({})).items.find(
      item => item.path === path && proposal.appliedIds.includes(item.id))?.id
    if (id === undefined) return
    const consent = this.options.optIns.get(id)
    if (change.kind === 'archive') {
      if (consent !== undefined) await this.options.optIns.put(id, { ...consent, enabled: false })
      return
    }
    if (mode !== 'automatic') return
    const source = await this.options.library.learningSource(id)
    if (source.item.ownership !== 'y-managed' || source.content !== change.after) return
    if (consent !== undefined) await this.options.optIns.put(id, { ...consent, contentHash: source.item.contentHash })
    else if (change.kind === 'create') {
      const policy = this.projectPolicy(proposal)
      if (policy?.operations.includes('create') === true) await this.options.optIns.put(id, { id,
        contentHash: source.item.contentHash, policyId: policy.id, enabled: true })
    }
  }
  private async alreadyApplied(change: SkillLearningChange, proposal: SkillLearningProposal): Promise<boolean> {
    if (change.id !== undefined) return proposal.appliedIds.includes(change.id)
    if (change.kind !== 'create' || proposal.appliedIds.length === 0) return false
    const path = await realpath(change.path).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return ''
      throw error
    })
    return (await this.options.library.list({})).items.some(item => item.path === path && proposal.appliedIds.includes(item.id))
  }
  private async reconcile(proposal: SkillLearningProposal): Promise<SkillLearningProposal> {
    if (proposal.state !== 'applying') return proposal
    const inventory = await this.options.library.list({}); const ids = new Set(proposal.appliedIds)
    for (const change of proposal.changes) {
      if (await this.alreadyApplied(change, proposal)) continue
      const path = await realpath(change.path).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      })
      const item = inventory.items.find(item => change.id === undefined ? item.path === path : item.id === change.id)
      if (item === undefined) continue
      const detail = await this.options.library.detail({ id: item.id })
      if (change.kind === 'archive'
        ? item.status === 'archived' && item.contentHash === change.expectedHash
        : item.ownership === 'y-managed' && (await this.options.library.learningSource(item.id)).content === change.after
        && (change.kind === 'create'
          || detail.revisions.some(revision => revision.reason === 'learning' && revision.beforeHash === change.expectedHash
            && revision.afterHash === item.contentHash))) ids.add(item.id)
    }
    const value = { ...proposal, appliedIds: [...ids] }; await this.options.proposals.put(value.id, value); return value
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.tail.then(() => {
      this.assertOpen()
      return operation()
    })
    this.tail = result.then(() => { }, () => { })
    return result
  }
}
/** Archive references preserve resolved targets; equivalent bundled resources may relocate. */
function archiveReferences(source: SkillLearningSource): readonly string[] {
  return [...new Set(source.item.references.map((reference) => {
    if (reference.resolvedId !== undefined) return `skill:${reference.resolvedId}`
    if (reference.kind === 'file') {
      const path = relative(dirname(source.item.path), reference.target).replaceAll('\\', '/')
      if (source.resources.some(resource => resource.path === path)) return `bundle:${path}`
    }
    return `${reference.kind}:${reference.target}`
  }))].sort()
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)) }
function verified(value: SkillLearningEvidence): boolean {
  return value.checks.length > 0
    && value.checks.every(check => check.result === 'passed')
}
function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length
    && [...a].sort()
      .every((value, index) => value === [...b].sort()[index])
}
function similarMetadata(aName: string, aDescription: string, bName: string, bDescription: string): boolean {
  if (aName.toLowerCase() === bName.toLowerCase()) return true
  const a = new Set((aName + ' ' + aDescription).toLowerCase().match(/[a-z0-9]+/g))
  const b = [...new Set((bName + ' ' + bDescription).toLowerCase().match(/[a-z0-9]+/g))]
  return b.length > 1 && b.filter(word => a.has(word)).length >= Math.ceil(b.length * 0.75)
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  ;
  return value
}
function constraints(content: string): readonly string[] {
  const pattern = new RegExp([
    '\\b(?:must',
    'never',
    'required',
    'only',
    'approval',
    'permission',
    'credential',
    'secret',
    'constraint)\\b',
    'do not',
    "don't",
    '\u5fc5\u987b',
    '\u4e0d\u5f97',
    '\u7981\u6b62',
    '\u8bf7\u52ff',
    '\u4e0d\u8981',
    '\u4ec5',
    '\u53ea\u80fd',
    '\u5e94\u5f53',
    '\u9700\u8981',
    '\u6279\u51c6',
    '\u8bb8\u53ef',
    '\u51ed\u8bc1',
    '\u5bc6\u94a5',
    '\u5bc6\u7801',
  ].join('|'), 'i')
  const result = content.split('\n')
    .filter(line => pattern.test(line))
  let fence: {
    marker: string
    length: number
    lines: string[]
  } | undefined
  let indented: string[] = []
  for (const line of content.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      fence.lines.push(line)
      if (marker !== undefined && marker[0] === fence.marker && marker.length >= fence.length
        && /^\s*(?:`+|~+)\s*$/.test(line)) {
        result.push(fence.lines.join('\n'))
        fence = undefined
      }
      continue
    }
    if (marker !== undefined) {
      fence = { marker: marker.charAt(0), length: marker.length, lines: [line] }
      continue
    }
    if (/^(?: {4}|\t)/.test(line) || (indented.length > 0 && line.trim() === '')) indented.push(line)
    else if (indented.length > 0) {
      result.push(indented.join('\n').trimEnd())
      indented = []
    }
  }
  if (fence !== undefined) result.push(fence.lines.join('\n'))
  if (indented.length > 0) result.push(indented.join('\n').trimEnd())
  return [...new Set(result)]
}

async function resourceManifest(
  bundle: string,
  instruction: string,
  maxFiles: number,
  maxBytes: number): Promise<readonly SkillLearningResource[]> {
  const result: SkillLearningResource[] = []; const canonicalRoot = await realpath(bundle); let total = 0; let inspected = 0
  async function visit(path: string): Promise<void> {
    if (++inspected > maxFiles * 4) throw new Error('bundle entries exceed configured verification budget')
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('linked bundle resources are protected from learning')
    if (info.isDirectory()) {
      for await (const entry of await opendir(path)) {
        if (entry.name !== '.skill-library-archive') await visit(join(path, entry.name))
      }
      return
    }
    if (!info.isFile() || path === instruction) return
    if (result.length >= maxFiles || total + info.size > maxBytes) throw new Error('bundle resources exceed configured verification budget')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino) throw new Error(
        'bundle resource changed during inspection')
      const hash = createHash('sha256'); const buffer = Buffer.alloc(Math.min(65536, maxBytes - total + 1)); let size = 0
      while (true) {
        const read = await handle.read(buffer, 0, buffer.length, null)
        if (read.bytesRead === 0) break
        size += read.bytesRead
        if (total + size > maxBytes) throw new Error('bundle resources exceed configured verification budget')
        hash.update(buffer.subarray(0, read.bytesRead))
      }
      const after = await handle.stat()
      if (after.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) throw new Error('bundle resource changed during inspection')
      total += size; result.push({ path: relative(canonicalRoot, path).replaceAll('\\', '/'), hash: hash.digest('hex'), bytes: size })
    } finally { await handle.close() }
  }
  await visit(canonicalRoot); return result.sort((a, b) => a.path.localeCompare(b.path))
}
