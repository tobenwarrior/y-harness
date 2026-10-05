/**
 * The Host reads and writes the Models cards perform, as callbacks built in the
 * plugin body. Cards receive these instead of a context: the outcomes name what
 * a card renders — a stored view, a stale revision, a refusal message — so the
 * failure codes and Remote namespaces stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  CodexBackendModelView, CodexBackendView, ChatGPTModelView, CredentialInfo, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What one namespace write answered. */
export type SettingsWriteOutcome =
  /** Committed; the view carries the stored user subtree and the new revision. */
  | { readonly kind: 'written'; readonly view: SettingsNamespaceView }
  /**
   * The stored revision moved after the card read it, so the draft is stale.
   * The message stays for callers that report the Host diagnostic as it is.
   */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Any other refusal, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** What one endpoint interrogation answered. */
export type ModelDiscoveryOutcome =
  /** The candidates the provider disclosed, in its own order. */
  | { readonly kind: 'found'; readonly models: readonly LlmDiscoveredModel[] }
  /** The interrogation was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** Display-safe ChatGPT account state from the Host. */
export interface ChatGPTView {
  accounts: Array<{ id: string; label: string; connected: boolean }>
  activeId?: string
  busy: boolean
  error?: string
}
/** The Host operations the Models page and its cards invoke. */
export interface ModelsOperations {
  codexBackend?: {
    getState(): Promise<CodexBackendView>
    models(): Promise<CodexBackendModelView[]>
    refresh(): Promise<CodexBackendView>
    start(consent: boolean): Promise<{ verificationUrl: string; userCode: string }>
    cancel(): Promise<void>
    configure(enabled: boolean, modelId: string | undefined, tier: string | undefined): Promise<CodexBackendView>
    disconnect(): Promise<CodexBackendView>
  }
  chatGPT?: {
    getState(): Promise<ChatGPTView>
    start(accountId: string | undefined, consent: boolean): Promise<string>
    finish(): Promise<ChatGPTView>
    cancel(): Promise<void>
    disconnect(accountId: string): Promise<boolean>
    select(accountId: string): Promise<ChatGPTView>
    models(): Promise<ChatGPTModelView[]>
  }

  /**
   * Read one credential reference's state.
   * @param ref - credential reference name.
   * @returns the state, or undefined when the reference is unknown or the read was refused.
   */
  describeCredential(ref: string): Promise<CredentialInfo | undefined>
  /**
   * Store one credential literal under its reference.
   * @param ref - credential reference name.
   * @param value - the literal to store.
   * @returns the refusal message, or undefined once stored.
   */
  storeCredential(ref: string, value: string): Promise<string | undefined>
  /**
   * Remove one credential reference (idempotent).
   * @param ref - credential reference name.
   * @returns the refusal message, or undefined once removed.
   */
  removeCredential(ref: string): Promise<string | undefined>
  /**
   * Apply path operations to one settings namespace.
   * @param ns - settings namespace identity.
   * @param ops - ordered path operations against the stored section, as the
   * wire takes them (the Remote signature owns the array).
   * @param expectedRevision - revision the draft was opened at, or undefined to write unfenced.
   * @returns the write outcome the card renders from.
   */
  writeSettings(
    ns: string,
    ops: SettingsPathOpView[],
    expectedRevision: number | undefined,
  ): Promise<SettingsWriteOutcome>
  /**
   * Ask a provider endpoint what models it serves.
   * @param settingsNs - namespace whose adapter family answers.
   * @param request - endpoint facts as the form currently shows them.
   * @returns the candidates, or the refusal.
   */
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<ModelDiscoveryOutcome>
}

/**
 * Bind the page's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the page plugin's context, which declares `remote.credentials`,
 * `remote.llm`, and `remote.settings` in its own `inject`.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createModelsOperations(ctx: ClientContext): ModelsOperations {
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  // The subscription provider is optional; ctx.get resolves it without a required inject.
  const chatGPT = ctx.get('remote.chatGPT') as typeof ctx.remote.chatGPT | undefined
  const codexBackend = ctx.get('remote.codexBackend') as typeof ctx.remote.codexBackend | undefined
  return {
    ...(codexBackend === undefined ? {} : { codexBackend: {
      getState: async () => unwrap(await codexBackend.getState()),
      models: async () => unwrap(await codexBackend.models()),
      refresh: async () => unwrap(await codexBackend.refresh()),
      start: async (consent: boolean) => unwrap(await codexBackend.start(consent)),
      cancel: async () => { unwrap(await codexBackend.cancel()) },
      configure: async (enabled: boolean, modelId: string | undefined, tier: string | undefined) => unwrap(await codexBackend.configure(enabled, modelId, tier)),
      disconnect: async () => unwrap(await codexBackend.disconnect()),
    } }),
    ...(chatGPT === undefined ? {} : { chatGPT: {
      getState: async () => unwrap(await chatGPT.getState()),
      start: async (accountId: string | undefined, consent: boolean) => unwrap(await chatGPT.start(accountId, consent)),
      finish: async () => {
        let state = unwrap(await chatGPT.getState())
        while (state.busy) {
          await new Promise<void>(resolve => setTimeout(resolve, 1000))
          state = unwrap(await chatGPT.getState())
        }
        return state
      },
      disconnect: async (accountId: string) => unwrap(await chatGPT.disconnect(accountId)),
      cancel: async () => { unwrap(await chatGPT.cancel()) },
      select: async (accountId: string) => unwrap(await chatGPT.select(accountId)),
      models: async () => unwrap(await chatGPT.models()),
    } }),
    describeCredential: async (ref) => {
      const response = await ctx.remote.credentials.describe([ref])
      return response.ok ? response.value[ref] : undefined
    },
    storeCredential: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeCredential: async (ref) => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    writeSettings: async (ns, ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(ns, ops, expectedRevision)
      if (response.ok) return { kind: 'written', view: response.value }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict', message } : { kind: 'refused', message }
    },
    discoverModels: async (settingsNs, request) => {
      const response = await ctx.remote.llm.discoverModels(settingsNs, request)
      return response.ok
        ? { kind: 'found', models: response.value }
        : { kind: 'refused', message: response.error.message }
    },
  }
}
