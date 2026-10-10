/** Read-only local Claude session discovery through the installed official Agent SDK. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionEvent, CodingSessionProvider, CodingSessionSnapshot, CodingSessionReadRequest } from './types.ts'
import { codingSessionDigest } from './digest.ts'

/** Only public installed-SDK history reads, never query/resume or transcript writes. */
export type ClaudeSessionSdk = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'listSessions' | 'getSessionInfo' | 'getSessionMessages'>
const messageSchema = z.object({ type: z.enum(['user', 'assistant', 'system']), uuid: z.string().min(1), session_id: z.string().min(1), message: z.unknown(), parent_tool_use_id: z.string().nullable(), parent_agent_id: z.string().nullable() })
const bodySchema = z.object({
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())]),
}).loose()
const offsetOf = (cursor?: string): number => {
  if (cursor === undefined) return 0
  if (!/^offset:[0-9]+$/.test(cursor)) throw new Error('Claude coding session cursor is invalid.')
  const offset = Number(cursor.slice(7))
  if (!Number.isSafeInteger(offset)) throw new Error('Claude coding session cursor is invalid.')
  return offset
}
/**
 * Scope public local history reads to a configured project and actual SDK profile.
 * The SDK has no cancellable file-read or exclusive CLI-writer API. Read passes
 * check cancellation before publication; the Host independently fences late reads.
 * @param profileIdentity - stable configured SDK profile and directory scope.
 * @param label - user-visible source label without credentials.
 * @param directory - absolute authorized project directory; no all-project scan.
 * @param resolveSdk - lazy official SDK resolver; fixtures replace only this external dependency.
 * @param scope - explicit child profile and connection readiness, when reads use an isolated SDK worker.
 * @returns a read-only provider; no SDK query, fork, resume, or native mutation is exposed.
 */
export function createClaudeCodingSessionProvider(profileIdentity: string, label: string, directory: string, resolveSdk: (request: CodingSessionReadRequest) => Promise<ClaudeSessionSdk> = () => import('@anthropic-ai/claude-agent-sdk'), scope?: { profileRoot: string; connected: () => boolean }): CodingSessionProvider {
  if (!isAbsolute(directory)) throw new Error('Claude coding sessions require an absolute configured project directory.')
  const profileId = brandString<CodingSessionProvider['profileId']>(profileIdentity)
  if (scope !== undefined && !isAbsolute(scope.profileRoot)) throw new Error('Claude coding sessions require an absolute configured profile directory.')
  const root = (): string => scope === undefined ? resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) : resolve(scope.profileRoot)
  const capturedRoot = root(); const connected = (): boolean => root() === capturedRoot && (scope?.connected() ?? true)
  const check = (request: CodingSessionReadRequest): void => {
    request.signal.throwIfAborted()
    if (!connected()) throw new Error('The native Claude profile directory changed. Reload this connection before reading sessions.')
  }
  return { provider: 'claude', profileId, label, connected,
    discover: async (request, cursor) => {
      check(request); const offset = offsetOf(cursor); const sdk = await resolveSdk(request); check(request)
      const values = await sdk.listSessions({
        dir: directory, limit: request.limit, offset, includeWorktrees: false, includeProgrammatic: true,
      })
      check(request)
      return { items: values.map(value => ({
        source: {
          provider: 'claude', profileId, nativeSessionId: brandString<CodingSessionSnapshot['source']['nativeSessionId']>(value.sessionId),
        }, title: value.customTitle ?? value.summary,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }), writerState: 'unknown',
      })),
      ...(values.length === request.limit ? { nextCursor: `offset:${offset + values.length}` } : {}) }
    },
    read: async (nativeSessionId, request) => {
      check(request); const sdk = await resolveSdk(request); check(request)
      const info = async () => {
        const metadata = await sdk.getSessionInfo(nativeSessionId, { dir: directory }); check(request)
        if (metadata === undefined) throw new Error('Original Claude coding session was not found in the configured source.')
        if (metadata.sessionId !== nativeSessionId) throw new Error('Claude did not return the original native session.')
        if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > request.maxBytes) throw new Error('Claude coding session metadata exceeded the configured limit.')
        return metadata
      }
      const history = async (): Promise<CodingSessionEvent[]> => {
        const events: CodingSessionEvent[] = []
        let bytes = 0
        for (let offset = 0;;) {
          check(request)
          const page = z.array(messageSchema).parse(await sdk.getSessionMessages(nativeSessionId, {
            dir: directory, limit: request.limit, offset, includeSystemMessages: true,
          }))
          check(request)
          bytes += Buffer.byteLength(JSON.stringify(page), 'utf8')
          if (page.length > request.limit || bytes > request.maxBytes) throw new Error('Claude coding session history exceeded the configured limit.')
          for (const value of page) {
            if (value.session_id !== nativeSessionId) throw new Error('Claude did not return the original native session history.')
            const parsed = bodySchema.safeParse(value.message)
            const text = parsed.success ? typeof parsed.data.content === 'string' ? parsed.data.content : parsed.data.content.map(part => part.type === 'text' ? part.text ?? '' : `[Native ${part.type} block]`).join('\n') : `[Native ${value.type} message]`
            events.push({ id: brandString<CodingSessionEvent['id']>(value.uuid), role: value.type, text, digest: codingSessionDigest(value) })
          }
          if (events.length > request.maxEvents || Buffer.byteLength(JSON.stringify(events), 'utf8') > request.maxBytes) throw new Error('Claude coding session history exceeded the configured limit.')
          if (page.length < request.limit) return events
          offset += page.length
        }
      }
      const read = async (): Promise<CodingSessionSnapshot> => {
        const before = await info(); const events = await history(); const metadata = await info()
        if (codingSessionDigest(before) !== codingSessionDigest(metadata)) throw new Error('Claude coding session changed while reading. Retry after its native writer is idle.')
        return { source: { provider: 'claude', profileId, nativeSessionId }, title: metadata.customTitle ?? metadata.summary,
          ...(metadata.cwd === undefined ? {} : { cwd: metadata.cwd }), writerState: 'unknown', events, cursor: codingSessionDigest({ metadata, events: events.map(event => [event.id, event.digest]) }) }
      }
      const first = await read(); const second = await read()
      if (codingSessionDigest(first) !== codingSessionDigest(second)) throw new Error('Claude coding session changed while reading. Retry after its native writer is idle.')
      return second
    },
  }
}
