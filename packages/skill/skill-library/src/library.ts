/** File-backed skill inventory and conservative reversible maintenance. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, rename, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import type { RegistryInventory } from './registry-inventory.ts'
import { skillLibraryRecord, type SkillLibraryRecord } from './record.ts'
import type {
  NativeSkillLibraryProvider, SkillCleanupProposal, SkillLibraryApplyRequest, SkillLibraryApplyValue,
  SkillLibraryAutomaticRequest, SkillLibraryCleanupRequest, SkillLibraryDetail, SkillLibraryHashRequest, SkillLibraryId,
  SkillLibraryIdRequest, SkillLibraryItem, SkillLibraryItemValue, SkillLibraryList, SkillLibraryListRequest,
  SkillLibraryPinRequest, SkillLibraryProject, SkillLibraryProviderStatus, SkillLibraryReference,
  SkillLibraryRetrieveRequest, SkillLibraryRollbackRequest, SkillRevisionId,
} from './types.ts'

/** Persisted management record access supplied by the domain owner. */
export interface SkillLibraryStore {
  /**
   * @param id - stable library identity.
   * @returns persisted flags or undefined.
   */
  get(id: SkillLibraryId): SkillLibraryRecord | undefined
  /** @returns current durable management records. */
  entries(): IterableIterator<[SkillLibraryId, SkillLibraryRecord]>
  /**
   * @param id - stable library identity.
   * @param record - complete management state.
   * @returns persistence completion.
   */
  put(id: SkillLibraryId, record: SkillLibraryRecord): Promise<void>
}
/** Existing discovery provider, registered projects and explicit maintenance bounds. */
export interface SkillLibraryOptions {
  readonly provider: FileSystemSkillProvider
  readonly store: SkillLibraryStore
  /** @returns registered project directories; no sessions are opened. */
  readonly projects: () => readonly SkillLibraryProject[]
  readonly historyDirectory: string
  readonly bodyBudgetBytes: number
  readonly retrievalLimit: number
  readonly proposalLimit: number
  readonly registryInventory?: RegistryInventory
}
interface LocalEntry {
  readonly candidate: SkillCandidate
  readonly originalPath: string
  readonly bundlePath: string
  readonly raw: string
  readonly item: SkillLibraryItem
}

/** Owns metadata discovery and serialized user-authorized source changes. */
export class SkillLibrary {
  private readonly nativeProviders = new Map<string, NativeSkillLibraryProvider>()
  private readonly previews = new Map<string, SkillCleanupProposal>()
  private readonly local = new Map<SkillLibraryId, LocalEntry>()
  private readonly registryOwners = new Set<SkillLibraryId>()
  private readonly nativeOwners = new Map<SkillLibraryId, NativeSkillLibraryProvider>()
  private operationTail = Promise.resolve()
  private closed = false
  private recovery?: Promise<void>
  private readonly recoveryWarnings: string[] = []
  constructor(private readonly options: SkillLibraryOptions) { }

  /**
   * Register an already-connected provider; disposal removes it without altering files.
   * @param provider - already-connected metadata provider.
   * @returns disposer removing the provider.
   */
  registerNativeProvider(provider: NativeSkillLibraryProvider): () => void {
    if (this.nativeProviders.has(provider.name)) throw new Error(`duplicate skill library provider '${provider.name}'`)
    this.nativeProviders.set(provider.name, provider)
    return () => { if (this.nativeProviders.get(provider.name) === provider) this.nativeProviders.delete(provider.name) }
  }

  /**
   * Read metadata only into the returned inventory, including shadowed candidates and archives.
   * @param request - optional project filter and native refresh request.
   * @returns inventory summaries without instruction bodies.
   */
  async list(request: SkillLibraryListRequest = {}): Promise<SkillLibraryList> {
    this.recovery ??= this.recoverArchives().then(() => this.recoverRevisions()).then(() => this.recoverCreations())
    await this.recovery
    const projects = this.options.projects()
    const candidates = new Map<SkillLibraryId, {
      candidate: SkillCandidate
      projectIds: string[]
    }>()
    this.local.clear(); this.nativeOwners.clear(); this.registryOwners.clear()
    for (const project of [...projects, { id: '', title: '', path: '' }]) {
      const result = await this.options.provider.list(project.id === '' ? {} : { cwd: project.path })
      const observation = Array.isArray(result) ? result : result.candidates
      for (const candidate of observation) {
        if (candidate.path === undefined) continue
        const primary = identity(candidate.provider, candidate.path)
        const archived = this.options.store.get(primary)?.archive
        const key = archived === undefined
          ? primary
          : identity(candidate.provider, `${candidate.path}\0replacement:${archived.archivePath}`)
        const entry = candidates.get(key) ?? { candidate, projectIds: [] }
        if (project.id !== ''
          && isProjectSource(candidate.source)
          && !entry.projectIds.includes(project.id)) entry.projectIds.push(project.id)
        candidates.set(key, entry)
      }
    }
    const items: SkillLibraryItem[] = []
    for (const [id, entry] of candidates) {
      const locator = localLocator(entry.candidate.locator)
      if (locator === undefined || entry.candidate.path === undefined) continue
      const originalPath = resolve(locator.path)
      const raw = await readFile(entry.candidate.path, 'utf8')
      const state = this.record(id)
      const currentHash = hash(raw)
      const safe = await isUnlinked(originalPath) && entry.candidate.source !== 'bundled'
      const managed = safe && state.managedHash === currentHash
      const item: SkillLibraryItem = {
        id,
        name: entry.candidate.name,
        description: entry.candidate.description,
        provider: entry.candidate.provider,
        source: entry.candidate.source,
        path: entry.candidate.path,
        scope: entry.projectIds.length > 0 ? 'project' : 'shared',
        projectIds: entry.projectIds,
        ownership: entry.candidate.source === 'bundled' ? 'vendor' : managed ? 'y-managed' : 'protected',
        status: entry.candidate.invocation.modelInvocable || entry.candidate.invocation.userInvocable ? 'active' : 'disabled',
        shadowed: false,
        pinned: state.pinned,
        automaticCleanup: managed && state.automaticCleanup,
        invocation: entry.candidate.invocation,
        contentHash: currentHash,
        bodyBytes: Buffer.byteLength(instructionBody(raw)),
        usage: state.usage,
        references: references(raw, dirname(entry.candidate.path), entry.candidate.metadata),
        capabilities: { adopt: safe, archive: safe, restore: false, cleanup: managed && !state.pinned, native: false },
      }
      items.push(item)
      this.local.set(id, { candidate: entry.candidate, originalPath, bundlePath: locator.bundlePath, raw, item })
    }
    for (const [id, state] of this.options.store.entries()) {
      if (state.archive === undefined) continue
      items.push({
        ...state.archive.snapshot, id, status: 'archived', pinned: state.pinned, automaticCleanup: false,
        capabilities: { adopt: false, archive: false, cleanup: false, restore: true, native: false },
      })
    }
    const providers: SkillLibraryProviderStatus[] = [{ provider: this.options.provider.name, state: 'connected' }]
    if (this.recoveryWarnings.length > 0) providers.push({
      provider: 'skill-library-history',
      state: 'unavailable',
      message: this.recoveryWarnings.join('; '),
    })
    if (this.options.registryInventory !== undefined) {
      const registry = await this.options.registryInventory.list(projects)
      providers.push(...registry.statuses)
      for (const entry of registry.entries) {
        const id = identity(entry.provider, entry.path)
        if (items.some(item => item.id === id)) continue
        const state = this.record(id)
        items.push({
          id,
          name: entry.name,
          description: entry.description,
          provider: entry.provider,
          source: entry.source,
          path: entry.path,
          scope: entry.projectIds.length > 0 ? 'project' : 'shared',
          projectIds: entry.projectIds,
          ownership: entry.source === 'bundled' ? 'vendor' : 'protected',
          status: entry.enabled ? 'active' : 'disabled',
          shadowed: false,
          pinned: state.pinned,
          automaticCleanup: false,
          invocation: { modelInvocable: entry.modelInvocable, userInvocable: entry.userInvocable },
          contentHash: '',
          bodyBytes: 0,
          usage: state.usage,
          references: [],
          capabilities: { adopt: false, archive: false, restore: false, cleanup: false, native: false },
        })
        this.registryOwners.add(id)
      }
    }
    for (const provider of this.nativeProviders.values()) {
      let result
      try { result = await provider.list(projects, request) } catch (error) {
        providers.push({ provider: provider.name, state: 'unavailable', message: String(error) }); continue
      }
      providers.push(result.status)
      for (const entry of result.entries) {
        const id = identity(provider.name, entry.path)
        if (items.some(item => item.id === id)) continue
        const state = this.record(id)
        items.push({
          id,
          name: entry.name,
          description: entry.description,
          provider: provider.name,
          source: entry.source,
          path: entry.path,
          scope: entry.projectIds.length > 0 ? 'project' : 'shared',
          projectIds: entry.projectIds,
          ownership: 'protected',
          status: entry.enabled ? 'active' : 'disabled',
          shadowed: false,
          pinned: state.pinned,
          automaticCleanup: false,
          invocation: { modelInvocable: entry.enabled, userInvocable: entry.userInvocable ?? true },
          contentHash: '',
          bodyBytes: 0,
          usage: state.usage,
          references: entry.references ?? [],
          capabilities: { adopt: false, archive: false, restore: false, cleanup: false, native: true },
        })
        this.nativeOwners.set(id, provider)
      }
    }
    const ranked = [...candidates.entries()].sort((a, b) => a[1].candidate.rank - b[1].candidate.rank)
    const winners = new Map<string, SkillLibraryId>()
    for (const [id, entry] of ranked) {
      for (const scope of entry.projectIds.length > 0
        ? entry.projectIds
        : projects.length > 0 ? projects.map(project => project.id) : ['shared']) {
        const key = `${scope}:${entry.candidate.name}`
        if (!winners.has(key)) winners.set(key, id)
      }
    }
    const projected = items.map(item => ({
      ...item,
      shadowed: this.local.has(item.id) && !item.capabilities.native && item.status !== 'archived' && (item.projectIds.length > 0
        ? item.projectIds.every(project => winners.get(`${project}:${item.name}`) !== item.id)
        : (projects.length > 0
          ? projects.map(project => project.id)
          : ['shared']).every(project => winners.get(`${project}:${item.name}`) !== item.id)),
      references: item.references.map((reference) => {
        const targets = items.filter(other => other.status !== 'archived' && (reference.kind === 'file' ? other.path === reference.target
          : reference.kind === 'skill' && other.name === reference.target
          && (other.scope === 'shared' || other.projectIds.some(id => item.projectIds.includes(id)))))
        const [target] = targets
        return targets.length !== 1 || target === undefined ? reference : { ...reference, resolvedId: target.id }
      }),
    }))
    return {
      items: projected.filter(item => request.projectId === undefined
        || item.scope === 'shared'
        || item.projectIds.includes(request.projectId)),
      projects,
      providers,
      bodyBudgetBytes: this.options.bodyBudgetBytes,
    }
  }

  /**
   * Load one selected complete instruction body and its durable history; local boundary whitespace is retained.
   * @param request - stable selected skill identity.
   * @returns instructions and revision history.
   */
  async detail(request: SkillLibraryIdRequest): Promise<SkillLibraryDetail> {
    const item = await this.requireItem(request.id)
    const state = this.record(request.id)
    const local = this.local.get(request.id)
    let content = ''
    if (state.archive !== undefined) content = instructionBody(await readFile(state.archive.instructionPath, 'utf8'))
    else if (local !== undefined) content = instructionBody(local.raw)
    else if (this.registryOwners.has(item.id)) {
      const registry = this.options.registryInventory
      if (registry === undefined) throw new Error('registry skill source is no longer available')
      content = await registry.detail(item.path, item.provider)
    }
    else content = await this.nativeOwners.get(request.id)?.detail?.(item.path) ?? ''
    return { item, content, revisions: state.revisions.map(({ backupPath: _backupPath, ...revision }) => revision) }
  }

  /**
   * Pinning protects managed skills from cleanup without changing instruction files.
   * @param request - selected skill and desired pin.
   * @returns updated summary.
   */
  setPinned(request: SkillLibraryPinRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      await this.requireItem(request.id)
      await this.options.store.put(request.id, { ...this.record(request.id), pinned: request.pinned })
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Deliberately adopt the current file version; automatic maintenance remains off.
   * @param request - selected local file and expected current hash.
   * @returns deliberately adopted summary.
   */
  adopt(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      const entry = await this.requireLocal(request.id); await this.assertHash(entry, request.expectedHash)
      await this.options.store.put(
        request.id,
        {
          ...this.record(request.id),
          managedHash: request.expectedHash,
          automaticCleanup: false,
        },
      )
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Separately opt an unchanged managed skill into conservative automatic whitespace cleanup.
   * @param request - unchanged managed file and explicit opt-in.
   * @returns updated summary.
   */
  setAutomaticCleanup(request: SkillLibraryAutomaticRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      const entry = await this.requireLocal(request.id); await this.assertHash(entry, request.expectedHash)
      if (!entry.item.capabilities.cleanup) throw new Error('skill is protected from automatic cleanup')
      await this.options.store.put(request.id, { ...this.record(request.id), automaticCleanup: request.enabled })
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Move the whole bundle outside discovery roots while retaining a restore record.
   * @param request - selected local bundle and expected instruction hash.
   * @returns archived summary after durable publication.
   */
  archive(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(() => this.archiveSource(request))
  }

  /**
   * Recheck semantic dependencies inside the existing source mutation queue.
   * @param request - selected managed source hash.
   * @param verify - host-owned constraints, resources and survivor admission.
   * @returns archived item with its complete bundle retained.
   */
  archiveLearning(request: SkillLibraryHashRequest, verify: () => Promise<void>): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      await verify()
      return this.archiveSource(request)
    })
  }
  private async archiveSource(request: SkillLibraryHashRequest): Promise<SkillLibraryItemValue> {
    const entry = await this.requireLocal(request.id); await this.assertHash(entry, request.expectedHash)
    if (entry.item.pinned) throw new Error('pinned skill is protected from archive')
    const archivePath = join(dirname(entry.bundlePath), '.skill-library-archive', randomUUID())
    await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 })
    const instructionPath = entry.bundlePath === entry.originalPath ? archivePath : join(archivePath, 'SKILL.md')
    const archived = skillLibraryRecord.parse({
      ...this.record(request.id), automaticCleanup: false,
      archive: { archivePath, originalPath: entry.bundlePath, instructionPath, snapshot: entry.item },
    })
    const journal = await this.writeArchiveJournal(request.id, 'archive', archived, entry.bundlePath, archivePath)
    await this.assertHash(entry, request.expectedHash)
    await rename(entry.bundlePath, archivePath)
    await this.options.store.put(request.id, archived)
    await rm(journal)
    return { item: await this.requireItem(request.id) }
  }

  /**
   * Restore an archived bundle only if the original location remains vacant.
   * @param request - selected archive identity.
   * @returns restored summary after exclusive copy and durable publication.
   */
  restore(request: SkillLibraryIdRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      const state = this.record(request.id)
      if (state.archive === undefined) throw new Error('skill is not archived')
      if (await exists(state.archive.originalPath)) throw new Error('restore location is occupied')
      await mkdir(dirname(state.archive.originalPath), { recursive: true })
      const { archive, ...previous } = state
      const restored = { ...previous, retainedArchives: [...state.retainedArchives, archive.archivePath] }
      const journal = await this.writeArchiveJournal(request.id, 'restore', restored, archive.originalPath, archive.archivePath)
      if ((await lstat(archive.archivePath)).isDirectory()) {
        await mkdir(archive.originalPath)
        for (const child of await readdir(archive.archivePath)) await cp(
          join(archive.archivePath, child),
          join(archive.originalPath, child),
          { recursive: true, force: false, errorOnExist: true, dereference: false },
        )
      } else {
        await copyFile(archive.archivePath, archive.originalPath, constants.COPYFILE_EXCL)
      }
      await writeFile(`${journal}.complete`, '', { flag: 'wx', mode: 0o600 })
      await this.options.store.put(request.id, restored)
      await rm(journal)
      await rm(`${journal}.complete`, { force: true })
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Preview complete replacement instructions without editing protected or pinned skills.
   * @param request - selected candidates, or all eligible managed skills.
   * @returns complete conservative diffs and skipped reasons.
   */
  async previewCleanup(request: SkillLibraryCleanupRequest = {}): Promise<SkillCleanupProposal> {
    const inventory = await this.list({})
    const selected = inventory.items.filter(item => request.ids === undefined || request.ids.includes(item.id))
    const changes: SkillCleanupProposal['changes'][number][] = []; const skipped: SkillCleanupProposal['skipped'][number][] = []
    for (const item of selected) {
      if (!item.capabilities.cleanup) {
        skipped.push({ id: item.id, reason: 'protected, pinned, native or archived skill' })
        continue
      }
      const entry = this.local.get(item.id)
      if (entry === undefined) throw new Error('skill source changed; refresh and preview again')
      const after = compress(entry.raw)
      if (after === entry.raw) {
        skipped.push({
          id: item.id,
          reason: item.bodyBytes > this.options.bodyBudgetBytes ? 'over budget: semantic review required' : 'already compact',
        })
        continue
      }
      changes.push({
        id: item.id,
        name: item.name,
        expectedHash: item.contentHash,
        before: entry.raw,
        after,
        beforeBytes: Buffer.byteLength(entry.raw),
        afterBytes: Buffer.byteLength(after),
        overBudget: Buffer.byteLength(instructionBody(after)) > this.options.bodyBudgetBytes,
      })
    }
    const proposal = {
      id: brandString<SkillCleanupProposal['id']>(randomUUID()),
      changes,
      skipped,
      createdAt: new Date().toISOString(),
    }
    this.previews.set(proposal.id, proposal)
    while (this.previews.size > this.options.proposalLimit) {
      const oldest = this.previews.keys().next()
      if (oldest.done) break
      this.previews.delete(oldest.value)
    }
    return proposal
  }

  /**
   * Apply a still-current preview with all admissions checked before the first edit.
   * @param request - live preview identity.
   * @returns identities revised by the unchanged preview.
   */
  applyCleanup(request: SkillLibraryApplyRequest): Promise<SkillLibraryApplyValue> {
    return this.enqueue(async () => {
      const proposal = this.previews.get(request.proposalId)
      if (proposal === undefined) throw new Error('cleanup preview expired; preview again')
      for (const change of proposal.changes) {
        const entry = await this.requireLocal(change.id)
        await this.assertHash(entry, change.expectedHash)
        if (!entry.item.capabilities.cleanup) throw new Error('skill is protected from cleanup')
      }
      const revised: SkillLibraryId[] = []
      for (const change of proposal.changes) {
        await this.revise(change.id, change.expectedHash, change.after, 'cleanup')
        revised.push(change.id)
      }
      this.previews.delete(request.proposalId)
      return { revised }
    })
  }

  /**
   * Restore a historical instruction version as a new recorded revision.
   * @param request - previous revision and expected current hash.
   * @returns summary after recording a restorable replacement.
   */
  rollback(request: SkillLibraryRollbackRequest): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      const revision = this.record(request.id).revisions.find(entry => entry.id === request.revisionId)
      if (revision === undefined) throw new Error('unknown skill revision')
      await this.revise(request.id, request.expectedHash, await readFile(revision.backupPath, 'utf8'), 'rollback')
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Rank current-project and shared metadata; callers select before progressively loading bodies.
   * @param request - current project, metadata query and candidate limit.
   * @returns bounded metadata in descending relevance order.
   */
  async retrieve(request: SkillLibraryRetrieveRequest): Promise<readonly SkillLibraryItem[]> {
    const items = (await this.list({ ...(request.projectId === undefined ? {} : { projectId: request.projectId }) })).items
    const explicit = new Set(request.explicitIds ?? [])
    const words = request.query.toLowerCase().split(/\W+/).filter(Boolean)
    const score = (item: SkillLibraryItem): number => (explicit.has(item.id) ? 10000 : 0) + words.reduce(
      (sum, word) => sum + (item.name.toLowerCase()
        .includes(word)
        ? 10
        : 0) + (item.description.toLowerCase()
        .includes(word)
        ? 2
        : 0),
      0,
    )
    const limit = Math.min(Math.max(request.limit ?? this.options.retrievalLimit, 1), this.options.retrievalLimit)
    const winners = new Map<string, SkillLibraryId>()
    if (request.projectId !== undefined) for (const item of [...items].sort((a, b) => (this.local.get(a.id)
      ?.candidate.rank ?? 0) - (this.local.get(b.id)
      ?.candidate.rank ?? 0))) {
      if (!this.local.has(item.id) || item.status !== 'active') continue
      if (!winners.has(item.name)) winners.set(item.name, item.id)
    }
    return items.filter(item => (!this.local.has(item.id)
      || request.projectId === undefined
      || winners.get(item.name) === item.id)
      && !item.capabilities.native
      && item.status === 'active'
      && !item.shadowed
      && (item.invocation.modelInvocable || explicit.has(item.id)))
      .map(item => ({
        item,
        score: score(item),
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score
        || a.item.name.localeCompare(b.item.name))
      .slice(
        0,
        limit,
      ).map(entry => entry.item)
  }

  /**
   * Observe exact successful Harness skill-load values without inferring application quality.
   * @param name - executed tool name.
   * @param isError - canonical failure indicator.
   * @param value - final frozen tool value.
   * @returns completion after recording a uniquely matching current load.
   */
  async observeToolResult(name: string, isError: boolean, value: unknown): Promise<void> {
    if (name !== 'skill' || isError || typeof value !== 'object' || value === null
      || !('name' in value) || typeof value.name !== 'string' || !('provider' in value) || typeof value.provider !== 'string'
      || !('content' in value) || typeof value.content !== 'string' || !('resourceBase' in value)
      || typeof value.resourceBase !== 'object' || value.resourceBase === null || !('kind' in value.resourceBase)
      || value.resourceBase.kind !== 'directory' || !('path' in value.resourceBase) || typeof value.resourceBase.path !== 'string') return
    await this.list({})
    const base = resolve(value.resourceBase.path)
    const matches = [...this.local.values()].filter(entry => entry.item.name === value.name
      && entry.item.provider === value.provider
      && localLocator(entry.candidate.locator)?.directory === base && body(entry.raw) === value.content)
    const [entry] = matches
    if (matches.length !== 1 || entry === undefined) return
    await this.recordLoad({ id: entry.item.id, contentHash: entry.item.contentHash })
  }

  /**
   * Record exact observed instruction delivery; missing telemetry remains unknown.
   * @param request - exact library identity and observed version.
   * @returns completion after persisting one recorded load.
   */
  recordLoad(request: {
    readonly id: SkillLibraryId
    readonly contentHash?: string
    readonly loadedAt?: string
    readonly sessionId?: string
  }): Promise<void> {
    return this.enqueue(async () => {
      const item = await this.requireItem(request.id)
      if (request.contentHash !== undefined
        && request.contentHash !== item.contentHash) throw new Error('loaded skill version changed')
      const state = this.record(request.id)
      await this.options.store.put(
        request.id,
        {
          ...state,
          usage: {
            coverage: 'recorded-loads',
            loadCount: state.usage.loadCount + 1,
            lastLoadedAt: request.loadedAt ?? new Date().toISOString(),
          },
        },
      )
    })
  }

  /**
   * Perform conservative maintenance only for explicitly opted-in current managed files.
   * @returns identities changed by conservative opted-in maintenance.
   */
  async cleanupOptedIn(): Promise<SkillLibraryApplyValue> {
    const ids = (await this.list({})).items.filter(item => item.automaticCleanup
      && item.capabilities.cleanup)
      .map(item => item.id)
    const proposal = await this.previewCleanup({ ids })
    return this.applyCleanup({ proposalId: proposal.id })
  }

  private async writeArchiveJournal(
    id: SkillLibraryId,
    operation: 'archive' | 'restore',
    record: SkillLibraryRecord,
    originalPath: string,
    archivePath: string): Promise<string> {
    const directory = join(
      this.options.historyDirectory,
      'pending-archives',
    )
    await mkdir(
      directory,
      {
        recursive: true,
        mode: 0o700,
      },
    )
    const path = join(directory, `${randomUUID()}.json`)
    await writeFile(path, JSON.stringify({ id, operation, record, originalPath, archivePath }), { flag: 'wx', mode: 0o600 })
    return path
  }
  private async readRecoveryDocument(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      this.recoveryWarnings.push(`Unreadable recovery document preserved: ${basename(path)} (${String(error)})`)
      return undefined
    }
  }
  private readRecoveryRecord(raw: unknown, name: string): SkillLibraryRecord | undefined {
    const parsed = skillLibraryRecord.safeParse(raw)
    if (parsed.success) return parsed.data
    this.recoveryWarnings.push(`Invalid recovery state preserved: ${name}`)
    return undefined
  }
  private async recoverArchives(): Promise<void> {
    const directory = join(this.options.historyDirectory, 'pending-archives')
    if (!await exists(directory)) return
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      const path = join(directory, name)
      const parsed = await this.readRecoveryDocument(path)
      if (parsed === undefined) continue
      if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string'
        || !('originalPath' in parsed) || typeof parsed.originalPath !== 'string' || !('archivePath' in parsed) || typeof parsed.archivePath !== 'string'
        || !('operation' in parsed) || (parsed.operation !== 'archive'
          && parsed.operation !== 'restore') || !('record' in parsed)) {
        this.recoveryWarnings.push(`Invalid archive recovery document preserved: ${name}`)
        continue
      }
      const record = this.readRecoveryRecord(parsed.record, name)
      if (record === undefined) continue
      const original = await exists(parsed.originalPath); const archived = await exists(parsed.archivePath)
      if (parsed.operation === 'restore' && original && archived) {
        if (await exists(`${path}.complete`)) await this.options.store.put(brandString<SkillLibraryId>(parsed.id), record)
        else {
          this.recoveryWarnings.push(`Interrupted restore; original and archived files preserved for ${parsed.id}`)
          continue
        }
      } else if (parsed.operation === 'archive'
        && archived) {
        await this.options.store.put(
          brandString<SkillLibraryId>(parsed.id),
          record,
        )
      }
      else if (original === archived) {
        this.recoveryWarnings.push(`Archive recovery needs review; files preserved for ${parsed.id}`)
        continue
      }
      else if (parsed.operation === 'archive'
        ? archived
        : original) await this.options.store.put(
        brandString<SkillLibraryId>(parsed.id),
        record,
      )
      await rm(path)
      await rm(`${path}.complete`, { force: true })
    }
  }

  private async recoverRevisions(): Promise<void> {
    const directory = join(this.options.historyDirectory, 'pending-revisions')
    if (!await exists(directory)) return
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      const journal = join(directory, name)
      const parsed = await this.readRecoveryDocument(journal)
      if (parsed === undefined) continue
      if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string'
        || !('path' in parsed) || typeof parsed.path !== 'string' || !('expectedHash' in parsed) || typeof parsed.expectedHash !== 'string'
        || !('replacementHash' in parsed) || typeof parsed.replacementHash !== 'string' || !('record' in parsed)) {
        this.recoveryWarnings.push(`Invalid revision recovery document preserved: ${name}`)
        continue
      }
      const record = this.readRecoveryRecord(parsed.record, name)
      if (record === undefined) continue
      if (!await exists(parsed.path)) {
        this.recoveryWarnings.push(`Revision source missing; backup preserved for ${parsed.id}`)
        continue
      }
      const current = hash(await readFile(parsed.path, 'utf8'))
      if (current !== parsed.expectedHash) {
        await this.options.store.put(brandString<SkillLibraryId>(parsed.id), record)
        if (current !== parsed.replacementHash) this.recoveryWarnings.push(`Source changed during revision recovery; current file and prior version preserved for ${parsed.id}`)
      }
      await rm(journal)
    }
  }

  private async recoverCreations(): Promise<void> {
    const directory = join(this.options.historyDirectory, 'pending-creations')
    if (!await exists(directory)) return
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue
      const journal = join(directory, name); const parsed = await this.readRecoveryDocument(journal)
      if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string'
        || !('path' in parsed)
        || typeof parsed.path !== 'string'
        || !('expectedHash' in parsed)
        || typeof parsed.expectedHash !== 'string'
        || !('record' in parsed)) {
        this.recoveryWarnings.push(`Invalid creation recovery document preserved: ${name}`)
        continue
      }
      const record = this.readRecoveryRecord(parsed.record, name)
      if (record === undefined || !await exists(parsed.path)) {
        this.recoveryWarnings.push(`Creation recovery needs review; source location preserved for ${parsed.id}`)
        continue
      }
      const current = hash(await readFile(parsed.path, 'utf8'))
      await this.options.store.put(brandString<SkillLibraryId>(parsed.id), record)
      if (current !== parsed.expectedHash) this.recoveryWarnings.push(`Created source later changed; current file remains protected for ${parsed.id}`)
      await rm(journal)
    }
  }

  /**
   * Stop admitting mutations and drain every already-admitted operation.
   * @returns completion after mutations reach quiescence.
   */
  async dispose(): Promise<void> {
    this.closed = true
    await this.operationTail
  }

  /**
   * Read a current local source for the bounded host learning engine.
   * @param id - selected local identity.
   * @returns instruction text, original raw bytes and bundle root.
   */
  async learningSource(id: SkillLibraryId): Promise<{
    item: SkillLibraryItem
    raw: string
    content: string
    bundlePath: string
  }> {
    const entry = await this.requireLocal(id)
    await this.assertHash(entry, entry.item.contentHash)
    return { item: entry.item, raw: entry.raw, content: instructionBody(entry.raw), bundlePath: entry.bundlePath }
  }

  /**
   * Apply a reviewed semantic body through the existing serialized revision journal.
   * @param request - unchanged managed version and complete replacement body.
   * @param verify - host-owned resource and constraint checks at admission.
   * @returns updated local item.
   */
  reviseLearning(request: {
    id: SkillLibraryId
    expectedHash: string
    content: string
  }, verify: () => Promise<void>): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      await verify()
      const entry = await this.requireLocal(request.id)
      if (entry.item.ownership !== 'y-managed') throw new Error('skill is protected; adopt the current version first')
      const header = entry.raw.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? ''
      await this.revise(request.id, request.expectedHash, header + request.content, 'learning')
      return { item: await this.requireItem(request.id) }
    })
  }

  /**
   * Create an explicitly reviewed project skill without replacing any existing path.
   * @param request - registered project, exact reviewed destination and host-validated new name and body.
   * @param verify - host-owned update-before-create checks at admission.
   * @returns deliberately managed new item with automatic consent granted separately by the coordinator under an explicit project policy.
   */
  createLearning(request: {
    projectId: string
    name: string
    description: string
    content: string
    expectedPath: string
  }, verify: () => Promise<void>): Promise<SkillLibraryItemValue> {
    return this.enqueue(async () => {
      await verify()
      const project = this.options.projects().find(item => item.id === request.projectId)
      if (project === undefined
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.name)) throw new Error('invalid project or skill name')
      const projectPath = project.path
      if (request.expectedPath !== join(projectPath, '.dsh', 'skills', request.name, 'SKILL.md')) throw new Error('skill destination changed from the reviewed project path')
      if ((await this.list({})).items.some(item => item.status !== 'archived' && item.name === request.name
        && (item.scope === 'shared'
          || item.projectIds.includes(request.projectId)))) throw new Error('existing skill must be updated before creation')
      const root = join(projectPath, '.dsh', 'skills')
      for (const path of [projectPath, join(
        projectPath,
        '.dsh',
      ), root]) if (await exists(path)
        && !await isUnlinked(path)) throw new Error('skill destination is protected')
      await verify()
      if (this.options.projects().find(item => item.id === request.projectId)?.path !== projectPath) throw new Error('skill destination changed from the reviewed project path')
      await mkdir(root, { recursive: true })
      const directory = join(root, request.name); await mkdir(directory, { mode: 0o700 })
      const path = join(directory, 'SKILL.md')
      const raw = '---\nname: ' + request.name + '\ndescription: ' + JSON.stringify(request.description) + '\n---\n' + request.content
      const canonical = join(await realpath(directory), 'SKILL.md')
      const id = identity(this.options.provider.name, canonical)
      const created = { ...this.record(id), managedHash: hash(raw), automaticCleanup: false }
      const pending = join(
        this.options.historyDirectory,
        'pending-creations',
      )
      await mkdir(
        pending,
        {
          recursive: true,
          mode: 0o700,
        },
      )
      const journal = join(pending, randomUUID() + '.json')
      await writeFile(
        journal,
        JSON.stringify({
          id,
          path: canonical,
          expectedHash: hash(raw),
          record: created,
        }),
        {
          flag: 'wx',
          mode: 0o600,
        },
      )
      await writeFile(path, raw, { flag: 'wx', mode: 0o600 })
      const item = (await this.list({})).items.find(item => item.path === canonical)
      if (item === undefined) throw new Error('created instructions were not discoverable; source preserved')
      await this.options.store.put(item.id, created)
      await rm(journal)
      return { item: await this.requireItem(item.id) }
    })
  }

  private record(id: SkillLibraryId): SkillLibraryRecord {
    return this.options.store.get(id) ?? {
      retainedArchives: [],
      pinned: false,
      automaticCleanup: false,
      usage: {
        coverage: 'unknown',
        loadCount: 0,
      },
      revisions: [],
    }
  }
  private async requireItem(id: SkillLibraryId): Promise<SkillLibraryItem> {
    const item = (await this.list({})).items.find(item => item.id === id)
    if (item === undefined) throw new Error('skill source changed or is no longer available')
    return item
  }
  private async requireLocal(id: SkillLibraryId): Promise<LocalEntry> {
    const item = await this.requireItem(id); const entry = this.local.get(id)
    if (entry === undefined
      || !item.capabilities.archive
      || !await isUnlinked(entry.originalPath)) throw new Error('skill is protected from source changes')
    return entry
  }
  private async assertHash(entry: LocalEntry, expected: string): Promise<void> {
    if (hash(await readFile(
      entry.originalPath,
      'utf8',
    )) !== expected) throw new Error('skill source changed; refresh and preview again')
  }
  private async revise(
    id: SkillLibraryId,
    expected: string,
    replacement: string,
    reason: 'cleanup' | 'rollback' | 'learning'): Promise<void> {
    const entry = await this.requireLocal(id); await this.assertHash(entry, expected)
    if (entry.item.pinned) throw new Error('pinned skill is protected from revision')
    if ((reason === 'cleanup'
      || reason === 'learning')
      && !entry.item.capabilities.cleanup) throw new Error('skill is protected from cleanup')
    const revisionId = brandString<SkillRevisionId>(randomUUID())
    const directory = join(
      this.options.historyDirectory,
      'revisions',
      id,
    )
    await mkdir(
      directory,
      {
        recursive: true,
        mode: 0o700,
      },
    )
    const backupPath = join(directory, `${revisionId}.md`)
    await writeFile(backupPath, entry.raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    const temporary = join(dirname(entry.originalPath), `.skill-library-${randomUUID()}.tmp`)
    const info = await stat(entry.originalPath)
    await writeFile(temporary, replacement, { encoding: 'utf8', flag: 'wx', mode: info.mode & 0o777 })
    try {
      await this.assertHash(entry, expected)
      const state = this.record(id)
      const revised: SkillLibraryRecord = {
        ...state, managedHash: hash(replacement), revisions: [...state.revisions, {
          id: revisionId, createdAt: new Date().toISOString(), reason, beforeHash: expected, afterHash: hash(replacement),
          beforeBytes: Buffer.byteLength(entry.raw), afterBytes: Buffer.byteLength(replacement), backupPath,
        }],
      }
      const pendingDirectory = join(
        this.options.historyDirectory,
        'pending-revisions',
      )
      await mkdir(
        pendingDirectory,
        {
          recursive: true,
          mode: 0o700,
        },
      )
      const journal = join(pendingDirectory, `${revisionId}.json`)
      await writeFile(
        journal,
        JSON.stringify({
          id,
          path: entry.originalPath,
          expectedHash: expected,
          replacementHash: hash(replacement),
          record: revised,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      await this.assertHash(entry, expected)
      await rename(temporary, entry.originalPath)
      try { await this.options.store.put(id, revised) } catch (error) {
        if (hash(await readFile(entry.originalPath, 'utf8')) === hash(replacement)) await writeFile(entry.originalPath, entry.raw)
        throw error
      }
      await rm(journal)
    } finally { await rm(temporary, { force: true }) }
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('skill library is closed'))
    const result = this.operationTail.then(operation); this.operationTail = result.then(() => { }, () => { })
    return result
  }
}

function identity(provider: string, path: string): SkillLibraryId {
  return brandString<SkillLibraryId>(hash(`${provider}\0${path}`))
}
function hash(content: string): string { return createHash('sha256').update(content).digest('hex') }
function localLocator(value: unknown): {
  path: string
  directory: string
  bundlePath: string
} | undefined {
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string'
    || !('directory' in value)
    || typeof value.directory !== 'string'
    || !('bundlePath' in value)
    || typeof value.bundlePath !== 'string') return undefined
  return { path: value.path, directory: value.directory, bundlePath: value.bundlePath }
}
function isProjectSource(source: string): boolean { return source === 'project-dsh' || source === 'project-agents' }
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isAbsent(error)) return false
    throw error
  }
}
function isAbsent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}
async function isUnlinked(path: string): Promise<boolean> {
  return !(await lstat(path)).isSymbolicLink() && !(await lstat(dirname(path))).isSymbolicLink()
    && await realpath(path) === join(await realpath(dirname(path)), basename(path))
}
function instructionBody(raw: string): string { return raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '') }
function body(raw: string): string { return instructionBody(raw).trim() }
function references(
  raw: string,
  directory: string,
  metadata: Readonly<Record<string, unknown>> | undefined): SkillLibraryReference[] {
  const result: SkillLibraryReference[] = []
  const related = metadata?.relatedSkills
  if (Array.isArray(related)) for (const target of related) if (typeof target === 'string') result.push({ target, kind: 'skill' })
  for (const match of withoutCodeExamples(instructionBody(raw)).matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const value = match[1]
    if (value === undefined) throw new Error('skill reference capture is unavailable')
    if (value.startsWith('#')) continue
    if (/^https?:\/\//i.test(value)) result.push({ target: value, kind: 'url' })
    else if (!/^[a-z]+:/i.test(value)) result.push({ target: resolve(directory, value.split('#')[0] ?? ''), kind: 'file' })
  }
  return result.filter((reference, index) => result.findIndex(other => other.target === reference.target
    && other.kind === reference.kind) === index)
}
/** Only excess blank lines outside fenced code are removed; instruction wording and YAML stay intact. */
function compress(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match === null) return raw
  const header = match[0]; const rest = raw.slice(header.length)
  if (/^(?: {4}|\t)/m.test(rest)) return raw
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  let fence: {
    marker: string
    length: number
  } | undefined; let blank = 0
  const lines: string[] = []
  for (const line of rest.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = { marker: marker.charAt(0), length: marker.length }
      else if (fence.marker === marker[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = undefined
      blank = 0; lines.push(line); continue
    }
    if (fence !== undefined) {
      lines.push(line)
      continue
    }
    if (line.trim() === '') {
      blank++
      if (blank <= 2) lines.push(line)
    } else {
      blank = 0
      lines.push(line)
    }
  }
  return header + lines.join(newline)
}

function withoutCodeExamples(text: string): string {
  let fence: {
    marker: string
    length: number
  } | undefined
  return text.split(/\r?\n/).filter((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === undefined) fence = { marker: marker.charAt(0), length: marker.length }
      else if (fence.marker === marker[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = undefined
      return false
    }
    return fence === undefined && !/^(?: {4}|\t)/.test(line)
  }).join('\n')
}
