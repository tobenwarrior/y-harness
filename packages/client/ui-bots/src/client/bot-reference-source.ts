/** Input-trigger source for authorized Bot references in the composer. */
import type { InputTriggerSource } from '@yharness/client-ui-input-trigger/client'
import type { HostObservable } from '@yharness/client-ui-slots'
import { formatBotMention, parseBotMention } from '@yharness/client-ui-primitives'
import type { BotAvatar, BotView } from '@yharness/bots/client'
import type { BotWorkspaceState } from './controller.ts'
import { createBotCandidateIcon, createBotReferenceIcon } from './bot-reference-icon.tsx'

/** Dependencies for one Bot reference source. */
export interface BotReferenceSourceOptions {
  readonly workspace: HostObservable<BotWorkspaceState>
  readonly loadAvatar: (botId: string, avatar: BotAvatar) => Promise<string>
  /** Resolve the localized group label at each candidate request. */
  readonly section: () => string
  /** Resolve the localized candidate description at each candidate request. */
  readonly botLabel: () => string
  /** Initial roster load used to avoid presenting a stale empty catalog. */
  readonly ready?: Promise<void>
}

/**
 * Create the `@` source that resolves authorized Bots by stable identity.
 * @param options - roster, avatar loader, and localized row labels.
 * @returns a source owned by the Bot client plugin.
 */
export function createBotReferenceSource(options: BotReferenceSourceOptions): InputTriggerSource {
  const { workspace, loadAvatar, section, botLabel, ready = Promise.resolve() } = options
  return {
    trigger: '@',
    name: 'bot',
    order: -1,
    showGroupTitle: false,
    referenceIcon: createBotReferenceIcon(workspace, loadAvatar),
    async candidates({ sessionId }, { query, quoted, drilled, signal }) {
      if (quoted || drilled) return []
      await ready
      if (signal.aborted) return []
      const needle = query.trim().toLocaleLowerCase()
      const currentSection = section()
      const currentBotLabel = botLabel()
      return workspace.getSnapshot().bots
        .filter(bot => bot.state === 'active' && bot.hidden !== true && bot.sessionId !== sessionId)
        .filter(bot => needle === '' || [bot.name, bot.description, String(bot.id)]
          .some(value => value?.toLocaleLowerCase().includes(needle) === true))
        .map(bot => botCandidate(bot, currentSection, currentBotLabel, loadAvatar))
    },
    onPick({ candidate, action, session }) {
      if (action === 'drill') return undefined
      const reference = candidate.value
      if (reference === undefined) return undefined
      const mention = parseBotMention(reference)
      if (mention === undefined) return undefined
      const bot = workspace.getSnapshot().bots.find(item => String(item.id) === mention.botId)
      if (bot === undefined || bot.state !== 'active' || bot.hidden === true || bot.sessionId === session.sessionId) return undefined
      return {
        insert: {
          source: 'bot',
          ref: reference,
          label: mention.label,
          appearance: 'bot',
          clipboardText: reference,
        },
      }
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
}

function botCandidate(
  bot: BotView,
  section: string,
  botLabel: string,
  loadAvatar: (botId: string, avatar: BotAvatar) => Promise<string>,
) {
  const label = bot.name
  const mention = formatBotMention(String(bot.id), label)
  return {
    name: label,
    description: botLabel,
    icon: createBotCandidateIcon(bot, loadAvatar),
    section,
    value: mention,
  }
}
