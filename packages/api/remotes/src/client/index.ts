/** Platform-neutral assembly of generated Host Remote contributions. */

import type { Context } from '@yharness/cordis'
import productAnalyticsRemote from '@yharness/client-product-analytics/remote'
export type {} from '@yharness/client-product-analytics/remote'
import agentPresetsRemote from '@yharness/agent-preset-registry/remote'
import userQuestionsRemote from '@yharness/user-questions/remote'
import commandsRemote from '@yharness/commands/remote'
import accountRemote from '@yharness/api-account-controller/remote'
import settingsControllerRemote from '@yharness/api-settings-controller/remote'
import officeToPdfRemote from '@yharness/office-to-pdf/remote'
import skillLibraryRemote from '@yharness/skill-library/remote'
import codingSessionsRemote from '@yharness/coding-session/remote'
export type {} from '@yharness/coding-session/remote'
export type * from '@yharness/coding-session/types'
export type {} from '@yharness/skill-library/remote'
import goalsRemote from '@yharness/goal/remote'
import scheduleRemote from '@yharness/schedule/remote'
import piAiRemote from '@yharness/llm-pi-ai/remote'
export type {} from '@yharness/llm-pi-ai/remote'
import llmRemote from '@yharness/llm/remote'
import dynamicRemote from '@yharness/cordis-host-runner/remote'
import pluginManagerRemote from '@yharness/plugin-manager/remote'
import pluginRegistryProbeRemote from '@yharness/client-ui-plugin-manager/remote'
import pluginInventoryRemote from '@yharness/host-plugin-inventory/remote'
import messageFeedbackRemote from '@yharness/message-feedback/remote'
import permissionPresetsRemote from '@yharness/permission-presets/remote'
import sessionFeedbackRemote from '@yharness/command-feedback/remote'
import fileUploadsRemote from '@yharness/client-file-upload/remote'
import sessionReferencesRemote from '@yharness/session-reference/remote'
import subagentsRemote from '@yharness/subagent/remote'
import sessionRemote from '@yharness/api-session-controller/remote'
import jobRemote from '@yharness/api-job-controller/remote'
import workspaceRemote from '@yharness/api-workspace-controller/remote'
import terminalRemote from '@yharness/api-terminal-controller/remote'
import botsRemote from '@yharness/bots/remote'
import avatarGenerationRemote from '@yharness/avatar-generation/remote'
import workspaceFilesRemote from '@yharness/api-workspace-files/remote'
import type { ClientRemote } from '@yharness/api-gateway/client'

export type { ClientRemote } from '@yharness/api-gateway/client'
export type {
  BundleInfo, BundleRowInfo, ChangeResult, IncompatiblePlugin, InspectOptions, InstallBundleOptions, InstallSpecKind, ManagementError,
  PackageResult,
  PluginChange, PluginEntryId, PluginInfo, PluginInspectProblem, PluginInstallCancellation, PluginInstallFailureKind,
  PluginInstallLogChunk, PluginInstallProgress, PluginInstallRequestId, PluginRegistries, PluginSpecInspection, ReadOnlyReason, Registry,
} from '@yharness/plugin-manager/types'
export type {} from '@yharness/plugin-manager/remote'
export type {} from '@yharness/client-ui-plugin-manager/remote'
export type { PluginInventorySnapshot } from '@yharness/host-plugin-inventory/types'
export type {} from '@yharness/agent-preset-registry/remote'
export type {} from '@yharness/user-questions/remote'
export type {} from '@yharness/commands/remote'
export type {} from '@yharness/api-settings-controller/remote'
export type {} from '@yharness/api-account-controller/remote'
export type {} from '@yharness/goal/remote'
export type {} from '@yharness/schedule/remote'
export type {} from '@yharness/office-to-pdf/remote'
export type {} from '@yharness/llm/remote'
export type {} from '@yharness/host-plugin-inventory/remote'
export type {} from '@yharness/message-feedback/remote'
export type {} from '@yharness/permission-presets/remote'
export type {} from '@yharness/command-feedback/remote'
export type {} from '@yharness/client-file-upload/remote'
export type {} from '@yharness/session-reference/remote'
export type {} from '@yharness/subagent/remote'
export type * from '@yharness/subagent/client'
export type {} from '@yharness/api-session-controller/remote'
export type * from '@yharness/api-session-controller/types'
export type {} from '@yharness/api-job-controller/remote'
export type * from '@yharness/api-job-controller/types'
export type {} from '@yharness/api-workspace-controller/remote'
export type * from '@yharness/api-workspace-controller/types'
export type {} from '@yharness/api-workspace-files/remote'
export type * from '@yharness/api-workspace-files/types'
export type {} from '@yharness/api-terminal-controller/remote'
export type * from '@yharness/api-terminal-controller/types'
export type {} from '@yharness/bots/remote'
export type * from '@yharness/bots/types'
export type {} from '@yharness/avatar-generation/remote'
export type * from '@yharness/avatar-generation/types'
// The forwarded-event allowlist's selection seat: without it in the consumer's
// compilation face `TypertRemoteEvent` is `never` and every `$on` call fails.
export type { ApiRemoteForwardedEvent } from '../types.ts'
// The owner packages' client-safe `./types` exports supply the `Events`
// signatures `$on` hands to a listener, so a consumer reads the very
// declaration the Host emits rather than a flattened restatement of it.
export type {} from '@yharness/commands/types'
export type {} from '@yharness/cordis-host-runner/types'
export type {} from '@yharness/credentials/types'
export type {} from '@yharness/llm/types'
export type {} from '@yharness/agent-preset-registry/types'
export type {} from '@yharness/permission-presets/types'
export type {} from '@yharness/settings/types'
export type {} from '@yharness/user-approval/types'
export type {} from '@yharness/user-questions/types'
export type {} from '@yharness/api-session-controller/types'

/**
 * The carrier's Client-facing types, re-exported so a business package names one
 * assembly package instead of both this facade and the Connection plugin. Type-only:
 * the carrier's runtime values stay behind their own module edge.
 */
export type {
  ConnectionHandle, ConnectionSinks, ContentBlock,
  MessageId,
  RpcId, RpcRequest, RpcResponse, RpcResult, SessionId,
  StreamChunk,
} from '@yharness/client-connection/client'
export type {} from '@yharness/api-gateway/client'
export type {} from '@yharness/cordis-host-runner/remote'

// The payload vocabulary of the selected namespaces, re-exported so a Client
// contribution can name what it sends and receives without importing a Host
// package: this assembly is the one place both planes legitimately meet.
export type {
  ApprovalRequestId,
  CordisHalfState,
  CordisDynamicPackageId,
  CordisDynamicPluginId,
  CordisDynamicPluginRunId,
  CordisDynamicRunMode,
  CordisInspectMethodManifest,
  CordisInspectPlatform,
  CordisInspectProviderManifest,
  CordisInspectProviderView,
  CordisInspectQueryRequest,
  CordisInspectQueryResolution,
  CordisInspectQueryResolved,
  CordisInspectRequestId,
  CordisInspectResolveAck,
  CordisRunDiagnostic,
  CordisRunStatus,
  DynamicCordisClientSource,
  DynamicCordisHostHalfResult,
  DynamicCordisInventoryRow,
  DynamicCordisInvokeResult,
  DynamicCordisPackage,
  DynamicCordisRequestResolved,
  DynamicCordisResolveAck,
  DynamicCordisRetracted,
  DynamicCordisRunRequest,
  DynamicCordisRunResolution,
  DynamicCordisRunAttempt,
  DynamicCordisRunResponse,
  DynamicCordisStopResponse,
  DynamicCordisUndefineReceipt,
  RequestRunOutcome,
} from '@yharness/cordis-host-runner/types'
// Credential state vocabulary for the credentials namespace (values never ride it).
export type { CredentialInfo } from '@yharness/credentials/types'
// Redacted namespace vocabulary for the settings namespace (secrets never ride
// it). It travels with its seam, whose `./types` the Client face already reads.
export type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
} from '@yharness/settings/types'
// Provider registry and discovery vocabulary for the llm namespace.
export type {
  LlmConfigurableProvider, LlmDiscoveredModel,
  LlmModelDiscoveryRequest, LlmProviderInfo,
} from '@yharness/llm/types'
// Reference-discovery result vocabulary for the fileReferences and
// sessionReferenceResolver namespaces.
export type { FileReferenceCandidate } from '@yharness/file-reference/types'
export type { SessionReferenceMentionCandidate } from '@yharness/session-reference/types'

// The Remote failure vocabulary, re-exported so business packages keep naming
// this assembly alone. Types only: a value export would make spec imports load
// this module's owner /remote artifacts; specs take RemoteError from
// dsh-client-test-runtime instead.
export type {
  RemoteErrorCode, RemoteErrorDetailsMap, RemoteFailure, RemoteResult,
} from '@yharness/typert-protocol'
export type { RemoteHostFacts } from '@yharness/api-gateway/client'

declare module '@yharness/cordis' {
  interface Context {
    /** Generated Remote namespaces selected by this Client assembly. */
    remote: ClientRemote
  }
}

/** Required service: the typed Client Remote contribution mount. */
export const inject = ['remote']

/**
 * Mount the Host capabilities explicitly selected for this Client assembly.
 * @param ctx - Client Cordis root carrying the typed API service.
 * @returns disposer after every selected Remote namespace is ready.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [
      productAnalyticsRemote, agentPresetsRemote, commandsRemote, settingsControllerRemote, accountRemote,
      goalsRemote, llmRemote, piAiRemote, dynamicRemote, scheduleRemote,
      pluginInventoryRemote, pluginManagerRemote, pluginRegistryProbeRemote, messageFeedbackRemote, sessionFeedbackRemote,
      fileUploadsRemote, sessionReferencesRemote,
      permissionPresetsRemote, subagentsRemote, sessionRemote, jobRemote, workspaceRemote, workspaceFilesRemote, terminalRemote,
      officeToPdfRemote, userQuestionsRemote, skillLibraryRemote, codingSessionsRemote, botsRemote, avatarGenerationRemote,
    ]) {
      disposers.push(await ctx.remote.$mount(contribution))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  // Unwound in reverse mount order, so a namespace never outlives one mounted
  // after it.
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}

export type { CodexBackendModelView, CodexBackendView, NousConnectionView, NousDeviceVerification, NousModelView, XaiConnectionView, XaiDeviceVerification, XaiModelView } from '@yharness/llm-pi-ai/types'
