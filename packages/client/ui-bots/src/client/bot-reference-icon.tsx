/** Avatar presenters shared by the Bot completion source and inline references. */
import type { ComponentType } from 'react'
import type { BotAvatar as SharedBotAvatar, BotView } from '@yharness/bots/client'
import type { HostObservable } from '@yharness/client-ui-slots'
import type { IconProps, InlineReferenceIconProps } from '@yharness/client-ui-primitives'
import { bindInlineReferenceIcon, parseBotMention, ReferenceIconRegular } from '@yharness/client-ui-primitives'
import type { BotWorkspaceState } from './controller.ts'
import { BotAvatar } from './BotAvatar.tsx'

/** Resolve the current Bot row for one canonical bot reference. */
function findBot(workspace: BotWorkspaceState, reference: string): BotView | undefined {
  const mention = parseBotMention(reference)
  return mention === undefined ? undefined : workspace.bots.find(bot => bot.id === mention.botId)
}

/**
 * Create the inline Bot reference presenter for one Bot workspace.
 *
 * @param workspace - observable Bot roster.
 * @param loadAvatar - Host-backed generated-avatar loader.
 * @returns a stable inline reference presenter.
 */
export function createBotReferenceIcon(
  workspace: HostObservable<BotWorkspaceState>,
  loadAvatar: (botId: string, avatar: SharedBotAvatar) => Promise<string>,
): ComponentType<InlineReferenceIconProps> {
  return bindInlineReferenceIcon(workspace, findBot, function BotReferenceIcon({ value: bot }) {
    if (bot === undefined) return <ReferenceIconRegular kind="bot" size={16} />
    return (
      <BotAvatar
        name={bot.name}
        identity={bot.identity}
        accent={bot.accent}
        avatar={bot.avatar}
        botId={bot.id}
        loadAvatar={bot.avatar === undefined ? undefined : loadAvatar}
        size="tiny"
      />
    )
  })
}

/**
 * Create the compact candidate-menu icon for one Bot row.
 * @param bot - roster row represented by the candidate.
 * @param loadAvatar - Host-backed generated-avatar loader.
 * @returns an icon component accepted by the input-trigger menu.
 */
export function createBotCandidateIcon(
  bot: BotView,
  loadAvatar: (botId: string, avatar: SharedBotAvatar) => Promise<string>,
): ComponentType<IconProps> {
  return function BotCandidateIcon(_props: IconProps) {
    return (
      <BotAvatar
        name={bot.name}
        identity={bot.identity}
        accent={bot.accent}
        avatar={bot.avatar}
        botId={String(bot.id)}
        loadAvatar={bot.avatar === undefined ? undefined : loadAvatar}
        size="tiny"
      />
    )
  }
}
