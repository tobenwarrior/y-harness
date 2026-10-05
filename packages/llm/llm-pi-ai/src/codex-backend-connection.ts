/** User-driven Codex backend controls. Codex owns and reads its own auth file. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CodexBackendAdapter, CodexBackendRuntime } from './codex-backend.ts'
import type { CodexPreferences } from './codex-backend.ts'
import { startCodexProcess } from './codex-backend-process.ts'
import type { CodexBackendModelView, CodexBackendView } from './chatgpt-types.ts'

declare module '@deepseek-ai/cordis' { interface Context { codexBackendConnection: CodexBackendConnection } }
/** Independent optional model family; configuring direct ChatGPT never enables it. */
export class CodexBackendConnection extends TypertRemoteService {
  static inject = ['llm']
  private runtime: CodexBackendRuntime | undefined
  private initialization: Promise<CodexBackendRuntime> | undefined
  private disposed = false
  constructor(ctx: Context) {
    super(ctx, 'codexBackendConnection', { namespace: 'codexBackend' })
    ctx.effect(() => () => { this.disposed = true; this.runtime?.close() })
  }
  private async getRuntime(): Promise<CodexBackendRuntime> {
    if (this.disposed) throw new Error('Codex backend is closed.')
    if (this.runtime !== undefined) return this.runtime
    this.initialization ??= (async () => {
      const env = launchEnvironmentOf(this.ctx)
      const required = (key: string): string => { const value = env.get(key)?.value; if (!value) throw new Error('This deployment has no isolated Codex backend configured.'); return value }
      const options = { binary: required('DSH_CODEX_BINARY'), home: required('DSH_CODEX_HOME'), shellHome: required('DSH_CODEX_SHELL_HOME'), cwd: required('DSH_CODEX_CWD'), nodePath: required('DSH_CODEX_NODE') }
      const file = join(options.home, 'harness-backend.json')
      let preferences: CodexPreferences = { enabled: false, models: [], tiers: {} }
      try {
        const value = JSON.parse(await readFile(file, 'utf8')) as CodexPreferences
        if (typeof value.enabled !== 'boolean' || !Array.isArray(value.models) || typeof value.tiers !== 'object' || value.tiers === null) throw new Error('Invalid preferences')
        // The saved file contains only our own display catalog and choices, never native auth.
        for (const model of value.models) if (typeof model.id !== 'string' || typeof model.name !== 'string' || !Array.isArray(model.efforts) || !Array.isArray(model.serviceTiers)) throw new Error('Invalid catalog')
        preferences = value
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex backend preferences could not be read. Restore the local preferences file before continuing.') }
      if (this.disposed) throw new Error('Codex backend is closed.')
      const runtime = new CodexBackendRuntime({ connect: async () => startCodexProcess(options), cwd: options.cwd, preferences, persist: async (next) => {
        await mkdir(options.home, { recursive: true, mode: 0o700 })
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); await rename(temporary, file)
        this.ctx.emit('llm/adapters-updated')
      } })
      this.runtime = runtime
      this.ctx.llm.registerAdapter(['codex-backend'], new CodexBackendAdapter(runtime))
      return runtime
    })().finally(() => { this.initialization = undefined })
    return this.initialization
  }
  /** Read display state without launching Codex or reading its auth file. */
  @Remote
  async getState(): Promise<CodexBackendView> { return (await this.getRuntime()).view() }
  /** Cached display catalog; refreshing is an explicit user action. */
  @Remote
  async models(): Promise<CodexBackendModelView[]> { return (await this.getRuntime()).models() }
  /** Read the native account and model catalog; this sends no model prompt. */
  @Remote
  async refresh(): Promise<CodexBackendView> { return (await this.getRuntime()).refresh() }
  /** Start native device login only after explicit local-file consent. */
  @Remote
  async start(consent: boolean): Promise<{ verificationUrl: string; userCode: string }> { return (await this.getRuntime()).login(consent) }
  /** Cancel this native device login. */
  @Remote
  async cancel(): Promise<void> { await (await this.getRuntime()).cancel() }
  /** Enable the separate family or set a catalog-advertised native service tier. */
  @Remote
  async configure(enabled: boolean, modelId: string | undefined, tier: string | undefined): Promise<CodexBackendView> { return (await this.getRuntime()).configure(enabled, modelId, tier) }
  /** Logout only this separate Codex profile, then withdraw its selectable models. */
  @Remote
  async disconnect(): Promise<CodexBackendView> { return (await this.getRuntime()).logout() }
}
