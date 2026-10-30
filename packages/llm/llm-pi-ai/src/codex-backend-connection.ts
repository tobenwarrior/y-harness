/** User-driven Codex backend controls. Codex owns and reads its own auth file. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import Schema from '@yharness/schemastery'
import { Context } from '@yharness/cordis'
import type { AdapterRegistrationHandle } from '@yharness/llm'
import { launchEnvironmentOf } from '@yharness/launch-environment'
import { Remote, TypertRemoteService } from '@yharness/typert-protocol'
import {
  CodexBackendAdapter,
  CodexBackendRuntime,
  DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  DEFAULT_DYNAMIC_TOOL_REPLAY_MAX_BYTES,
  MAX_DYNAMIC_TOOL_REPLAY_MAX_BYTES,
} from './codex-backend.ts'
import type { CodexDynamicToolEvent } from './codex-backend.ts'
import type { CodexPreferences } from './codex-backend.ts'
import { prepareCodexHomeDirectories, startCodexProcess, type CodexProcessOptions } from './codex-backend-process.ts'
import { resolveCodexAccess } from './codex-backend-access.ts'
import type { CodexBackendModelView, CodexBackendView } from './codex-types.ts'
import type {} from '@yharness/skill-library'
import type {} from '@yharness/workspace'
import type {} from '@yharness/subprocess'
import { createCodexSkillLibraryProvider } from './codex-skill-library.ts'

import type {} from '@yharness/coding-session'
import { createCodexCodingSessionProvider } from './codex-coding-sessions.ts'

/** Deployment-owned bounds for sanitized native learning observations. */
export interface CodexBackendConnectionConfig {
  /** Maximum distinct retained native tool identities per turn. */
  nativeEvidenceMaxItems?: number
  /** Startup and periodic catalog refresh cadence for an enabled ChatGPT account. */
  catalogRefreshIntervalMs?: number
  /** UTF-8 byte budget for persisted native Bot action replay. */
  dynamicToolReplayMaxBytes?: number
}


declare module '@yharness/cordis' { interface Context { codexBackendConnection: CodexBackendConnection } }
/** Independent optional model family. */
export class CodexBackendConnection extends TypertRemoteService {
  static inject = ['llm', 'subprocess']
  static Config = Schema.object({
    nativeEvidenceMaxItems: Schema.natural().min(1).default(64),
    catalogRefreshIntervalMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(DEFAULT_CATALOG_REFRESH_INTERVAL_MS),
    dynamicToolReplayMaxBytes: Schema.natural().min(1024).max(MAX_DYNAMIC_TOOL_REPLAY_MAX_BYTES)
      .default(DEFAULT_DYNAMIC_TOOL_REPLAY_MAX_BYTES),
  })
  private runtime: CodexBackendRuntime | undefined
  private initialization: Promise<CodexBackendRuntime> | undefined
  private disposed = false
  constructor(ctx: Context, private readonly config: Required<CodexBackendConnectionConfig>) {
    super(ctx, 'codexBackendConnection', { namespace: 'codexBackend' })
    ctx.effect(() => async () => {
      this.disposed = true
      await this.initialization?.catch(() => {})
      await this.runtime?.close()
    })
    ctx.inject(['skillLibrary'], (child) => {
      child.effect(() => child.skillLibrary.registerNativeProvider(createCodexSkillLibraryProvider(() => this.runtime)))
    })
    const home = launchEnvironmentOf(ctx).get('DSH_CODEX_HOME')?.value
    if (home !== undefined) ctx.inject(['codingSessions'], (child) => {
      child.effect(() => child.codingSessions.registerProvider(createCodexCodingSessionProvider(
        `home:${createHash('sha256').update(home).digest('hex')}`, 'Codex', () => this.runtime?.codingSessionReader(),
      )), 'codex-backend: read-only coding sessions')
    })
    // Restore only our display preferences and route. No subprocess or native auth read.
    void this.getRuntime().catch(() => {})
  }
  private async getRuntime(): Promise<CodexBackendRuntime> {
    if (this.disposed) throw new Error('Codex backend is closed.')
    if (this.runtime !== undefined) return this.runtime
    this.initialization ??= (async () => {
      const env = launchEnvironmentOf(this.ctx)
      const required = (key: string): string => { const value = env.get(key)?.value; if (!value) throw new Error('This deployment has no isolated Codex backend configured.'); return value }
      const options: CodexProcessOptions = { binary: required('DSH_CODEX_BINARY'), home: required('DSH_CODEX_HOME'), shellHome: required('DSH_CODEX_SHELL_HOME'), cwd: required('DSH_CODEX_CWD'), nodePath: required('DSH_CODEX_NODE') }
      const file = join(options.home, 'harness-backend.json')
      let preferences: CodexPreferences = { enabled: false, models: [], tiers: {}, auto: true }
      try {
        const raw = await readFile(file, 'utf8')
        if (raw.length > 2 * 1024 * 1024) throw new Error('Preferences exceeded the size limit')
        // The saved file contains only our display catalog and choices, never native auth.
        // Modality and default-tier fields are optional so a catalog written
        // before they existed still loads; the next refresh fills them in.
        const parsed = z.object({
          enabled: z.boolean(), auto: z.boolean().optional(), tiers: z.record(z.string(), z.string()),
          models: z.array(z.object({
            id: z.string(), name: z.string(), description: z.string(), defaultEffort: z.string().optional(),
            efforts: z.array(z.object({ id: z.string(), description: z.string() })),
            serviceTiers: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
            defaultServiceTier: z.string().optional(),
            inputModalities: z.array(z.enum(['text', 'image'])).optional(),
          })),
        }).parse(JSON.parse(raw))
        preferences = { ...parsed, auto: parsed.auto ?? true, models: parsed.models.map((model) => {
          const { defaultEffort, defaultServiceTier, inputModalities, ...rest } = model
          return {
            ...rest,
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
            ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
            inputModalities: inputModalities ?? ['text', 'image'],
          }
        }) }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex backend preferences could not be read. Restore the local preferences file before continuing.') }
      if (this.disposed) throw new Error('Codex backend is closed.')
      let registration: AdapterRegistrationHandle | undefined
      const register = (): void => {
        const routes = runtime.view().enabled ? ['codex-backend'] : []
        if (registration === undefined) { if (routes.length > 0) registration = this.ctx.llm.registerAdapter(routes, adapter) }
        else registration.replace(routes)
      }
      const runtime = new CodexBackendRuntime({ connect: async (handleRequest) => {
        await prepareCodexHomeDirectories(options)
        return startCodexProcess(options, handleRequest, spec => this.ctx.subprocess.spawn(spec))
      },
      resolveAccess: request => resolveCodexAccess(this.ctx, request), preferences,
      resolveAttachments: () => this.ctx.get('attachments'),
      resolveObservationProjectRoot: (request) => {
        const session = request.sessionId === undefined ? undefined : this.ctx.get('sessions')?.get(request.sessionId)
        if (session?.header.cwd === undefined) return undefined
        return this.ctx.get('workspaceRegistry')?.list().find(project => project.path === session.header.cwd)?.path
      },
      connectionId: createHash('sha256').update(JSON.stringify([options.home, options.binary])).digest('hex'),
      nativeEvidenceMaxItems: this.config.nativeEvidenceMaxItems,
      catalogRefreshIntervalMs: this.config.catalogRefreshIntervalMs,
      dynamicToolReplayMaxBytes: this.config.dynamicToolReplayMaxBytes,
      notifyViewChanged: () => { if (!this.disposed) this.ctx.emit('llm/adapters-updated') },
      observeNativeItem: (request, item) => {
        const session = request.sessionId === undefined ? undefined : this.ctx.get('sessions')?.get(request.sessionId)
        if (session === undefined) return
        session.append('skill/native-item', item, { ignorable: true })
      },
      resolveDynamicTools: request => this.ctx.get('codexDynamicTools')?.resolve(request) ?? [],
      observeDynamicTool: event => this.observeDynamicTool(event),
      replayDynamicTools: request => this.ctx.get('codexDynamicTools')?.replay?.(request) ?? [],
      persist: async (next) => {
        if (this.disposed) throw new Error('Codex backend is closed.')
        await mkdir(options.home, { recursive: true, mode: 0o700 })
        const temporary = `${file}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
          if (this.disposed) throw new Error('Codex backend is closed.')
          await rename(temporary, file)
        } finally {
          await rm(temporary, { force: true })
        }
        if (this.disposed) return
        register()
        this.ctx.emit('llm/adapters-updated')
      } })
      this.runtime = runtime
      const adapter = new CodexBackendAdapter(runtime)
      register()
      runtime.startAutomaticRefresh()
      return runtime
    })().finally(() => { this.initialization = undefined })
    return this.initialization
  }
  /** Forward native action lifecycles to the optional host-owned durable observer. */
  private observeDynamicTool(event: CodexDynamicToolEvent): void | Promise<void> {
    const observer = this.ctx.get('codexDynamicTools')?.observe
    if (observer === undefined) throw new Error('Native Codex dynamic tools have no durable observer.')
    return observer(event)
  }
  /**
   * Read display state while an enabled connection may refresh in the background.
   * @returns the current enablement, connection, and running state.
   */
  @Remote
  async getState(): Promise<CodexBackendView> { return (await this.getRuntime()).view() }
  /**
   * Cached display catalog; refreshing is an explicit user action.
   * @returns the stored native model catalog.
   */
  @Remote
  async models(): Promise<CodexBackendModelView[]> { return (await this.getRuntime()).models() }
  /**
   * Read the native account and model catalog; this sends no model prompt.
   * @returns the refreshed display state.
   */
  @Remote
  async refresh(): Promise<CodexBackendView> { return (await this.getRuntime()).refresh() }
  /**
   * Start native device login only after explicit local-file consent.
   * @param consent - whether the user consented to storing native credentials locally.
   * @returns the device verification URL and user code.
   */
  @Remote
  async start(consent: boolean): Promise<{ verificationUrl: string; userCode: string }> {
    return (await this.getRuntime()).login(consent)
  }
  /**
   * Cancel this native device login.
   * @returns fulfillment after the pending login is cancelled.
   */
  @Remote
  async cancel(): Promise<void> { await (await this.getRuntime()).cancel() }
  /**
   * Publish a connected account's catalog while the user has not chosen otherwise.
   * @returns the resulting display state, unchanged when the account or catalog is not ready.
   */
  @Remote
  async publish(): Promise<CodexBackendView> { return (await this.getRuntime()).publish() }
  /**
   * Enable the separate family or set a catalog-advertised native service tier.
   * @param enabled - whether the route accepts turns.
   * @param modelId - model whose processing tier changes; omit to change enablement only.
   * @param tier - catalog-advertised tier id, or `default` for standard speed.
   * @returns the resulting display state.
   */
  @Remote
  async configure(enabled: boolean, modelId: string | undefined, tier: string | undefined): Promise<CodexBackendView> {
    return (await this.getRuntime()).configure(enabled, modelId, tier)
  }
  /**
   * Logout only this separate Codex profile, then withdraw its selectable models.
   * @returns the resulting display state.
   */
  @Remote
  async disconnect(): Promise<CodexBackendView> { return (await this.getRuntime()).logout() }
}
