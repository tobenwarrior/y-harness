/** Add an authored Bot-group attachment message to the standard Bot snapshot setup. */

import type { Context } from '@yharness/cordis'
import { AttachmentId } from '@yharness/attachment'
import { MessageId } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import { BotGroupId, BotGroupMessageId } from '@yharness/bots'
import type {} from '@yharness/session-persistence'
import { seedBotPrerequisites, inject as botPrerequisiteInject } from './bot-prereqs.ts'

export const name = 'snapshot-bot-attachment-prereqs'
export const inject = [...botPrerequisiteInject, 'sessionPersistence']

/** Seed one queued group message whose existing Session content includes image and file blocks. */
export async function apply(ctx: Context): Promise<void> {
  const handles = await seedBotPrerequisites(ctx)
  const targetSession = ctx.sessions.get(SessionId('bot-session-target'))
  if (targetSession === undefined) throw new Error('snapshot Bot attachment target Session is not live')
  const deadline = Date.now() + 5_000
  while (!targetSession.snapshotEvents().some(event => event.type === 'session/title')) {
    if (Date.now() >= deadline) throw new Error('snapshot Bot title did not settle')
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  }
  await Promise.all(handles.map(handle => handle.dispose()))
  const event = targetSession.append('agent/inbox/spliced', {
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
  const writer = await ctx.sessionPersistence.open(SessionId('bot-session-target'), 'write')
  try {
    await writer.append([event])
    await writer.flush()
  } finally {
    await writer.close()
  }
}
