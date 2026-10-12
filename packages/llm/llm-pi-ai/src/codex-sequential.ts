/** Operational same-ID native continuation with confined file tools and observed saved-public-history release. */
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionNativeTurnId, CodingSessionProfileId, CodingSessionReadRequest, CodingSessionSequentialWriterProvider,
  CodingSessionSequentialWriterLease, CodingSessionSequentialReleaseReceipt, CodingSessionSnapshot, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'
import { z } from 'zod'
import type { CodexTurnAccess } from './codex-backend-access.ts'
import { declineCodexRequest } from './codex-backend.ts'
import { createCodexCodingSessionProvider } from './codex-coding-sessions.ts'
import type { CodexSessionSourceConfig } from './coding-session-source.ts'
import { assertSavedPrefix, disabledServerMap, nativeRestrictions, restrictedConfig, sequentialDigest, verifyRestrictedConfig, verifyManagedRequirements } from './codex-sequential-guards.ts'
import type { CodexDisabledServers } from './codex-sequential-guards.ts'
import type { CodexSequentialPeer, CodexSequentialPeerFactory } from './codex-sequential-process.ts'
import { CodexSequentialProcessReleaseError } from './codex-sequential-process.ts'
import { codexNativeItem } from './codex-native-evidence.ts'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'

type Obj = Record<string, unknown>
const object = z.record(z.string(), z.unknown())
const terminal = z.object({ id: z.string().min(1), status: z.enum(['completed', 'failed', 'interrupted', 'inProgress']) }).loose()
const thread = z.object({ id: z.string().min(1), cwd: z.string(), historyMode: z.enum(['legacy', 'paginated']).default('legacy'),
  status: z.object({ type: z.enum(['idle', 'active', 'notLoaded', 'systemError']) }).loose(), turns: z.array(terminal) }).loose()
const resume = z.object({ thread, cwd: z.string(), approvalPolicy: z.unknown(), approvalsReviewer: z.string(), sandbox: object }).loose()
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}
function isAuthority(value: unknown): value is object { return value !== null && typeof value === 'object' }
function sameSource(left: CodingSessionSource, right: CodingSessionSource): boolean {
  return sequentialDigest(left) === sequentialDigest(right)
}
const accessIdentity = (access: CodexTurnAccess): string => sequentialDigest({ cwd: access.cwd, sandbox: access.sandbox,
  writableRoots: access.writableRoots, approvalPolicy: access.approvalPolicy, sandboxPolicy: access.sandboxPolicy })
async function protectProfile(config: CodexSessionSourceConfig, access: CodexTurnAccess): Promise<void> {
  if (access.sandbox === 'danger-full-access' || !isAbsolute(access.cwd) || access.writableRoots.some(root => !isAbsolute(root))) {
    throw new Error('Sequential Codex file tools require a confined absolute Harness project policy.')
  }
  const home = await realpath(config.home)
  const roots = await Promise.all(access.writableRoots.map(root => realpath(root)))
  const cwd = await realpath(access.cwd)
  // Native WorkspaceWrite implicitly grants cwd, even when omitted from its
  // explicit roots. It must already fit the exact Y policy's granted roots.
  if (access.sandbox === 'workspace-write' && (!roots.some(root => contains(root, cwd)) || contains(cwd, home) || contains(home, cwd))) {
    throw new Error('Sequential Codex working directory would widen Harness writes or overlap the native profile.')
  }
  if (roots.some(root => contains(root, home) || contains(home, root))) throw new Error('Sequential Codex file tools cannot write within or around the native profile.')
}
function policyArguments(access: CodexTurnAccess): string[] {
  const workspace = `{writable_roots=[${access.writableRoots.map(root => JSON.stringify(root)).join(',')}],network_access=true,exclude_tmpdir_env_var=true,exclude_slash_tmp=true}`
  return ['-c', `sandbox_mode=${JSON.stringify(access.sandbox)}`, '-c', `approval_policy=${JSON.stringify(access.approvalPolicy)}`,
    '-c', 'approvals_reviewer="user"', '-c', `sandbox_workspace_write=${workspace}`]
}
async function readConfig(peer: CodexSequentialPeer, cwd: string, request: CodingSessionReadRequest): Promise<Obj> {
  request.signal.throwIfAborted()
  const result = z.object({ config: object }).parse(await peer.request('config/read', { cwd, includeLayers: false }, request.signal))
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > request.maxBytes) throw new Error('Original Codex merged configuration exceeded the configured byte limit.')
  request.signal.throwIfAborted(); return result.config
}
async function readRequirements(peer: CodexSequentialPeer, request: CodingSessionReadRequest): Promise<Obj | null> {
  request.signal.throwIfAborted()
  // Pinned Option<()> accepts omitted params, not an empty object.
  const value = verifyManagedRequirements(await peer.request('configRequirements/read', undefined, request.signal), request.maxEvents, request.maxBytes)
  request.signal.throwIfAborted(); return value
}
async function savedTurns(peer: CodexSequentialPeer, source: CodingSessionSource, cwd: string, request: CodingSessionReadRequest): Promise<Map<string, z.infer<typeof terminal>['status']>> {
  const head = z.object({ thread }).parse(await peer.request('thread/read', { threadId: source.nativeSessionId, includeTurns: false }, request.signal)).thread
  if (head.id !== source.nativeSessionId || head.cwd !== cwd || head.status.type === 'active' || head.status.type === 'systemError') throw new Error('Original Codex saved turn identities are unavailable.')
  const values: z.infer<typeof terminal>[] = []
  if (head.historyMode === 'legacy') {
    const full = z.object({ thread }).parse(await peer.request('thread/read', { threadId: source.nativeSessionId, includeTurns: true }, request.signal)).thread
    if (full.id !== head.id || full.cwd !== head.cwd || full.status.type !== head.status.type || full.historyMode !== head.historyMode) throw new Error('Original Codex turn readback changed its source.')
    values.push(...full.turns)
  } else {
    let cursor: string | undefined; const cursors = new Set<string>(); let bytes = 0
    do {
      if (cursors.size >= request.maxEvents) throw new Error('Original Codex turn readback exceeded its page limit.')
      const page = z.object({ data: z.array(terminal), nextCursor: z.string().nullish() }).parse(await peer.request('thread/turns/list', {
        threadId: source.nativeSessionId, limit: request.limit, sortDirection: 'asc', itemsView: 'notLoaded', ...(cursor === undefined ? {} : { cursor }),
      }, request.signal))
      bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
      if (bytes > request.maxBytes || page.data.length > request.limit) throw new Error('Original Codex turn readback exceeded its configured limits.')
      values.push(...page.data); cursor = page.nextCursor ?? undefined
      if (cursor !== undefined) { if (cursors.has(cursor)) throw new Error('Original Codex turn readback repeated a cursor.'); cursors.add(cursor) }
    } while (cursor !== undefined)
  }
  if (values.length > request.maxEvents || Buffer.byteLength(JSON.stringify(values), 'utf8') > request.maxBytes
    || values.some(turn => turn.status === 'inProgress')
    || new Set(values.map(turn => turn.id)).size !== values.length) {
    throw new Error('Original Codex turn readback is incomplete, repeated or exceeds its bounds.')
  }
  request.signal.throwIfAborted(); return new Map(values.map(turn => [turn.id, turn.status]))
}
async function verifyServers(
  peer: CodexSequentialPeer, source: CodingSessionSource, servers: CodexDisabledServers, request: CodingSessionReadRequest,
): Promise<void> {
  let cursor: string | undefined; const cursors = new Set<string>(); const seen = new Set<string>(); let bytes = 0
  do {
    if (cursors.size >= request.maxEvents) throw new Error('Original Codex disabled server inventory exceeded its page limit.')
    const page = z.object({ data: z.array(z.object({ name: z.string(), runtimeStatus: z.string().nullish(), tools: object,
      resources: z.array(z.unknown()), resourceTemplates: z.array(z.unknown()) }).loose()), nextCursor: z.string().nullish() }).parse(
      await peer.request('mcpServerStatus/list', { threadId: source.nativeSessionId, limit: request.limit, ...(cursor === undefined ? {} : { cursor }) }, request.signal))
    bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
    if (bytes > request.maxBytes || page.data.length > request.limit || seen.size + page.data.length > request.maxEvents) throw new Error('Original Codex disabled server inventory exceeded its bounds.')
    for (const server of page.data) {
      if (!Object.hasOwn(servers, server.name) || seen.has(server.name) || server.runtimeStatus !== 'disabled'
        || Object.keys(server.tools).length !== 0 || server.resources.length !== 0 || server.resourceTemplates.length !== 0) {
        throw new Error('Original Codex has an unexpected or unconfirmed native server capability.')
      }
      seen.add(server.name)
    }
    cursor = page.nextCursor ?? undefined
    if (cursor !== undefined) { if (cursors.has(cursor)) throw new Error('Original Codex disabled server inventory repeated a cursor.'); cursors.add(cursor) }
  } while (cursor !== undefined)
  if (seen.size !== Object.keys(servers).length) throw new Error('Original Codex did not confirm every observed native server was disabled.')
  request.signal.throwIfAborted()
}

/** Private sequential owner plus provider-disposal drainage. */
export interface CodexSequentialAccess extends CodexTurnAccess {
  /** Exact captured live Agent object; equal project/policy cannot replace its lifetime. */
  authority: object
}
/** Private sequential owner plus provider-disposal drainage. */
export interface CodexSequentialOwner {
  writer: CodingSessionSequentialWriterProvider
  /** @returns after all admitted private native work and owned processes drain; no external-ready receipt. */
  close(): Promise<void>
}
/**
 * Create a default-off source's explicitly acknowledged original-ID file-tool owner.
 * @param config - verified original source selection; acquisition re-verifies it before launch.
 * @param identity - exact existing configured source identity.
 * @param profileId - same registered provider identity, never a replacement profile.
 * @param getAccess - exact current live idle Y root's existing policy and question lifecycle.
 * @param openPeer - cold managed peer dependency, replaced by fixtures in tests.
 * @param verifySource - exact wrapper/version verification with no model/auth action.
 * @returns separate sequential provider; it makes no external-writer exclusion claim.
 */
export function createCodexSequentialOwner(
  config: CodexSessionSourceConfig, identity: string, profileId: CodingSessionProfileId,
  getAccess: (signal: AbortSignal) => CodexSequentialAccess,
  openPeer: CodexSequentialPeerFactory, verifySource: () => Promise<void>,
): CodexSequentialOwner {
  if (config.knownNoManagedFeatureOverrides !== true) throw new Error('Original Codex sequential ownership requires a trusted absent/false managed-feature declaration.')
  const lifetime = new AbortController()
  let held: { lease: CodingSessionSequentialWriterLease; dispose(): Promise<void> } | undefined
  let acquiring: Promise<unknown> | undefined
  let unresolved: CodexSequentialProcessReleaseError | undefined
  const writer: CodingSessionSequentialWriterProvider = { authority: 'user-acknowledged-sequential', toolMode: 'project-files',
    acquire: async (source, request) => {
      if (unresolved !== undefined) throw unresolved
      if (held !== undefined || acquiring !== undefined) throw new Error('Original Codex profile already has an unresolved sequential owner.')
      const acquire = async (): Promise<CodingSessionSequentialWriterLease> => {
        const acknowledgement = z.literal(true).safeParse(request.nativeProfileUnchanged)
        if (source.provider !== 'codex' || source.profileId !== profileId || !acknowledgement.success || request.ownerToken.length === 0) {
          throw new Error('Original Codex sequential source or stable-profile acknowledgement did not match.')
        }
        const claim = { ...request, signal: AbortSignal.any([request.signal, lifetime.signal]) }
        claim.signal.throwIfAborted(); await verifySource(); claim.signal.throwIfAborted()
        const access = getAccess(claim.signal); const accessKey = accessIdentity(access)
        if (!isAuthority(access.authority)) throw new Error('Original Codex sequential authority requires the exact live Harness root object.')
        await protectProfile(config, access); claim.signal.throwIfAborted()
        const launch = { ...config, cwd: access.cwd }; const policy = policyArguments(access)
        let preflight: CodexSequentialPeer | undefined; let peer: CodexSequentialPeer | undefined
        try {
          preflight = await openPeer(launch, claim, {}, policy)
          // Config enumeration starts no thread and no MCP connection. Never call MCP status here.
          const expectedRequirements = await readRequirements(preflight, claim)
          const base = await readConfig(preflight, access.cwd, claim)
          const servers = disabledServerMap(base, claim.maxEvents); const expectedConfig = restrictedConfig(base, servers)
          const inspectionPeer = preflight
          const preflightProvider = createCodexCodingSessionProvider(identity, config.label, () => ({
            connected: () => inspectionPeer.connected(),
            request: (method, params) => inspectionPeer.request(method, params, claim.signal),
          }))
          const original = await preflightProvider.read(source.nativeSessionId, claim)
          if (original.cwd === undefined || await realpath(original.cwd) !== await realpath(access.cwd)) throw new Error('Original Codex session and selected live Harness project differ.')
          const originalTurns = await savedTurns(preflight, source, access.cwd, claim)
          await preflight.close(claim); preflight = undefined
          claim.signal.throwIfAborted(); const currentBeforeResume = getAccess(claim.signal)
          if (currentBeforeResume.authority !== access.authority || accessIdentity(currentBeforeResume) !== accessKey) throw new Error('Harness authority changed during original Codex acquisition.')
          peer = await openPeer(launch, claim, servers, policy)
          const native = peer
          verifyRestrictedConfig(expectedRequirements ?? {}, await readRequirements(native, claim) ?? {})
          verifyRestrictedConfig(expectedConfig, await readConfig(native, access.cwd, claim))
          const value = resume.parse(await native.request('thread/resume', { threadId: source.nativeSessionId, cwd: access.cwd,
            sandbox: access.sandbox, approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', config: nativeRestrictions(servers), excludeTurns: true }, claim.signal))
          if (value.thread.id !== source.nativeSessionId || value.cwd !== access.cwd || value.thread.cwd !== access.cwd
            || value.thread.status.type !== 'idle' || value.approvalPolicy !== access.approvalPolicy || value.approvalsReviewer !== 'user'
            || sequentialDigest(value.sandbox) !== sequentialDigest(access.sandboxPolicy)) throw new Error('Original Codex resume did not retain the selected identity and exact Harness execution policy.')
          verifyRestrictedConfig(expectedRequirements ?? {}, await readRequirements(native, claim) ?? {})
          verifyRestrictedConfig(expectedConfig, await readConfig(native, access.cwd, claim))
          await verifyServers(native, source, servers, claim)
          claim.signal.throwIfAborted(); const currentAfterResume = getAccess(claim.signal)
          if (currentAfterResume.authority !== access.authority || accessIdentity(currentAfterResume) !== accessKey) throw new Error('Harness authority changed after original Codex resume.')
          type LeasePhase = 'held' | 'turn' | 'releasing' | 'released' | 'blocked'
          let phase: LeasePhase = 'held'
          let expected = original; let exposedCursor = original.cursor; let activeSignal: AbortSignal | undefined
          let turnLifetime: AbortController | undefined
          let activeTurn: string | undefined; let admitting = false; let terminalNotice: z.infer<typeof terminal> | undefined
          let startedGate: Promise<void> | undefined; let finishStart: (() => void) | undefined
          let wake: (() => void) | undefined; let work: Promise<unknown> | undefined
          const nativeTurnIds: CodingSessionNativeTurnId[] = []
          let dispatched = 0; let uncertain = false
          let observeItem: ((item: SkillLearningNativeItem) => Promise<void>) | undefined
          let observationReady = false; let observationCount = 0; let observationBytes = 0
          let observationWork = Promise.resolve()
          const bufferedObservations: SkillLearningNativeItem[] = []
          let expectedTurns = originalTurns
          let expectedClosure = false; let writerClosed = false
          let acceptedReceipt: CodingSessionSequentialReleaseReceipt | undefined
          // Native callbacks and disposal can mutate this closure during any await.
          const interactionState = (): {
            phase: LeasePhase
            signal: AbortSignal | undefined
            turn: string | undefined
            uncertain: boolean
          } => ({ phase, signal: activeSignal, turn: activeTurn, uncertain })
          const provider = (read: CodingSessionReadRequest) => createCodexCodingSessionProvider(identity, config.label, () => ({
            connected: () => native.connected(),
            request: (method, params) => native.request(method, params, read.signal),
          }))
          const check = (signal: AbortSignal): CodexTurnAccess => {
            signal.throwIfAborted(); lifetime.signal.throwIfAborted()
            if (uncertain || native.observedFailure()) throw new Error('Original Codex owner has an observed native failure.')
            const current = getAccess(signal)
            if (current.authority !== access.authority || accessIdentity(current) !== accessKey || !native.connected()) throw new Error('Original Codex sequential authority is stale or disconnected.')
            return current
          }
          const checkpoint = async (read: CodingSessionReadRequest): Promise<CodingSessionSnapshot> => {
            const snapshot = await provider(read).read(source.nativeSessionId, read)
            if (snapshot.writerState !== 'idle') throw new Error('Original Codex owner did not retain an idle native runtime.')
            assertSavedPrefix(expected, snapshot); return snapshot
          }
          const enqueueObservation = (item: SkillLearningNativeItem): void => {
            observationWork = observationWork.then(async () => {
              if (activeSignal === undefined || item.provider !== 'codex' || activeTurn !== item.turnId || phase !== 'turn') throw new Error('Original Codex native observation lost its current turn.')
              check(activeSignal)
              await observeItem?.(item)
              check(activeSignal)
            }).catch(() => { uncertain = true; wake?.() })
          }
          const unsubscribe = native.subscribe((method, params) => {
            if (method === '__closed' && expectedClosure) return
            if (method === '__closed' || method === 'error') {
              uncertain = true; turnLifetime?.abort(new Error('Original Codex native process failed during an admitted interaction.')); wake?.(); return
            }
            if (params.threadId !== undefined && params.threadId !== source.nativeSessionId) { uncertain = true; wake?.(); return }
            if ((method === 'item/started' || method === 'item/completed') && phase === 'turn' && activeSignal !== undefined
              && params.threadId === source.nativeSessionId && (admitting || activeTurn !== undefined)) {
              if (typeof params.turnId !== 'string' || params.turnId.length === 0 || activeTurn !== undefined && params.turnId !== activeTurn) {
                uncertain = true; wake?.(); return
              }
              const item = codexNativeItem(identity, source.nativeSessionId, params.turnId, method === 'item/started' ? 'started' : 'settled', params.item, access.cwd, request.maxEvents)
              if (item !== undefined) {
                observationCount++; observationBytes += Buffer.byteLength(JSON.stringify(item))
                if (observationCount > request.maxEvents || observationBytes > request.maxBytes) { uncertain = true; wake?.(); return }
                if (observationReady) enqueueObservation(item)
                else bufferedObservations.push(item)
              }
            }
            if (method === 'turn/completed' && params.threadId === source.nativeSessionId) {
              const parsed = terminal.safeParse(params.turn)
              if (!parsed.success || parsed.data.status === 'inProgress' || (!admitting && parsed.data.id !== activeTurn)
                || terminalNotice !== undefined) uncertain = true
              else terminalNotice = parsed.data
              wake?.()
            }
          })
          native.onRequest(async (method, params) => {
            if (phase !== 'turn' || activeSignal === undefined || params.threadId !== source.nativeSessionId
              || (activeTurn !== undefined && params.turnId !== activeTurn)) return declineCodexRequest(method, params)
            // No human question may escape before exact native turn correlation.
            if (activeTurn === undefined) {
              if (!admitting || startedGate === undefined) return declineCodexRequest(method, params)
              await startedGate
            }
            const admitted = interactionState()
            if (admitted.phase !== 'turn' || admitted.signal === undefined || admitted.turn === undefined || params.turnId !== admitted.turn) {
              return declineCodexRequest(method, params)
            }
            const requestSignal = admitted.signal; const requestTurn = admitted.turn
            const current = check(requestSignal)
            // Command/file approval acceptance can escape the native sandbox. No
            // shell-text inference or additive permissions grant is safe here.
            if (method !== 'item/tool/requestUserInput') return declineCodexRequest(method, params)
            const answer = await current.request(method, params)
            check(requestSignal)
            const currentInteraction = interactionState()
            if (currentInteraction.phase !== 'turn' || currentInteraction.signal !== requestSignal
              || currentInteraction.turn !== requestTurn || params.turnId !== currentInteraction.turn) {
              return declineCodexRequest(method, params)
            }
            return answer
          })
          const lease: CodingSessionSequentialWriterLease = { source: { ...source },
            read: async (read) => {
              if (phase !== 'held') throw new Error('Original Codex owner is not available for a retained-history read.')
              check(read.signal); const snapshot = await checkpoint(read); check(read.signal)
              if (interactionState().phase !== 'held') throw new Error('Original Codex ownership changed while reading.')
              if (sequentialDigest(snapshot) !== sequentialDigest(expected)) throw new Error('Original Codex history changed while its reviewed owner was held.')
              return { ...snapshot, cursor: exposedCursor }
            },
            resumeOriginal: async (turnRequest) => {
              if (phase !== 'held' || !sameSource(source, turnRequest.source)) throw new Error('Original Codex continuation requires its held exact source.')
              phase = 'turn'
              const admittedLifetime = new AbortController(); turnLifetime = admittedLifetime
              const signal = AbortSignal.any([turnRequest.signal, lifetime.signal, admittedLifetime.signal]); activeSignal = signal
              observeItem = turnRequest.onNativeItem?.bind(turnRequest)
              observationReady = false; observationCount = 0; observationBytes = 0
              observationWork = Promise.resolve(); bufferedObservations.length = 0
              const turnWork = async (): Promise<{ nativeTurnId: CodingSessionNativeTurnId }> => {
                check(signal); await protectProfile(config, check(signal)); await verifySource(); check(signal)
                const read = { ...request, signal }
                verifyRestrictedConfig(expectedRequirements ?? {}, await readRequirements(native, read) ?? {})
                verifyRestrictedConfig(expectedConfig, await readConfig(native, access.cwd, read))
                await verifyServers(native, source, servers, read)
                const beforeTurnIds = await savedTurns(native, source, access.cwd, read)
                if (sequentialDigest([...beforeTurnIds]) !== sequentialDigest([...expectedTurns])) throw new Error('Original Codex saved turn statuses changed before admission.')
                const before = await checkpoint(read)
                if (sequentialDigest(before) !== sequentialDigest(expected)) throw new Error('Original Codex history changed before native turn admission.')
                check(signal); await turnRequest.beforeDispatch(); check(signal)
                if (interactionState().phase !== 'turn') throw new Error('Original Codex ownership closed before native dispatch.')
                admitting = true; dispatched++
                startedGate = new Promise<void>((resolve) => { finishStart = resolve })
                const abort = (): void => {
                  uncertain = true
                  if (activeTurn !== undefined) void native.request('turn/interrupt', { threadId: source.nativeSessionId, turnId: activeTurn }, new AbortController().signal).catch(() => {})
                  wake?.()
                }
                signal.addEventListener('abort', abort, { once: true })
                let cleanTurn = false
                try {
                  const started = z.object({ turn: terminal }).parse(await native.request('turn/start', { threadId: source.nativeSessionId,
                    input: [{ type: 'text', text: turnRequest.text, text_elements: [] }], cwd: access.cwd,
                    sandboxPolicy: access.sandboxPolicy, approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', serviceTierForTurn: 'default' }, signal))
                  activeTurn = started.turn.id
                  if (beforeTurnIds.has(activeTurn) || nativeTurnIds.includes(brandString<CodingSessionNativeTurnId>(activeTurn))) throw new Error('Original Codex reused a prior native turn identity.')
                  await turnRequest.onNativeTurn?.(activeTurn); check(signal)
                  if (bufferedObservations.some(item => item.provider !== 'codex' || item.turnId !== activeTurn)) throw new Error('Original Codex native observations belong to a previous turn.')
                  observationReady = true
                  for (const item of bufferedObservations.splice(0)) enqueueObservation(item)
                  admitting = false; finishStart?.(); finishStart = undefined
                  if (terminalNotice !== undefined && terminalNotice.id !== activeTurn) uncertain = true
                  while (terminalNotice === undefined && !uncertain && !signal.aborted) {
                    await new Promise<void>((resolve) => { wake = resolve })
                  }
                  wake = undefined
                  await observationWork
                  if (uncertain || signal.aborted || native.observedFailure() || terminalNotice?.id !== activeTurn || terminalNotice.status !== 'completed') throw new Error('Original Codex native turn did not establish a clean terminal receipt.')
                  const id = brandString<CodingSessionNativeTurnId>(activeTurn)
                  const after = await checkpoint(read)
                  const afterTurnIds = await savedTurns(native, source, access.cwd, read)
                  const savedInput = after.events.slice(before.events.length).some((event) => {
                    const parts: unknown = JSON.parse(event.id)
                    return Array.isArray(parts) && parts[0] === id && event.role === 'user' && event.text === turnRequest.text
                  })
                  if (afterTurnIds.get(id) !== 'completed' || afterTurnIds.size !== beforeTurnIds.size + 1
                    || [...beforeTurnIds].some(([previous, status]) => afterTurnIds.get(previous) !== status) || !savedInput) {
                    throw new Error('Original Codex completed native turn or exact admitted user input is missing from saved public history.')
                  }
                  await observationWork; check(signal)
                  nativeTurnIds.push(id)
                  expected = after; exposedCursor = after.cursor; expectedTurns = afterTurnIds; check(signal)
                  cleanTurn = true
                  return { nativeTurnId: id }
                } finally {
                  signal.removeEventListener('abort', abort)
                  if (!cleanTurn) phase = 'blocked'
                  admittedLifetime.abort(new Error(cleanTurn ? 'Original Codex admitted turn settled.' : 'Original Codex admitted turn failed.'))
                  admitting = false; finishStart?.(); finishStart = undefined; startedGate = undefined; wake = undefined
                }
              }
              const admittedWork = turnWork(); work = admittedWork
              try { const result = await admittedWork; if (interactionState().phase === 'turn') phase = 'held'; return result }
              catch (error) {
                uncertain = true; phase = 'blocked'
                admittedLifetime.abort(new Error('Original Codex admitted work failed.'))
                await native.dispose().catch(() => {}); throw error
              }
              finally {
                await observationWork
                observeItem = undefined; observationReady = false; bufferedObservations.length = 0
                activeSignal = undefined; activeTurn = undefined; terminalNotice = undefined; work = undefined; turnLifetime = undefined
              }
            },
            release: async (release) => {
              if (unresolved !== undefined) throw unresolved
              if (acceptedReceipt !== undefined) { release.signal.throwIfAborted(); return structuredClone(acceptedReceipt) }
              if (phase === 'releasing') throw new Error('Original Codex ownership release is already in progress.')
              phase = 'releasing'
              const cancelTurn = (): void => { turnLifetime?.abort(new Error('Original Codex release cancelled an unfinished turn.')) }
              release.signal.addEventListener('abort', cancelTurn, { once: true })
              if (release.signal.aborted) cancelTurn()
              if (work !== undefined) await Promise.allSettled([work])
              release.signal.removeEventListener('abort', cancelTurn)
              try {
                if (uncertain || native.observedFailure() || dispatched !== nativeTurnIds.length) throw new Error('Original Codex ownership has unresolved native turn or process evidence.')
                // Cleanup never requires the initiating root to remain registered.
                if (!writerClosed) {
                  expectedClosure = true
                  try { await native.close(release) } finally { expectedClosure = false }
                  if (interactionState().uncertain || native.observedFailure()) throw new Error('Original Codex normal closure observed a native failure.')
                  writerClosed = true; unsubscribe()
                }
                release.signal.throwIfAborted()
                await verifySource(); release.signal.throwIfAborted()
                const reader = await openPeer(launch, release, servers, policy)
                let snapshot: CodingSessionSnapshot
                try {
                  verifyRestrictedConfig(expectedRequirements ?? {}, await readRequirements(reader, release) ?? {})
                  verifyRestrictedConfig(expectedConfig, await readConfig(reader, access.cwd, release))
                  snapshot = await createCodexCodingSessionProvider(identity, config.label, () => ({
                    connected: () => reader.connected(),
                    request: (method, params) => reader.request(method, params, release.signal),
                  })).read(source.nativeSessionId, release)
                  const persisted = await savedTurns(reader, source, access.cwd, release)
                  if (sequentialDigest([...persisted]) !== sequentialDigest([...expectedTurns]) || nativeTurnIds.some(id => persisted.get(id) !== 'completed')) {
                    throw new Error('Original Codex release readback changed saved turn statuses or omitted a completed native turn.')
                  }
                  assertSavedPrefix(expected, snapshot)
                } finally {
                  try { await reader.close(release) }
                  catch (error) {
                    try { await reader.dispose() }
                    catch { unresolved = new CodexSequentialProcessReleaseError('Original Codex readback cleanup left an unresolved owned process range.') }
                    throw error
                  }
                }
                release.signal.throwIfAborted(); phase = 'released'; held = undefined
                acceptedReceipt = { source: { ...source }, snapshot, processExited: true, streamsDrained: true,
                  expectedPrefixPersisted: true,
                  completedTurnPersisted: nativeTurnIds.length > 0, nativeTurnIds: [...nativeTurnIds], noObservedPersistenceErrors: true }
                return structuredClone(acceptedReceipt)
              } catch (error) {
                phase = 'blocked'
                if (error instanceof CodexSequentialProcessReleaseError) unresolved = error
                if (!writerClosed) { uncertain = true; await native.dispose().catch(() => {}) }
                throw error
              }
            },
          }
          const acquired = await checkpoint(claim)
          // Native cold resume appends ThreadSettingsApplied and can touch updatedAt.
          // Only that captured acquisition delta is mapped to the reviewed cursor.
          // All source metadata and ordered projected history must still be exact.
          const reviewedHistory = ({ source, title, cwd, events }: CodingSessionSnapshot) => ({ source, title, cwd, events })
          if (sequentialDigest(reviewedHistory(acquired)) !== sequentialDigest(reviewedHistory(original))) throw new Error('Original Codex public history or metadata changed during acquisition.')
          expected = acquired
          expectedTurns = await savedTurns(native, source, access.cwd, claim)
          if (sequentialDigest([...expectedTurns]) !== sequentialDigest([...originalTurns])) throw new Error('Original Codex saved turn statuses changed during acquisition.')
          check(claim.signal)
          held = { lease, dispose: async () => {
            phase = 'blocked'; turnLifetime?.abort(new Error('Original Codex owner was disposed.'))
            if (work !== undefined) await Promise.allSettled([work]); if (!writerClosed) await native.dispose(); unsubscribe()
          } }
          peer = undefined; return lease
        } catch (error) {
          const cleanup = await Promise.allSettled([
            ...(preflight === undefined ? [] : [preflight.dispose()]),
            ...(peer === undefined ? [] : [peer.dispose()]),
          ])
          if (error instanceof CodexSequentialProcessReleaseError || cleanup.some(result => result.status === 'rejected')) {
            unresolved = new CodexSequentialProcessReleaseError('Original Codex acquisition cleanup left an unresolved owned process range. Another claim is blocked.')
            throw unresolved
          }
          throw error
        }
      }
      acquiring = acquire()
      try { return await acquiring as CodingSessionSequentialWriterLease } finally { acquiring = undefined }
    },
  }
  return { writer, close: async () => {
    lifetime.abort(new Error('Original Codex sequential source was disposed.'))
    if (acquiring !== undefined) await Promise.allSettled([acquiring])
    if (held !== undefined) await held.dispose()
    if (unresolved !== undefined) throw unresolved
  } }
}
