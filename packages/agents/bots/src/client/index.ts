/** Browser-safe Bot vocabulary. @module @yharness/bots/client */

export type * from '../types.ts'
export type * from '../template-types.ts'
export type {
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupDeliveryStatusView,
  BotGroupDeliveryView,
  BotGroupDeliveryRecoveryRequest,
  BotGroupDeliveryRecoveryValue,
  BotGroupId,
  BotGroupInspectRequest,
  BotGroupInspectValue,
  BotGroupListRequest,
  BotGroupListValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
  BotGroupMemberView,
  BotGroupMessageId,
  BotGroupMessageSenderView,
  BotGroupMessageView,
  BotGroupSendRequest,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupView,
} from '../group-chat.ts'
export type { BotGroupImageAdmissionRequest } from '../group-chat.ts'
export type { BotInputAttachmentView } from '../attachment-grants.ts'
/** Backward-compatible Client alias for the remote memory-removal request. */
export type { BotMemoryForgetRemoteRequest as BotMemoryForgetRequest } from '../types.ts'
export { BOT_ACCENTS, BOT_IDENTITIES, BotId, BotShareMemoryId } from '../types.ts'
export { BotPrincipalId } from '../sharing.ts'
export type { BotShareRole } from '../sharing.ts'

/** The Host Bot service has no independent Client lifecycle; API remotes own its calls. */
export const inject: readonly string[] = []

/** Keep the package's Client face inert while exposing browser-safe Bot vocabulary. */
export function apply(): void {}
