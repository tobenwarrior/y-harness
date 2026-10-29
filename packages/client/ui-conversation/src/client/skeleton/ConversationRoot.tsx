// Resident conversation skeleton. Hero chrome, composer positioning, the
// chain, AND the composer bar (session-maybe slot) stay mounted across
// no-session/session transitions — the bar renders inert via owner props.

import type { ConversationSlotProps } from '../contract/slots.ts'

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

export function ConversationRoot({ renderFactorySlot }: ConversationRootProps) {
  return renderFactorySlot('conversation.panel', { variant: 'main' })
}
