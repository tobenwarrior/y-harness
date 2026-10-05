/** Account registrations share the existing protected, atomically written credential store. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { Credential, OAuthCredential } from '@earendil-works/pi-ai'
import type { ChatGPTGrant } from './chatgpt-protocol.ts'

export const CHATGPT_KEY = credentialKey('chatgpt', 'accounts')
export interface ChatGPTAccount { id: string; clientId: string; subject: string; email: string; grant?: ChatGPTGrant }
export interface ChatGPTState { hostId: string; activeId?: string; accounts: ChatGPTAccount[] }
/** Read only this integration's record, never another provider's credentials. */
export async function readChatGPTState(ctx: Context): Promise<ChatGPTState | undefined> {
  const record = await ctx.credentials.readRecord(CHATGPT_KEY)
  return record?.kind === 'grant' ? record.payload as ChatGPTState : undefined
}
/** Serialize account selection, token rotation, and registration writes in one record lock. */
export async function modifyChatGPTState(
  ctx: Context,
  mutate: (state: ChatGPTState) => ChatGPTState | Promise<ChatGPTState>,
): Promise<ChatGPTState> {
  const record = await ctx.credentials.modifyRecord(CHATGPT_KEY, async current => ({
    kind: 'grant', payload: await mutate(current?.kind === 'grant' ? structuredClone(current.payload) as ChatGPTState : { hostId: `urn:uuid:${randomUUID()}`, accounts: [] }),
  }))
  if (record?.kind !== 'grant') throw new Error('ChatGPT account state could not be saved.')
  return record.payload as ChatGPTState
}
export async function readChatGPTCredential(ctx: Context): Promise<OAuthCredential | undefined> {
  const state = await readChatGPTState(ctx)
  return state?.accounts.find(account => account.id === state.activeId)?.grant
}
export async function modifyChatGPTCredential(
  ctx: Context,
  mutate: (current: Credential | undefined) => Promise<Credential | undefined>,
): Promise<Credential | undefined> {
  let result: Credential | undefined
  await modifyChatGPTState(ctx, async (state) => {
    const account = state.accounts.find(entry => entry.id === state.activeId)
    if (account === undefined) return state
    const next = await mutate(account.grant)
    if (next !== undefined) {
      if (next.type !== 'oauth') throw new Error('ChatGPT subscriptions require sign-in, not an API key.')
      account.grant = next as ChatGPTGrant
    }
    result = account.grant
    return state
  })
  return result
}
