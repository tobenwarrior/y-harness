/** Turn-local presentation data for an app connection request. */

import type {
  ConversationNodeDefinition, TurnLocation,
} from '@yharness/client-ui-conversation/client'
import type { SessionEventLike } from '@yharness/api-session-controller/client'
import type { JsonValue } from '@yharness/util-values'

/** Tool whose successful result asks the owner to connect an app. */
export const REQUEST_APP_CONNECTION_TOOL = 'request_app_connection'

/** Turn-data key used by the Bot Chat tail card. */
export const BOT_APP_CONNECTION_TURN_KEY = 'bot-app-connection'

/** One successful app-connection request retained against its owning Turn. */
export interface BotAppConnectionRequest {
  readonly appId: 'github'
  readonly status: 'sign-in-required'
  readonly callId: string
  readonly seq: number
}

/** Successful app-connection requests found in one Turn. */
export interface BotAppConnectionTurnData {
  readonly requests: readonly BotAppConnectionRequest[]
}

declare module '@yharness/client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful app-connection requests retained for the Bot Chat tail. */
    [BOT_APP_CONNECTION_TURN_KEY]: BotAppConnectionTurnData
  }
}

interface AppConnectionTurnState {
  readonly turn: number
  readonly calls: ReadonlySet<string>
  readonly requests: readonly BotAppConnectionRequest[]
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
}

function appConnectionRequest(
  event: Extract<SessionEventLike, { readonly type: 'tool/result' }>,
  callId: string,
): BotAppConnectionRequest | undefined {
  if (event.data.message.isError === true) return undefined
  const meta = event.data.meta
  if (!isJsonObject(meta) || meta.appId !== 'github' || meta.status !== 'sign-in-required') return undefined
  return { appId: meta.appId, status: meta.status, callId, seq: event.seq }
}

/**
 * Select app-connection requests that landed before a Turn tail's sequence.
 * @param data - Turn-local requests, when the definition published any.
 * @param seq - Inclusive event sequence at which the tail closes.
 * @returns requests visible to the closing Turn tail.
 */
export function appConnectionRequestsForClosing(
  data: Readonly<BotAppConnectionTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly BotAppConnectionRequest[] {
  return data?.requests.filter(request => request.seq <= seq) ?? []
}

/**
 * Select the requests owned by one completed Turn.
 * @param owner - Turn and event sequence supplied by the Chat slot.
 * @returns requests that settled before the Turn closed.
 */
export function selectBotAppConnectionRequests(
  owner: { readonly turn: TurnLocation; readonly seq: number },
): readonly BotAppConnectionRequest[] {
  return appConnectionRequestsForClosing(owner.turn.data.get(BOT_APP_CONNECTION_TURN_KEY), owner.turn.end?.seq ?? owner.seq)
}

/**
 * Accumulate successful `request_app_connection` results without publishing a
 * technical Chat node. The Bot workspace renders the retained value from the
 * Turn-tail slot, while Code Chat continues to use its normal tool view.
 */
export const botAppConnectionTurnDefinition: ConversationNodeDefinition<AppConnectionTurnState> = {
  kind: BOT_APP_CONNECTION_TURN_KEY,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' || (event.type === 'tool/result' && event.surfaceOp === 'append')) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('bot-app-connection start requires turn/start')
    return { turn: match.event.data.turn, calls: new Set(), requests: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      if (match.event.data.name !== REQUEST_APP_CONNECTION_TOOL) return context.state
      const calls = new Set(context.state.calls)
      calls.add(String(match.event.data.callId))
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result' || match.event.surfaceOp !== 'append') return context.state
    const callId = String(match.event.data.message.source.callId)
    if (!context.state.calls.has(callId)) return context.state
    const request = appConnectionRequest(match.event, callId)
    return request === undefined ? context.state : { ...context.state, requests: [...context.state.requests, request] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined || context.state.requests.length === 0) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === BOT_APP_CONNECTION_TURN_KEY
      && previous.value.requests === context.state.requests) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: BOT_APP_CONNECTION_TURN_KEY,
      value: { requests: context.state.requests },
    }
  },
}
