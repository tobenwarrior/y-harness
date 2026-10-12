/** Opt-in original Codex profiles are separate from model backend enablement. */
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-coding-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { CodingSessionProvider, CodingSessionReadRequest } from '@deepseek-ai/dsh-coding-session/types'
import { createCodexCodingSessionProvider } from './codex-coding-sessions.ts'
import { CodexSessionSourceReleaseError, openCodexSessionReadPeer } from './codex-session-source-process.ts'
import { resolveCodexAccess } from './codex-backend-access.ts'
import { createCodexSequentialOwner } from './codex-sequential.ts'
import type { CodexSequentialAccess } from './codex-sequential.ts'
import { openCodexSequentialPeer } from './codex-sequential-process.ts'

/** Explicit authorized local source and non-credential binary verification inputs. */
export interface CodexSessionSourceConfig {
  /** Stable deployment-owned identity for this explicitly selected source. */
  id: string
  /** Human-readable source label shown beside native session identities. */
  label: string
  /** Absolute original native CODEX_HOME selected by the user. */
  home: string
  /** Absolute bin.codex Node wrapper belonging to the selected official package. */
  binary: string
  /** Absolute package.json of the selected @openai/codex installation. */
  packageManifest: string
  /** Exact lowercase SHA-256 of the selected wrapper, checked before every read. */
  binarySha256: string
  /** Supported native package and handshake version; currently 0.160.0. */
  version: string
  /** Explicit absolute Node executable used for the selected wrapper. */
  nodePath: string
  /** Explicit child shell home, separate from the native profile. */
  shellHome: string
  /** Explicit app-server launch directory; does not restrict native thread history. */
  cwd: string
  /** Managed process termination grace, in milliseconds. */
  graceMs: number
  /** Default-off practical original-ID handoff with confined patch/read tools; native shell/escalation unavailable. */
  enableSequentialProjectFiles?: boolean
  /** Trusted deployment declaration: selected account/profile/machine managed features are absent or all false and remain unchanged. */
  knownNoManagedFeatureOverrides?: boolean
}
/** Native source registration is opt-in; omitted sources select no native profile. */
export interface Config {
  /** Explicit original-profile read sources; empty by default and independent from model enablement. */
  sources: CodexSessionSourceConfig[]
}
/** Function plugin subpath mounts without an LLM/model service. */
export const name = 'coding-session-source-codex'
/** History service and managed-process ownership only. */
export const inject = ['codingSessions', 'subprocess']
/** Explicit source paths have no personal-home or binary defaults. */
export const Config: z<Config> = z.object({ sources: z.array(z.object({
  id: z.string().required(), label: z.string().required(), home: z.string().required(), binary: z.string().required(),
  packageManifest: z.string().required(), binarySha256: z.string().required(), version: z.string().required(),
  nodePath: z.string().required(), shellHome: z.string().required(), cwd: z.string().required(),
  graceMs: z.natural().min(1).max(60000).default(2000),
  enableSequentialProjectFiles: z.boolean().default(false),
  knownNoManagedFeatureOverrides: z.boolean().default(false),
})).default([]) })
const packageMetadata = schema.object({ name: schema.literal('@openai/codex'), version: schema.string(),
  bin: schema.object({ codex: schema.string() }) })

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > maximum) throw new Error('Original Codex verification input exceeded its byte limit.')
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

/**
 * Verify only the explicitly selected wrapper and package metadata; native auth/config files are not read.
 * @param config - source selection including exact expected wrapper digest/version.
 * @returns completion after exact package, version, bin target and digest verification.
 */
export async function verifyCodexSessionSource(config: CodexSessionSourceConfig): Promise<void> {
  try { await verifySelectedSource(config) } catch (error) {
    if (error instanceof Error && error.message.startsWith('Original Codex')) throw error
    throw new Error('Original Codex source could not verify the selected package and wrapper.')
  }
}
async function verifySelectedSource(config: CodexSessionSourceConfig): Promise<void> {
  if (![config.home, config.binary, config.packageManifest, config.nodePath, config.shellHome, config.cwd].every(isAbsolute)) {
    throw new Error('Original Codex source requires explicit absolute paths.')
  }
  if (config.version !== '0.160.0') throw new Error('Original Codex source requires the verified 0.160.0 version.')
  if (!/^[a-f0-9]{64}$/.test(config.binarySha256)) throw new Error('Original Codex source requires an exact SHA-256 wrapper hash.')
  const raw = await boundedFile(config.packageManifest, 64 * 1024)
  const metadata = packageMetadata.parse(JSON.parse(raw.toString('utf8')))
  if (metadata.version !== config.version) throw new Error('Original Codex package version differs from the selected version.')
  const [binary, declared] = await Promise.all([
    realpath(config.binary), realpath(resolve(dirname(config.packageManifest), metadata.bin.codex)),
  ])
  if (binary !== declared) throw new Error('Original Codex binary is not the selected package wrapper.')
  const digest = createHash('sha256').update(await boundedFile(config.binary, 1024 * 1024)).digest('hex')
  if (digest !== config.binarySha256) throw new Error('Original Codex binary hash changed. Verify the source selection again.')
}

/** Configured source owns cancellation and all temporary native readers. */
export interface ConfiguredCodexSessionProvider extends CodingSessionProvider {
  /** Cancel reads and await every managed native reader. @returns completed process-range release. */
  close(): Promise<void>
}
/**
 * Prepare an original-profile reader without launching a process or changing model/auth configuration.
 * @param input - explicitly authorized and independently verified original profile selection.
 * @param spawn - managed process owner; each read operation owns one private peer.
 * @param getAccess - optional exact live Y root authority for the separately declared sequential subset.
 * @returns read-only source with awaited disposal; a read re-verifies the binary before spawning.
 */
export function createConfiguredCodexSessionProvider(
  input: CodexSessionSourceConfig, spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  getAccess?: (signal: AbortSignal) => CodexSequentialAccess,
): ConfiguredCodexSessionProvider {
  const config = { ...input }
  const lifetime = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let releaseFailure: CodexSessionSourceReleaseError | undefined
  const identity = `original:${createHash('sha256').update(JSON.stringify([config.id, resolve(config.home)])).digest('hex')}`
  const profileId = createCodexCodingSessionProvider(identity, config.label, () => undefined).profileId
  const declaredSequential = config.enableSequentialProjectFiles === true && config.knownNoManagedFeatureOverrides === true
  if (declaredSequential && getAccess === undefined) throw new Error('Sequential Codex file tools require exact live Harness policy authority.')
  const sequential = declaredSequential && getAccess !== undefined
    ? createCodexSequentialOwner(config, identity, profileId, getAccess,
      (selected, request, servers, policyArguments) => openCodexSequentialPeer(selected, request, servers, spawn, policyArguments),
      () => verifyCodexSessionSource(config)) : undefined
  const run = async <T>(request: CodingSessionReadRequest, read: (provider: CodingSessionProvider) => Promise<T>): Promise<T> => {
    if (releaseFailure !== undefined) throw releaseFailure
    const signal = AbortSignal.any([request.signal, lifetime.signal]); signal.throwIfAborted()
    await verifyCodexSessionSource(config); signal.throwIfAborted()
    const peer = await openCodexSessionReadPeer(config, { ...request, signal }, spawn)
    try { return await read(createCodexCodingSessionProvider(identity, config.label, () => peer.reader)) }
    finally { await peer.close() }
  }
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work); void work.then(() => { pending.delete(work) }, (error: unknown) => {
      if (error instanceof CodexSessionSourceReleaseError) { releaseFailure = error; lifetime.abort(error) }
      pending.delete(work)
    }); return work
  }
  return { provider: 'codex', profileId,
    ...(sequential === undefined ? {} : { sequentialWriter: sequential.writer }),
    label: config.label, connected: () => !lifetime.signal.aborted && releaseFailure === undefined,
    discover: (request, cursor) => own(run(request, provider => provider.discover(request, cursor))),
    read: (id, request) => own(run(request, provider => provider.read(id, request))),
    close: async () => {
      lifetime.abort(new Error('Original Codex source is closed.')); await Promise.allSettled([...pending])
      await sequential?.close()
      if (releaseFailure !== undefined) throw releaseFailure
    },
  }
}

/**
 * Register only explicitly configured sources, independently from model controls.
 * @param ctx - injected history and managed-process services.
 * @param config - opt-in exact original source selections.
 * @returns after verified source registration; no native process starts during mounting.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const seen = new Set<string>()
  for (const source of config.sources) {
    if (seen.has(source.id)) throw new Error('Original Codex source IDs must be distinct.')
    seen.add(source.id)
    await ctx.effect(async () => {
      await verifyCodexSessionSource(source)
      const provider = createConfiguredCodexSessionProvider(source, spec => ctx.subprocess.spawn(spec), (signal) => {
        const agents = ctx.get('agents'); const agent = agents?.currentInitiator()
        if (agent === undefined || !agents?.roots().includes(agent) || agent.status !== 'idle'
          || ctx.get('sessions')?.get(agent.session.id) !== agent.session) {
          throw new Error('Sequential Codex requires the exact live idle Harness root before every native action.')
        }
        return { ...resolveCodexAccess(ctx, { sessionId: agent.session.id, signal }), authority: agent }
      })
      const unregister = ctx.codingSessions.registerProvider(provider)
      return async () => {
        const errors: unknown[] = []
        // Await retained original-owner release/readback before closing the
        // source/process seam it still requires. Both failures stay visible.
        try { await unregister() } catch (error) { errors.push(error) }
        try { await provider.close() } catch (error) { errors.push(error) }
        if (errors.length > 0) throw new AggregateError(errors, 'Original Codex source disposal remains uncertain.')
      }
    }, 'coding-session-source-codex: original profile')
  }
}
