/** Host coding-session discovery, durable mirrors, and source-owned capability gates. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-skill-library'
import { CodingSessionColdDestinations } from './cold-destinations.ts'
import { CodingSessionLinkedImports } from './linked-import.ts'
import { codingSessionLinkDomain } from './linked-import-record.ts'
import type { CodingSessionImportAcknowledgement, CodingSessionLinkId, CodingSessionLinkRecord, CodingSessionRollbackAcknowledgement, CodingSessionDestinationRevision } from './linked-import-types.ts'
import { createClaudeCodingSessionProvider } from './claude.ts'
import { codingSessionDigest } from './digest.ts'
import { CodingSessionLibrary } from './library.ts'
import { codingSessionDomain } from './record.ts'
import { codingSessionHandoffDomain } from './handoff-record.ts'
import type { CodingSessionProvider, CodingSessionProfile, CodingSessionSource, CodingSessionPage, CodingSessionMirror, CodingSessionMirrorId, CodingSessionsState, CodingSessionClaimAcknowledgement, CodingSessionRecoveryAcknowledgement } from './types.ts'

export type * from './types.ts'
export type * from './linked-import-options.ts'
declare module '@deepseek-ai/cordis' { interface Context { codingSessions: CodingSessions } }
/** Complete native page, retained history, and operation deadline budgets. */
export interface Config {
  /** Maximum native metadata items per page. */
  pageSize: number
  /** Maximum retained native history items per mirror. */
  maxEvents: number
  /** Maximum retained source mirrors. */
  maxMirrors: number
  /** Maximum complete native response and retained mirror bytes. */
  maxBytes: number
  /** Deadline for one native-source operation in milliseconds. */
  timeoutMs: number
  /** Allow metadata discovery for registered project profiles. */
  enableClaudeDiscovery: boolean
  /** Allow explicitly acknowledged sequential native ownership; adapters must independently support it. */
  enableSequentialHandoff: boolean
  /** Deadline for a sequential native turn, including settled readback, in milliseconds. */
  sequentialTurnTimeoutMs: number
  /** Maximum retained reversible generations in one linked native history. */
  maxImportGenerations: number
}
const defaultConfig: Config = { pageSize: 50, maxEvents: 10000, maxMirrors: 500,
  maxBytes: 4 * 1024 * 1024, timeoutMs: 25000, enableClaudeDiscovery: true,
  enableSequentialHandoff: false, sequentialTurnTimeoutMs: 600000, maxImportGenerations: 64 }
/** Remote consumer and service provider for read-only mirrors. Native connections register independently. */
export default class CodingSessions extends TypertRemoteService {
  static inject = ['storageDomain']
  static Config: z<Config> = z.object({
    pageSize: z.natural().min(1).default(50), maxEvents: z.natural().min(1).default(10000),
    maxMirrors: z.natural().min(1).default(500), maxBytes: z.natural().min(1).default(4 * 1024 * 1024),
    timeoutMs: z.natural().min(1).max(60000).default(25000), enableClaudeDiscovery: z.boolean().default(true),
    enableSequentialHandoff: z.boolean().default(false),
    sequentialTurnTimeoutMs: z.natural().min(1000).max(3600000).default(600000),
    maxImportGenerations: z.natural().min(1).max(1000).default(64),
  })
  private readonly claudeProviders = new Map<string, () => Promise<void>>()
  private readonly claudeRoot = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  private library: CodingSessionLibrary | undefined
  private linkedImports: CodingSessionLinkedImports | undefined
  private destinations: CodingSessionColdDestinations | undefined
  private readonly executionOwners = new Map<CodingSessionMirrorId, Agent>()
  private readonly providers = new Set<CodingSessionProvider>()
  private readonly registrations = new Map<CodingSessionProvider, () => Promise<void>>()
  private readonly config: Config
  /** @param ctx - Host storage and Remote services. @param config - deployment-owned bounds. */
  constructor(ctx: Context, config: Config = defaultConfig) {
    super(ctx, 'codingSessions', { namespace: 'codingSessions' })
    this.config = CodingSessions.Config(config)
  }
  protected async [Service.init](): Promise<void> {
    const config = CodingSessions.Config(this.config)
    await this.ctx.effect(async () => {
      let domain: Domain<typeof codingSessionDomain> | undefined
      let handoffs: Domain<typeof codingSessionHandoffDomain> | undefined
      let links: Domain<typeof codingSessionLinkDomain> | undefined
      let imports: CodingSessionLinkedImports | undefined
      let destinations: CodingSessionColdDestinations | undefined
      let library: CodingSessionLibrary | undefined
      let cleanupTask: Promise<void> | undefined
      const close = (): Promise<void> => cleanupTask ??= (async () => {
        const failures: unknown[] = []
        this.library = undefined; this.linkedImports = undefined; this.destinations = undefined
        const unregistering: Promise<void>[] = []
        for (const dispose of this.registrations.values()) {
          try { unregistering.push(dispose()) } catch (error) { failures.push(error) }
        }
        this.registrations.clear(); this.providers.clear(); this.claudeProviders.clear()
        // The library attempts every held lease before either domain drains its admitted writes.
        // A failed release leaves its durable unresolved marker intact; teardown is not release evidence.
        // close aborts admitted work immediately while all queued profile releases remain joined.
        const settled = await Promise.allSettled([...unregistering, library?.close() ?? Promise.resolve(),
          destinations?.close() ?? Promise.resolve(), imports?.close() ?? Promise.resolve()])
        for (const result of settled) if (result.status === 'rejected') failures.push(result.reason)
        this.executionOwners.clear()
        try { await links?.close() } catch (error) { failures.push(error) }
        try { await handoffs?.close() } catch (error) { failures.push(error) }
        try { await domain?.close() } catch (error) { failures.push(error) }
        if (failures.length > 0) throw new AggregateError(failures, 'Coding session teardown remains uncertain after all owned cleanup attempts.')
      })()
      try {
        domain = await this.ctx.storageDomain.open(codingSessionDomain)
        handoffs = await this.ctx.storageDomain.open(codingSessionHandoffDomain)
        library = new CodingSessionLibrary({
          store: domain.table('mirrors'), pageSize: config.pageSize, maxEvents: config.maxEvents,
          maxMirrors: config.maxMirrors, maxBytes: config.maxBytes, timeoutMs: config.timeoutMs,
          enableSequentialHandoff: config.enableSequentialHandoff, sequentialTurnTimeoutMs: config.sequentialTurnTimeoutMs, handoffStore: handoffs.table('markers'),
        })
        links = await this.ctx.storageDomain.open(codingSessionLinkDomain)
        destinations = new CodingSessionColdDestinations(this.ctx, { maxEvents: config.maxEvents,
          maxBytes: config.maxBytes, maxRecords: config.maxMirrors, timeoutMs: config.timeoutMs })
        const cold = destinations
        imports = new CodingSessionLinkedImports({ store: links.table('links'), maxRecords: config.maxMirrors,
          maxEvents: config.maxEvents, maxBytes: config.maxBytes, maxGenerations: config.maxImportGenerations,
          withDestination: (id, use, recovery) => cold.withDestination(id, use, recovery), inspectDestination: id => cold.inspect(id) })
        this.destinations = destinations; this.linkedImports = imports
        this.library = library
        for (const provider of this.providers) this.registrations.set(provider, library.register(provider))
        return close
      } catch (error) {
        try { await close() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Coding session setup failed and its owned cleanup remains uncertain.')
        }
        throw error
      }
    }, 'coding-sessions: owned mirror and native handoff storage')
  }
  /**
   * Attach one authorized native source to durable mirror operations.
   * @param provider - exact authorized native profile.
   * @returns idempotent disposer removing availability immediately and joining this profile's native release work; mirrors survive removal.
   */
  registerProvider(provider: CodingSessionProvider): () => Promise<void> {
    if ([...this.providers].some(value => value.provider === provider.provider && value.profileId === provider.profileId)) throw new Error('Coding session profile is already registered.')
    this.providers.add(provider)
    if (this.library !== undefined) this.registrations.set(provider, this.library.register(provider))
    let removal: Promise<void> | undefined
    return () => {
      if (removal !== undefined) return removal
      this.providers.delete(provider)
      const dispose = this.registrations.get(provider)
      this.registrations.delete(provider)
      return removal = dispose?.() ?? Promise.resolve()
    }
  }
  /**
   * Synchronize registered Claude projects and list mirror metadata.
   * @returns source readiness and readable retained mirrors.
   */
  @Remote async getState(): Promise<CodingSessionsState> {
    this.syncClaudeSources()
    const state = this.ready().state()
    const agents = this.ctx.get('agents'); const sessions = this.ctx.get('sessions')
    const executionSessions = this.config.enableSequentialHandoff ? (agents?.roots() ?? []).flatMap((agent) => {
      const project = agent.session.header.cwd
      return agent.status === 'idle' && sessions?.get(agent.session.id) === agent.session
        && project !== undefined && isAbsolute(project) ? [{ id: agent.session.id, project }] : []
    }) : []
    const cold = this.cold(); const linkedImportsAvailable = cold.available()
    const inventory = { ...state, executionSessions, linkedImportsAvailable, links: this.imports().state(),
      importDestinations: linkedImportsAvailable ? await cold.list() : [] }
    if (executionSessions.length > this.config.maxMirrors || Buffer.byteLength(JSON.stringify(inventory), 'utf8') > this.config.maxBytes) {
      throw new Error('Coding session execution and import inventory exceeded the configured limit.')
    }
    return inventory
  }
  /**
   * Browse sessions in one configured native source.
   * @param profile - selected authorized native source.
   * @param cursor - opaque source page cursor.
   * @returns one source-labelled metadata page.
   */
  @Remote async discover(profile: CodingSessionProfile, cursor?: string): Promise<CodingSessionPage> {
    return this.ready().discover(profile, cursor)
  }
  /**
   * Retain a stable source history snapshot.
   * @param source - original provider/profile/native identity.
   * @returns stable durable read-only mirror.
   */
  @Remote async importSession(source: CodingSessionSource): Promise<CodingSessionMirror> { return this.ready().importSession(source) }
  /**
   * Refresh the original source without replacing divergent retained history.
   * @param id - existing Y mirror.
   * @returns fresh source history or a retained conflict.
   */
  @Remote async refreshMirror(id: CodingSessionMirrorId): Promise<CodingSessionMirror> { return this.ready().refreshMirror(id) }
  /**
   * Load transcript details after explicit mirror selection.
   * @param id - existing Y mirror.
   * @returns retained source-labelled transcript.
   */
  @Remote async detail(id: CodingSessionMirrorId): Promise<CodingSessionMirror> { return this.ready().detail(id) }
  /**
   * Delegate continuation only to a supported exclusive original-source writer.
   * @param id - existing Y mirror.
   * @param text - human continuation.
   * @param expectedRevision - reviewed mirror revision.
   * @returns native settlement mirror or explicit unsupported-operation refusal.
   */
  @Remote async continueSession(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<CodingSessionMirror> {
    return this.ready().continueSession(id, text, expectedRevision)
  }

  /**
   * Bind an explicit sequential claim to the selected exact live root's existing policy.
   * @param id - reviewed native mirror.
   * @param acknowledgement - original source/project/revision, selected execution root and prior-writer closure.
   * @returns original-source ownership without creating an Agent or issuing a model request.
   */
  @Remote async claimSequential(
    id: CodingSessionMirrorId, acknowledgement: CodingSessionClaimAcknowledgement,
  ): Promise<CodingSessionMirror> {
    const agent = this.executionRoot(acknowledgement.executionSessionId, acknowledgement.project)
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('Sequential continuation requires a live Y execution session.')
    const selected = await this.ready().detail(id)
    if (selected.handoff !== undefined && selected.handoff.phase !== 'external-ready' && selected.handoff.phase !== 'recovered-acknowledged') {
      throw new Error('Native writer ownership is unresolved. Release the retained owner before claiming again.')
    }
    if (this.executionRoot(acknowledgement.executionSessionId, acknowledgement.project) !== agent) {
      throw new Error('The selected Y execution session changed before acquisition.')
    }
    this.executionOwners.set(id, agent)
    return agents.withInitiator(agent, () => this.ready().claimSequential(id, acknowledgement))
  }
  /**
   * Continue the original native conversation under its retained exact live root's current policy.
   * @param id - claimed original-source mirror.
   * @param text - human continuation message.
   * @param expectedRevision - reviewed native mirror revision.
   * @returns settled original-source history while sequential ownership remains held.
   */
  @Remote async continueSequential(id: CodingSessionMirrorId, text: string, expectedRevision: number): Promise<CodingSessionMirror> {
    const captured = this.executionOwners.get(id)
    const selected = await this.ready().detail(id)
    const handoff = selected.handoff
    if (captured === undefined || handoff === undefined
      || this.executionRoot(handoff.executionSessionId, handoff.project) !== captured) {
      throw new Error('The selected Y execution session changed. Release the native owner before continuing.')
    }
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new Error('Sequential continuation requires a live Y execution session.')
    return agents.withInitiator(captured, () => {
      const skills = this.ctx.get('skillLibrary')
      return skills === undefined ? this.ready().continueSequential(id, text, expectedRevision)
        : skills.runSequentialTask(captured, { ...selected.source, toolMode: handoff.toolMode }, text,
          hooks => this.ready().continueSequential(id, text, expectedRevision, hooks))
    })
  }
  /**
   * Release retained native resources independently from source reconnection or root availability.
   * @param id - claimed original-source mirror.
   * @returns confirmed release after native process quiescence and original-history readback.
   */
  @Remote async releaseSequential(id: CodingSessionMirrorId): Promise<CodingSessionMirror> {
    const value = await this.ready().releaseSequential(id)
    this.executionOwners.delete(id)
    return value
  }
  /**
   * Recover an interrupted owner using reviewed cold history and stopped-writer acknowledgements.
   * @param id - interrupted mirror.
   * @param acknowledgement - exact stopped-writer assertions and reviewed owner.
   * @returns an acknowledged checkpoint retaining old-process uncertainty.
   */
  @Remote async recoverSequential(
    id: CodingSessionMirrorId, acknowledgement: CodingSessionRecoveryAcknowledgement,
  ): Promise<CodingSessionMirror> {
    const mirror = await this.ready().recoverSequential(id, acknowledgement)
    this.executionOwners.delete(id); return mirror
  }
  /**
   * Create a cold ordinary-Y destination in the selected native mirror's known project.
   * @param id - reviewed native mirror.
   * @returns a new durable ordinary-Y destination in its known exact project; no Agent is created.
   */
  @Remote async createImportDestination(
    id: CodingSessionMirrorId,
  ): Promise<{ destinationSessionId: SessionId; revision: CodingSessionDestinationRevision }> {
    const mirror = await this.ready().detail(id)
    if (mirror.cwd === undefined) throw new Error('The native project is unknown; select a known project before creating an import destination.')
    return this.cold().create(mirror.cwd)
  }
  /**
   * Inspect a cold ordinary-Y destination without appending imported history.
   * @param id - explicit cold ordinary-Y Session.
   * @returns its canonical event-count and digest for review.
   */
  @Remote async inspectImportDestination(
    id: SessionId,
  ): Promise<{ destinationSessionId: SessionId; revision: CodingSessionDestinationRevision }> {
    return this.imports().inspectDestination(id)
  }
  /**
   * Append reviewed native public history as attributed quoted context to a cold ordinary-Y session.
   * @param id - reviewed native mirror.
   * @param acknowledgement - exact source, link and cold destination revisions.
   * @returns a quoted append or retained source conflict.
   */
  @Remote async importIntoSession(
    id: CodingSessionMirrorId, acknowledgement: CodingSessionImportAcknowledgement,
  ): Promise<CodingSessionLinkRecord> {
    return this.imports().importMirror(await this.ready().detail(id), acknowledgement)
  }
  /**
   * Load retained source mappings, generations and any prepared import intent.
   * @param id - exact retained source-to-Y mapping.
   * @returns bounded source mappings and transaction receipts.
   */
  @Remote async linkedDetail(id: CodingSessionLinkId): Promise<CodingSessionLinkRecord> {
    return await Promise.resolve(this.imports().detail(id))
  }
  /**
   * Withdraw active quoted generations while preserving their raw receipts and subsequent Y messages.
   * @param id - exact retained link.
   * @param acknowledgement - reviewed link and canonical destination revisions.
   * @returns append-only withdrawal preserving subsequent Y messages.
   */
  @Remote async rollbackImport(
    id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement,
  ): Promise<CodingSessionLinkRecord> {
    return this.imports().rollback(id, acknowledgement)
  }
  /**
   * Finish an exact prepared import or rollback after restart; changed destination history is refused.
   * @param id - exact prepared link.
   * @returns committed receipt only after exact planned event-envelope recovery.
   */
  @Remote async recoverImport(id: CodingSessionLinkId): Promise<CodingSessionLinkRecord> { return this.imports().recover(id) }
  /**
   * Abandon a reviewed prepared intent only when no owned payload is persisted in its destination.
   * @param id - exact prepared link.
   * @param acknowledgement - reviewed link and canonical destination revisions.
   * @returns cancellation only when no owned payload was persisted.
   */
  @Remote async abandonImport(
    id: CodingSessionLinkId, acknowledgement: CodingSessionRollbackAcknowledgement,
  ): Promise<CodingSessionLinkRecord> {
    return this.imports().abandonPrepared(id, acknowledgement)
  }
  private imports(): CodingSessionLinkedImports { if (this.linkedImports === undefined) throw new Error('Linked import storage is not ready.'); return this.linkedImports }
  private cold(): CodingSessionColdDestinations { if (this.destinations === undefined) throw new Error('Import destination storage is not ready.'); return this.destinations }
  private executionRoot(id: SessionId, project: string): Agent {
    if (!this.config.enableSequentialHandoff) throw new Error('Sequential native handoff is disabled.')
    const agents = this.ctx.get('agents')
    const agent = agents?.get(id)
    if (agent === undefined || !agents?.roots().includes(agent) || agent.status !== 'idle'
      || this.ctx.get('sessions')?.get(agent.session.id) !== agent.session
      || agent.session.header.cwd !== project || !isAbsolute(project)) {
      throw new Error('Select an idle live Y root in the exact native project before claiming this session.')
    }
    return agent
  }

  /**
   * Cancel current and queued source operations, then drain admitted work.
   * @returns native-read cancellation and durable-write quiescence.
   */
  @Remote async cancelPending(): Promise<void> {
    await Promise.all([this.ready().cancelPending(), this.imports().cancelPending(), this.cold().cancelPending()])
  }
  private syncClaudeSources(): void {
    if (!CodingSessions.Config(this.config).enableClaudeDiscovery) return
    const currentRoot = resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
    if (currentRoot !== this.claudeRoot) throw new Error('The native Claude profile directory changed. Reload this connection before discovering sessions.')
    const projects = this.ctx.get('workspaceRegistry')?.list() ?? []
    const directories = new Set(projects.map(project => project.path))
    for (const [directory, unregister] of this.claudeProviders) if (!directories.has(directory)) {
      void unregister().catch((error: unknown) => { this.ctx.logger.error(error) })
      this.claudeProviders.delete(directory)
    }
    for (const project of projects) if (!this.claudeProviders.has(project.path)) {
      const profileId = `sdk:${codingSessionDigest({ root: this.claudeRoot, directory: project.path })}`
      const provider = createClaudeCodingSessionProvider(profileId, `Claude Code · ${project.title}`, project.path)
      this.claudeProviders.set(project.path, this.registerProvider({ ...provider, connected: () => provider.connected() && (this.ctx.get('workspaceRegistry')?.list().some(value => value.path === project.path) ?? false) }))
    }
  }
  private ready(): CodingSessionLibrary { if (this.library === undefined) throw new Error('Coding session storage is not ready.'); return this.library }
}
