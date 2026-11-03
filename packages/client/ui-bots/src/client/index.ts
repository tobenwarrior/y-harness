/** Bot workspace registration and UI types for client compositions. */
export { apply, inject } from './apply.ts'
export type { BotShareActions, BotWorkspaceFace, BotWorkspaceRemote, BotWorkspaceState } from './controller.ts'
export { createSharedBotsClient } from './shared-client.ts'
export type {
  SharedBotClientResult,
  SharedBotMemoryValue,
  SharedBotMemoryWriteValue,
  SharedBotsClient,
} from './shared-client.ts'
export type { BotAccent, BotAvatarEditorActions, BotCreation, BotIdentity, BotOrganizationPatch, BotStatus, BotSummary, BotWorkspaceProps } from './types.ts'
