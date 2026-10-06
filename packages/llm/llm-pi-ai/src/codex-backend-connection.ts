/** User-driven Codex backend controls. Codex owns and reads its own auth file. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CodexBackendAdapter, CodexBackendRuntime } from './codex-backend.ts'
import type { CodexPreferences } from './codex-backend.ts'
import { startCodexProcess } from './codex-backend-process.ts'
import { resolveCodexAccess } from './codex-backend-access.ts'
import type { CodexBackendModelView, CodexBackendView } from './codex-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { codexBackendConnection: CodexBackendConnection } }
/** Independent optional model family. */
export class CodexBackendConnection extends TypertRemoteService {
  static inject = ['llm']
  private runtime: CodexBackendRuntime | undefined
  private initialization: Promise<CodexBackendRuntime> | undefined
  private disposed = false
  constructor(ctx: Context) {
    super(ctx, 'codexBackendConnection', { namespace: 'codexBackend' })
    ctx.effect(() => () => { this.disposed = true; this.runtime?.close() })
    // Restore only our display preferences and route. No subprocess or native auth read.
    void this.getRuntime().catch(() => {})
  }
  private async getRuntime(): Promise<CodexBackendRuntime> {
    if (this.disposed) throw new Error('Codex backend is closed.')
    if (this.runtime !== undefined) return this.runtime
    this.initialization ??= (async () => {
      const env = launchEnvironmentOf(this.ctx)
      const required = (key: string): string => { const value = env.get(key)?.value; if (!value) throw new Error('This deployment has no isolated Codex backend configured.'); return value }
      const options = { binary: required('DSH_CODEX_BINARY'), home: required('DSH_CODEX_HOME'), shellHome: required('DSH_CODEX_SHELL_HOME'), cwd: required('DSH_CODEX_CWD'), nodePath: required('DSH_CODEX_NODE') }
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
      const runtime = new CodexBackendRuntime({ connect: handleRequest => Promise.resolve(startCodexProcess(options, handleRequest)),
        resolveAccess: request => resolveCodexAccess(this.ctx, request), preferences,
        resolveAttachments: () => this.ctx.get('attachments'),
        persist: async (next) => {
          await mkdir(options.home, { recursive: true, mode: 0o700 })
          const temporary = `${file}.${randomUUID()}.tmp`
          await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temporary, file)
          register()
          this.ctx.emit('llm/adapters-updated')
        } })
      this.runtime = runtime
      const adapter = new CodexBackendAdapter(runtime)
      register()
      return runtime
    })().finally(() => { this.initialization = undefined })
    return this.initialization
  }
  /**
   * Read display state without launching Codex or reading its auth file.
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
