/** Host skill management Remote service; existing instruction files stay authoritative. */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-workspace'
import type { } from '@deepseek-ai/dsh-agent'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import { createRegistryInventory } from './registry-inventory.ts'
import { SkillLibrary } from './library.ts'
import { skillLibraryDomain } from './record.ts'
import { SkillLearning } from './learning.ts'
import { skillLearningDomain } from './learning-record.ts'
import { installSkillLearningRuntime } from './learning-runtime.ts'
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
} from './types.ts'

export type * from './types.ts'

/** Filesystem discovery and bounded local maintenance policy. */
export interface Config {
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
}
type ResolvedConfig = Config & {
  bodyBudgetBytes: number
  retrievalLimit: number
  proposalLimit: number
  automaticMaintenanceIntervalMs: number
  learningMaxInputBytes: number
  learningMaxSources: number
  learningMaxEvidence: number
  learningMaxResourceFiles: number
  learningMaxResourceBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { /** Project skill inventory and reversible managed maintenance. */ skillLibrary: SkillLibraryController }
}

/** Owns the `skillLibrary` Remote namespace and local native-provider registrations. */
export class SkillLibraryController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'storageDomain']
  static Config: z<Config, ResolvedConfig> = z.object({
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
  })
  private readonly config: ResolvedConfig
  private library?: SkillLibrary
  private learning?: SkillLearning
  private readonly learningGenerators = new Map<string, SkillLearningGenerator>()
  private readonly learningValidators = new Map<string, SkillLearningValidator>()
  private readonly learningDisposers = new Map<string, () => void>()
  private readonly lifetime = new AbortController()
  private readonly providers = new Map<string, NativeSkillLibraryProvider>()
  private readonly providerDisposers = new Map<string, () => void>()
  private maintenance: Promise<void> | undefined
  private learningRuntimeDispose?: () => Promise<void>

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
      signal: this.lifetime.signal,
    })
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
        this.maintenance = this.requireLibrary().cleanupOptedIn().then(() => { }, (error: unknown) => {
          this.ctx.logger.warn(`skill-library: automatic whitespace cleanup stopped: ${String(error)}`)
        }).finally(() => { this.maintenance = undefined })
      }, this.config.automaticMaintenanceIntervalMs)
      timer.unref()
    }
    this.ctx.effect(() => async () => {
      this.lifetime.abort(); if (timer !== undefined) clearInterval(timer)
      await this.maintenance
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
  archive(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> { return this.requireLibrary().archive(request) }
  /**
 * Restore a selected archive into a vacant original location.
 * @param request - archived identity.
 * @returns restored item.
 */
  @Remote('restore')
  restore(request: SkillLibraryIdRequest): Promise<SkillLibraryItemValue> { return this.requireLibrary().restore(request) }
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
    return this.requireLibrary()
      .retrieve(request)
  }
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
