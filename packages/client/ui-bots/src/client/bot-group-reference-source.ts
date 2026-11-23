/** Input-trigger source for authorized Bot-group references in a direct Bot composer. */
import { IconUsersOutlineRegular, formatBotGroupMention, parseBotGroupMention } from '@yharness/client-ui-primitives'
import type { InputTriggerSource } from '@yharness/client-ui-input-trigger/client'
import type { HostObservable } from '@yharness/client-ui-slots'
import type { BotGroupSummary } from './types.ts'
import type { BotWorkspaceState } from './controller.ts'

/** Dependencies for the direct Bot composer group-reference source. */
export interface BotGroupReferenceSourceOptions {
  readonly workspace: HostObservable<BotWorkspaceState>
  /** Resolve the localized menu section at each candidate request. */
  readonly section: () => string
  /** Resolve the localized candidate descriptor at each candidate request. */
  readonly groupLabel: () => string
  /** Initial group catalog load used to avoid presenting a stale empty catalog. */
  readonly ready?: Promise<void>
}

/**
 * Create the `@` source for groups the selected Bot is currently a member of.
 *
 * The source deliberately uses the selected Bot's Session as its scope. The
 * workspace group catalog is owner-authorized, but a group is only exposed to
 * a direct Bot composer when that Bot is one of the group's current members.
 * Visibility is checked again when a candidate is picked.
 *
 * @param options - workspace, catalog labels, and initial catalog readiness.
 * @returns a source owned by the Bot client plugin.
 */
export function createBotGroupReferenceSource(options: BotGroupReferenceSourceOptions): InputTriggerSource {
  const { workspace, section, groupLabel, ready = Promise.resolve() } = options
  return {
    trigger: '@',
    name: 'bot-group',
    order: -1,
    showGroupTitle: false,
    async candidates({ sessionId }, { query, quoted, drilled, signal }) {
      if (quoted || drilled) return []
      await ready
      if (signal.aborted) return []
      const snapshot = workspace.getSnapshot()
      const currentBot = directBot(snapshot, sessionId)
      if (currentBot === undefined) return []
      const needle = query.trim().toLocaleLowerCase()
      const currentSection = section()
      const currentGroupLabel = groupLabel()
      return visibleGroups(snapshot, currentBot)
        .filter(group => needle === '' || searchableGroupText(group).some(value => value.toLocaleLowerCase().includes(needle)))
        .map(group => groupCandidate(group, currentSection, currentGroupLabel))
    },
    onPick({ candidate, action, session }) {
      if (action === 'drill') return undefined
      const reference = candidate.value
      if (reference === undefined) return undefined
      const mention = parseBotGroupMention(reference)
      if (mention === undefined) return undefined
      const snapshot = workspace.getSnapshot()
      const currentBot = directBot(snapshot, session.sessionId)
      if (currentBot === undefined) return undefined
      const group = visibleGroups(snapshot, currentBot).find(item => item.id === mention.groupId)
      if (group === undefined) return undefined
      return {
        insert: {
          source: 'bot-group',
          ref: reference,
          label: mention.label,
          appearance: 'bot-group',
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

function directBot(snapshot: BotWorkspaceState, sessionId: string): string | undefined {
  const selectedBotId = snapshot.selectedBotId
  if (selectedBotId === null) return undefined
  const bot = snapshot.bots.find(item => String(item.id) === String(selectedBotId) && String(item.sessionId) === sessionId)
  if (bot === undefined || bot.state !== 'active' || bot.hidden) return undefined
  return String(bot.id)
}

function visibleGroups(snapshot: BotWorkspaceState, currentBotId: string): readonly BotGroupSummary[] {
  return snapshot.groups.filter(group => group.bots.some(member => member.id === currentBotId))
}

function searchableGroupText(group: BotGroupSummary): readonly string[] {
  return [
    group.name,
    group.id,
    ...group.bots.flatMap(member => [member.name, member.description ?? '']),
  ]
}

function groupCandidate(group: BotGroupSummary, section: string, groupLabel: string) {
  return {
    name: group.name,
    description: groupLabel,
    icon: IconUsersOutlineRegular,
    section,
    value: formatBotGroupMention(group.id, group.name),
  }
}
