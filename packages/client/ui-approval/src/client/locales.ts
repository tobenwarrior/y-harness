/** `approval` namespace dictionaries. */

/** English dictionary for this namespace. */

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
