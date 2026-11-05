/** Add an authored Bot-group attachment message to the standard Bot snapshot setup. */

import type { Context } from '@yharness/cordis'
import { AttachmentId } from '@yharness/attachment'
import { MessageId } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import { BotGroupId, BotGroupMessageId } from '../../../../agents/bots/src/group-chat.ts'
import { apply as applyBotPrerequisites, inject as botPrerequisiteInject } from './bot-prereqs.ts'

export const name = 'snapshot-bot-attachment-prereqs'
export const inject = botPrerequisiteInject

/** Seed one queued group message whose existing Session content includes image and file blocks. */
export async function apply(ctx: Context): Promise<void> {
  await applyBotPrerequisites(ctx)
  const targetSession = ctx.sessions.get(SessionId('bot-session-target'))
  if (targetSession === undefined) throw new Error('snapshot Bot attachment target Session is not live')
  targetSession.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{
      id: MessageId('bot-group-message-attachments'),
      role: 'user',
      source: {
        kind: 'bot-group-message',
        groupId: BotGroupId('bot-group-attachments'),
        messageId: BotGroupMessageId('bot-group-message-attachments'),
      },
      content: [
        { type: 'text', text: 'Review these attachments.' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
            name: 'diagram.png',
          },
        },
        {
          type: 'file',
          attachment: {
            attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
            name: 'notes.txt',
            bytes: 5,
          },
        },
      ],
    }],
  })
}
