/** Host skill management Remote service; existing instruction files stay authoritative. */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import { createRegistryInventory } from './registry-inventory.ts'
import { SkillLibrary } from './library.ts'
import { skillLibraryDomain } from './record.ts'
import { SkillLearning } from './learning.ts'
import { skillLearningDomain } from './learning-record.ts'
import { installSkillLearningRuntime } from './learning-runtime.ts'
import { SequentialSkillLearning } from './sequential-learning.ts'
import { DecisionAdvisory } from './decision.ts'
import { decisionDomain } from './decision-record.ts'
import type { DecisionBounds } from './decision.ts'
import type { DecisionCapabilities, DecisionConfiguration, DecisionConfigureRequest, DecisionRoute, DecisionStatus } from './decision-types.ts'
import { maintenanceGenerator, maintenanceValidator } from './semantic-maintenance.ts'

import type {
  NativeSkillLibraryProvider,
  SkillCleanupProposal,
  SkillLibraryApplyRequest,
  SkillLibraryApplyValue,
  SkillLibraryAutomaticRequest,
  SkillLibraryCleanupRequest,
  SkillLibraryDetail,
  SkillLibraryHashRequest,
  SkillLibraryId,
  SkillLibraryIdRequest,
  SkillLibraryItem,
  SkillLibraryItemValue,
  SkillLibraryList,
  SkillLibraryListRequest,
  SkillLibraryPinRequest,
  SkillLibraryRetrieveRequest,
  SkillLibraryRollbackRequest,
  SkillLearningGenerator,
  SkillLearningValidator,
  SkillLearningObservation,
  SkillLearningEvidence,
  SkillLearningProposeRequest,
  SkillLearningProposal,
  SkillLearningListRequest,
  SkillLearningProposalSummary,
  SkillLearningProposalRequest,
  SkillLearningApplyRequest,
  SkillLearningPolicyRequest,
  SkillLearningPolicy,
  SkillLearningAutomaticRequest,
  SkillLearningOptIn,
  SkillLearningStatus,
  SkillLearningAvailability,
  SkillLearningCleanupRequest,
  SkillLearningRevokePolicyRequest,
  SkillSequentialTaskSource,
  SkillSequentialTaskHooks,
} from './types.ts'

export type * from './types.ts'

/** Filesystem discovery and bounded local maintenance policy. */
export interface Config {
  /** Separate optional Decision budgets; configuration starts disabled and never changes the chat model. */
  decision?: Partial<DecisionBounds>
  /** Skill home override, identical to the filesystem provider's setting. */
  dshHome?: string
  /** Shared agent skill home override. */
  agentsHome?: string
  /** Explicit additional roots, matching the configured filesystem skill source. */
  customSkillDirs?: string[]
  /** Bundled vendor skill root, always protected from source management. */
  bundledSkillDir?: string
  /** Maximum instruction-body bytes before a reviewed rewrite is required. */
  bodyBudgetBytes?: number
  /** Upper bound on metadata candidates returned by focused retrieval. */
  retrievalLimit?: number
  /** Maximum retained cleanup previews; old previews expire rather than apply silently. */
  proposalLimit?: number
  /** Poll interval for conservative cleanup of individually opted-in managed skills; zero disables polling. */
  automaticMaintenanceIntervalMs?: number
  /** Complete framed input/output limit for semantic suggestion providers. */
  learningMaxInputBytes?: number
  /** Maximum selected source bodies for one proposal. */
  learningMaxSources?: number
  /** Maximum recorded observations used in one proposal. */
  learningMaxEvidence?: number
  /** Maximum resource files independently hashed in one selected bundle. */
  learningMaxResourceFiles?: number
  /** Maximum bytes hashed for one selected bundle's resources. */
  learningMaxResourceBytes?: number
  /** Maximum automatic semantic changes admitted in one maintenance pass. */
  maintenanceMaxOperations?: number
  /** Wall-clock admission deadline for a semantic pass or source application. */
  learningOperationTimeoutMs?: number
  /** Maximum current project-managed skills admitted by native automatic creation. */
  automaticProjectSkillLimit?: number
  /** Maximum paired current-native items retained for one sequential task. */
  sequentialLearningMaxItems?: number
  /** Maximum sanitized human-task bytes retained in sequential evidence. */
  sequentialLearningMaxTaskBytes?: number
}
type ResolvedConfig = Config & {
  decision: DecisionBounds
  bodyBudgetBytes: number
  retrievalLimit: number
  proposalLimit: number
  automaticMaintenanceIntervalMs: number
  learningMaxInputBytes: number
  learningMaxSources: number
  learningMaxEvidence: number
  learningMaxResourceFiles: number
  learningMaxResourceBytes: number
  maintenanceMaxOperations: number
  learningOperationTimeoutMs: number
  automaticProjectSkillLimit: number
  sequentialLearningMaxItems: number
  sequentialLearningMaxTaskBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { /** Project skill inventory and reversible managed maintenance. */ skillLibrary: SkillLibraryController }
}

/** Owns the `skillLibrary` Remote namespace and local native-provider registrations. */
export class SkillLibraryController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'storageDomain']
  static Config: z<Config, ResolvedConfig> = z.object({
    decision: z.object({
      maxInputBytes: z.natural().min(1).max(2147483647).default(16000),
      maxInputTokens: z.natural().min(1).max(2147483647).default(16000),
      maxOutputBytes: z.natural().min(1).max(2147483647).default(8000),
      maxOutputTokens: z.natural().min(1).max(2147483647).default(512),
      maxOutputChunks: z.natural().min(1).max(2147483647).default(1024),
      timeoutMs: z.natural().min(1).max(2147483647).default(10000),
      maxPending: z.natural().min(1).max(2147483647).default(2),
      maxRecords: z.natural().min(1).max(2147483647).default(100),
    }).default({}),
    dshHome: z.string(),
    agentsHome: z.string(),
    customSkillDirs: z.array(z.string()).default([]),
    bundledSkillDir: z.string(),
    bodyBudgetBytes: z.natural().min(1).default(12000),
    retrievalLimit: z.natural().min(1).default(8),
    proposalLimit: z.natural().min(1).default(20),
    automaticMaintenanceIntervalMs: z.natural().default(600000),
    learningMaxInputBytes: z.natural().min(1).default(64000),
    learningMaxSources: z.natural().min(1).default(4),
    learningMaxEvidence: z.natural().min(1).default(4),
    learningMaxResourceFiles: z.natural().min(1).default(100),
    learningMaxResourceBytes: z.natural().min(1).default(1048576),
    maintenanceMaxOperations: z.natural().min(1).default(4),
    learningOperationTimeoutMs: z.natural().min(1).default(10000),
    automaticProjectSkillLimit: z.natural().min(1).default(16),
    sequentialLearningMaxItems: z.natural().min(1).default(64),
    sequentialLearningMaxTaskBytes: z.natural().min(1).default(1600),
  })
  private readonly config: ResolvedConfig
  private library?: SkillLibrary
  private learning?: SkillLearning
  private decision?: DecisionAdvisory
  private readonly learningGenerators = new Map<string, SkillLearningGenerator>()
  private readonly learningValidators = new Map<string, SkillLearningValidator>()
  private readonly learningDisposers = new Map<string, () => void>()
  private readonly lifetime = new AbortController()
  private readonly providers = new Map<string, NativeSkillLibraryProvider>()
  private readonly providerDisposers = new Map<string, () => void>()
  private maintenance: Promise<void> | undefined
  private learningRuntimeDispose?: () => Promise<void>
  private sequentialLearning?: SequentialSkillLearning

  /**
 * @param ctx - Host workspace, storage and Remote services.
 * @param config - local discovery and maintenance policy.
 */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillLibrary', { namespace: 'skillLibrary' })
    this.config = SkillLibraryController.Config(config)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(skillLibraryDomain)
    const decisionLog = await this.ctx.storageDomain.open(decisionDomain)
    this.decision = new DecisionAdvisory(this.ctx, { configuration: decisionLog.global, records: decisionLog.table('requests') }, this.config.decision)
    const provider = new FileSystemSkillProvider(
      this.ctx,
      {
        invalidate() { },
        signal: this.lifetime.signal,
      },
      {
        ...this.config,
        watch: false,
      },
    )
    this.library = new SkillLibrary({
      provider,
      store: domain.table('items'),
      historyDirectory: join(resolveDshHome(this.config.dshHome), 'skill-library-history'),
      projects: () => this.ctx.workspaceRegistry.list()
        .map(project => ({
          id: project.id,
          title: project.title,
          path: project.path,
        })),
      bodyBudgetBytes: this.config.bodyBudgetBytes,
      retrievalLimit: this.config.retrievalLimit,
      proposalLimit: this.config.proposalLimit,
      registryInventory: createRegistryInventory({
        global: () => this.ctx.get('skills'),
        views: () => {
          const global = this.ctx.get('skills'); const presets = this.ctx.get('agentPresets')
          return (this.ctx.get('agents')?.list() ?? []).flatMap((agent) => {
            const registry = presets?.serviceFor(agent, 'skills') ?? global
            return registry === undefined
              ? []
              : [{
                key: agent.id,
                ...(agent.session.header.cwd === undefined
                  ? {}
                  : {
                    cwd: agent.session.header.cwd,
                  }),
                scope: agent,
                registry,
              }]
          })
        },
      }),
    })
    const learningDomain = await this.ctx.storageDomain.open(skillLearningDomain)
    this.learning = new SkillLearning({
      library: this.library,
      evidence: learningDomain.table('evidence'),
      proposals: learningDomain.table('proposals'),
      policies: learningDomain.table('policies'),
      optIns: learningDomain.table('opt_ins'),
      bodyBudgetBytes: this.config.bodyBudgetBytes,
      maxInputBytes: this.config.learningMaxInputBytes,
      maxSources: this.config.learningMaxSources,
      maxEvidence: this.config.learningMaxEvidence,
      maxResourceFiles: this.config.learningMaxResourceFiles,
      maxResourceBytes: this.config.learningMaxResourceBytes,
      maintenanceMaxOperations: this.config.maintenanceMaxOperations,
      maintenanceIntervalMs: this.config.automaticMaintenanceIntervalMs,
      operationTimeoutMs: this.config.learningOperationTimeoutMs,
      automaticProjectSkillLimit: this.config.automaticProjectSkillLimit,
      signal: this.lifetime.signal,
    })
    this.learningDisposers.set('generator:' + maintenanceGenerator.id, this.learning.registerGenerator(maintenanceGenerator))
    this.learningDisposers.set('validator:' + maintenanceValidator.id, this.learning.registerValidator(maintenanceValidator))
    for (const registered of this.learningGenerators.values()) this.learningDisposers.set(
      'generator:' + registered.id,
      this.learning.registerGenerator(registered),
    )
    for (const registered of this.learningValidators.values()) this.learningDisposers.set(
      'validator:' + registered.id,
      this.learning.registerValidator(registered),
    )
    this.learningRuntimeDispose = installSkillLearningRuntime(
      this.ctx,
      this,
      { maxInputBytes: this.config.learningMaxInputBytes, maxDrafts: this.config.learningMaxSources },
    )
    this.sequentialLearning = new SequentialSkillLearning(this.ctx, this, { maxItems: this.config.sequentialLearningMaxItems,
      maxTaskBytes: this.config.sequentialLearningMaxTaskBytes, maxInputBytes: this.config.learningMaxInputBytes,
      timeoutMs: this.config.learningOperationTimeoutMs })
    this.ctx.on('tools/result', (exec, result) => {
      if (result.isError || exec.name !== 'skill' || this.lifetime.signal.aborted) return
      void this.requireLibrary().observeToolResult(exec.name, result.isError, result.value).catch((error: unknown) => {
        this.ctx.logger.warn(`skill-library: load observation skipped: ${String(error)}`)
      })
    })
    for (const registered of this.providers.values()) this.providerDisposers.set(
      registered.name,
      this.library.registerNativeProvider(registered),
    )
    let timer: ReturnType<typeof setInterval> | undefined
    if (this.config.automaticMaintenanceIntervalMs > 0) {
      timer = setInterval(() => {
        if (this.maintenance !== undefined || this.lifetime.signal.aborted) return
        this.maintenance = this.requireLearning().cleanup({}).then(async () => {
          await this.requireLibrary().cleanupOptedIn() }).catch((error: unknown) => {
          this.ctx.logger.warn(`skill-library: automatic managed maintenance stopped: ${String(error)}`)
        }).finally(() => { this.maintenance = undefined })
      }, this.config.automaticMaintenanceIntervalMs)
      timer.unref()
    }
    this.ctx.effect(() => async () => {
      this.lifetime.abort(); if (timer !== undefined) clearInterval(timer)
      await this.decision?.dispose(); await decisionLog.close()
      await this.maintenance
      await this.sequentialLearning?.dispose()
      await this.learningRuntimeDispose?.()
      for (const dispose of this.providerDisposers.values()) dispose()
      this.providerDisposers.clear()
      for (const dispose of this.learningDisposers.values()) dispose()
      this.learningDisposers.clear(); await this.learning?.dispose()
      await this.library?.dispose(); await provider.dispose(); await learningDomain.close(); await domain.close()
    }, 'skill-library state and maintenance')
  }

  /**
 * Register metadata from an already-connected native route.
 * @param provider - process-free discovery adapter.
 * @returns provider disposer.
 */
  registerNativeProvider(provider: NativeSkillLibraryProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`duplicate skill library provider '${provider.name}'`)
    this.providers.set(provider.name, provider)
    if (this.library !== undefined) this.providerDisposers.set(provider.name, this.library.registerNativeProvider(provider))
    return () => {
      if (this.providers.get(provider.name) !== provider) return
      this.providers.delete(provider.name)
      this.providerDisposers.get(provider.name)?.()
      this.providerDisposers.delete(provider.name)
    }
  }

  /**
 * Read inventory summaries.
 * @param request - optional project selector.
 * @returns metadata, scopes and provider coverage.
 */
  @Remote('list')
  list(request: SkillLibraryListRequest): Promise<SkillLibraryList> { return this.requireLibrary().list(request) }
  /**
 * Load one selected instruction body.
 * @param request - stable library identity.
 * @returns detail and revision history.
 */
  @Remote('detail')
  detail(request: SkillLibraryIdRequest): Promise<SkillLibraryDetail> { return this.requireLibrary().detail(request) }
  /**
 * Protect a skill from maintenance.
 * @param request - identity and pin value.
 * @returns updated item.
 */
  @Remote('setPinned')
  setPinned(request: SkillLibraryPinRequest): Promise<SkillLibraryItemValue> { return this.requireLibrary().setPinned(request) }
  /**
 * Adopt a current local version without automatic cleanup.
 * @param request - identity and expected hash.
 * @returns updated item.
 */
  @Remote('adopt')
  adopt(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> { return this.requireLibrary().adopt(request) }
  /**
 * Explicitly opt one managed version into conservative cleanup.
 * @param request - unchanged managed file and opt-in.
 * @returns updated item.
 */
  @Remote('setAutomaticCleanup')
  setAutomaticCleanup(request: SkillLibraryAutomaticRequest): Promise<SkillLibraryItemValue> {
    return this.requireLibrary()
      .setAutomaticCleanup(request)
  }
  /**
 * Archive a whole selected bundle reversibly.
 * @param request - identity and expected hash.
 * @returns archived item.
 */
  @Remote('archive')
  async archive(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> {
    const consent = this.requireLearning().status().optIns.find(value => value.id === request.id)
    if (consent?.enabled === true) await this.requireLearning().setAutomatic({ id: request.id,
      expectedHash: request.expectedHash, policyId: consent.policyId, enabled: false })
    return this.requireLibrary().archive(request)
  }
  /**
 * Restore a selected archive into a vacant original location.
 * @param request - archived identity.
 * @returns restored item.
 */
  @Remote('restore')
  async restore(request: SkillLibraryIdRequest): Promise<SkillLibraryItemValue> {
    const consent = this.requireLearning().status().optIns.find(value => value.id === request.id)
    if (consent?.enabled === true) await this.requireLearning().setAutomatic({ id: request.id,
      expectedHash: consent.contentHash, policyId: consent.policyId, enabled: false })
    return this.requireLibrary().restore(request)
  }
  /**
 * Preview conservative managed-file compression.
 * @param request - selected ids or all eligible entries.
 * @returns source diffs and skipped reasons.
 */
  @Remote('previewCleanup')
  previewCleanup(request: SkillLibraryCleanupRequest): Promise<SkillCleanupProposal> {
    return this.requireLibrary()
      .previewCleanup(request)
  }
  /**
 * Apply an unchanged cleanup preview.
 * @param request - live preview identity.
 * @returns changed library identities.
 */
  @Remote('applyCleanup')
  applyCleanup(request: SkillLibraryApplyRequest): Promise<SkillLibraryApplyValue> {
    return this.requireLibrary()
      .applyCleanup(request)
  }
  /**
 * Restore previous instructions as a new revision.
 * @param request - expected current hash and previous version.
 * @returns updated item.
 */
  @Remote('rollback')
  rollback(request: SkillLibraryRollbackRequest): Promise<SkillLibraryItemValue> {
    return this.requireLibrary()
      .rollback(request)
  }
  /**
 * Select metadata before progressively loading bodies.
 * @param request - current project and routing query.
 * @returns bounded ranked metadata.
 */
  @Remote('retrieve')
  retrieve(request: SkillLibraryRetrieveRequest): Promise<readonly SkillLibraryItem[]> {
    return this.requireLibrary().retrieve(request).then(items => this.requireDecision().select(request, items))
  }
  /**
   * Read independent Decision settings and API capability disclosure.
   * @returns disabled or available route choices without generation.
   */
  @Remote('decisionStatus')
  decisionStatus(): Promise<DecisionStatus> { return this.requireDecision().status() }
  /**
   * Read exact API model effort and tier controls.
   * @param route - registered response-only route.
   * @returns explicit supported controls; native routes reject.
   */
  @Remote('decisionCapabilities')
  decisionCapabilities(route: DecisionRoute): Promise<DecisionCapabilities> { return this.requireDecision().capabilities(route) }
  /**
   * Save separate revision-checked Decision settings.
   * @param request - observed revision, opt-in and exact API route.
   * @returns committed settings without altering the main chat model.
   */
  @Remote('configureDecision')
  configureDecision(request: DecisionConfigureRequest): Promise<DecisionConfiguration> { return this.requireDecision().configure(request) }
  /**
 * Record verified explicit instruction delivery.
 * @param request - exact library/version identity and observation.
 * @returns persistence completion.
 */
  recordLoad(request: {
    readonly id: SkillLibraryId
    readonly contentHash?: string
    readonly loadedAt?: string
    readonly sessionId?: string
  }): Promise<void> { return this.requireLibrary().recordLoad(request) }
  /**
   * Register a bounded suggestion provider.
   * @param provider - bounded suggestion capability.
   * @returns registration disposer.
   */
  registerLearningGenerator(provider: SkillLearningGenerator): () => void {
    if (this.learningGenerators.has(provider.id)) throw new Error('duplicate learning generator')
    this.learningGenerators.set(provider.id, provider)
    if (this.learning !== undefined) this.learningDisposers.set(
      'generator:' + provider.id,
      this.learning.registerGenerator(provider),
    )
    return () => {
      this.learningGenerators.delete(provider.id)
      this.learningDisposers.get('generator:' + provider.id)?.()
      this.learningDisposers.delete('generator:' + provider.id)
    }
  }
  /**
   * Register a separate independent validation provider.
   * @param provider - separately trusted independent check capability.
   * @returns registration disposer.
   */
  registerLearningValidator(provider: SkillLearningValidator): () => void {
    if (this.learningValidators.has(provider.id)) throw new Error('duplicate learning validator')
    this.learningValidators.set(provider.id, provider)
    if (this.learning !== undefined) this.learningDisposers.set(
      'validator:' + provider.id,
      this.learning.registerValidator(provider),
    )
    return () => {
      this.learningValidators.delete(provider.id)
      this.learningDisposers.get('validator:' + provider.id)?.()
      this.learningDisposers.delete('validator:' + provider.id)
    }
  }
  /**
   * Run a fresh cancellable sequential task and retain only its durable current native procedure facts.
   * @param agent - exact selected live root supplying execution authority.
   * @param source - exact original source and disclosed native tool mode.
   * @param text - current human continuation, sanitized before evidence retention.
   * @param operation - provider admission, current-turn metadata and settled mirror reconciliation.
   * @returns its native result after task settlement and existing policy-controlled learning.
   */
  runSequentialTask<T>(
    agent: Agent,
    source: SkillSequentialTaskSource,
    text: string,
    operation: (hooks: SkillSequentialTaskHooks) => Promise<T>,
  ): Promise<T> {
    if (this.sequentialLearning === undefined) throw new Error('Sequential task learning is not ready.')
    return this.sequentialLearning.run(agent, source, text, operation)
  }
  /**
   * Capture immutable task observations without inferring success.
   * @param observation - immutable host-captured task events; completed turns alone are unverified.
   * @returns retained evidence.
   */
  recordLearningEvidence(observation: SkillLearningObservation): Promise<SkillLearningEvidence> {
    return this.requireLearning()
      .recordEvidence(observation)
  }
  /**
   * Publish observed project route availability.
   * @param projectId - selected registered project.
   * @param value - observed route support.
   */
  setLearningAvailability(projectId: string, value: Omit<SkillLearningAvailability, 'projectId'>): void {
    this.requireLearning()
      .setAvailability(
        projectId,
        value,
      )
  }
  /**
   * Read provider availability and semantic consent.
   * @param request - current project.
   * @returns provider availability and separately approved policies.
   */
  @Remote('learningStatus')
  learningStatus(request: SkillLearningListRequest): SkillLearningStatus {
    const status = this.requireLearning().status()
    return request.projectId === undefined ? status : {
      ...status,
      availability: status.availability.filter(value => value.projectId === request.projectId),
      evidence: status.evidence.filter(value => value.projectId === request.projectId),
    }
  }
  /**
   * Read captured task observations.
   * @param request - project filter.
   * @returns immutable observations available for review requests.
   */
  @Remote('listLearningEvidence')
  listLearningEvidence(request: SkillLearningListRequest): readonly SkillLearningEvidence[] {
    return this.requireLearning()
      .listEvidence(request)
  }
  /**
   * Generate a durable uncertain suggestion.
   * @param request - substantial task observations and selected local targets.
   * @returns durable uncertain proposal.
   */
  @Remote('proposeLearning')
  proposeLearning(request: SkillLearningProposeRequest): Promise<SkillLearningProposal> {
    return this.requireLearning()
      .propose(request)
  }
  /**
   * Apply independently checkable native procedure recording under explicit project policy.
   * @param evidence - unchanged retained live native observation.
   * @returns review/applied proposal or no change for an already recorded procedure.
   */
  autoLearnEvidence(evidence: SkillLearningEvidence): Promise<SkillLearningProposal | undefined> {
    return this.requireLearning().autoLearnEvidence(evidence)
  }
  /**
   * Read metadata-only proposal summaries.
   * @param request - project filter.
   * @returns body-free proposal summaries.
   */
  @Remote('listProposals')
  listProposals(request: SkillLearningListRequest): readonly SkillLearningProposalSummary[] {
    return this.requireLearning()
      .list(request)
  }
  /**
   * Load a complete retained proposal.
   * @param request - proposal identity.
   * @returns full source diff and retained evidence.
   */
  @Remote('detailProposal')
  detailProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal> {
    return this.requireLearning()
      .detail(request)
  }
  /**
   * Check the proposal through an independent provider.
   * @param request - selected proposal.
   * @returns separate independent validation findings.
   */
  @Remote('validateProposal')
  validateProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal> {
    return this.requireLearning()
      .validate(request)
  }
  /**
   * Apply an admitted proposal with reversible source history.
   * @param request - reviewed or separately authorized proposal.
   * @returns durable application outcome.
   */
  @Remote('applyProposal')
  applyProposal(request: SkillLearningApplyRequest): Promise<SkillLearningProposal> {
    return this.requireLearning()
      .apply(request)
  }
  /**
   * Retain a rejected suggestion in history.
   * @param request - selected suggestion.
   * @returns retained rejected history.
   */
  @Remote('rejectProposal')
  rejectProposal(request: SkillLearningProposalRequest): Promise<SkillLearningProposal> {
    return this.requireLearning()
      .reject(request)
  }
  /**
   * Approve a semantic policy without enabling any file.
   * @param request - explicit independent validator and allowed operations.
   * @returns policy without enabling any file.
   */
  @Remote('approveLearningPolicy')
  approveLearningPolicy(request: SkillLearningPolicyRequest): Promise<SkillLearningPolicy> {
    return this.requireLearning()
      .approvePolicy(request)
  }
  /**
   * Enable or revoke separate semantic consent.
   * @param request - per-file consent for separate semantic policy.
   * @returns enabled or revoked consent.
   */
  @Remote('setAutomaticLearning')
  setAutomaticLearning(request: SkillLearningAutomaticRequest): Promise<SkillLearningOptIn> {
    return this.requireLearning()
      .setAutomatic(request)
  }
  /**
   * Run an immediate bounded semantic pass; force preserves ownership, pins and consent.
   * @param request - project and optional selected managed identities.
   * @returns durable applied proposals with exact independent mechanical receipts.
   */
  @Remote('cleanupSemantic')
  cleanupSemantic(request: SkillLearningCleanupRequest): Promise<readonly SkillLearningProposal[]> {
    return this.requireLearning().cleanup(request)
  }
  /**
   * Revoke an approved policy while retaining recovery history.
   * @param request - approved policy identity.
   * @returns disabled retained policy.
   */
  @Remote('revokeLearningPolicy')
  revokeLearningPolicy(request: SkillLearningRevokePolicyRequest): Promise<SkillLearningPolicy> {
    return this.requireLearning().revokePolicy(request)
  }
  private requireDecision(): DecisionAdvisory {
    if (this.decision === undefined) throw new Error('skill decision is not initialized')
    return this.decision
  }
  private requireLearning(): SkillLearning {
    if (this.learning === undefined) throw new Error('skill learning is not initialized')
    return this.learning
  }
  private requireLibrary(): SkillLibrary {
    if (this.library === undefined) throw new Error('skill library is not initialized')
    return this.library
  }
}
export default SkillLibraryController
