/** Durable read-only native history; a mirror is never a runnable Harness Session. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { CodingSessionEventId, CodingSessionMirrorId, CodingSessionNativeId, CodingSessionProfileId } from './types.ts'

const source = z.object({ provider: z.enum(['codex', 'claude']), profileId: z.string().min(1).transform(value => brandString<CodingSessionProfileId>(value)), nativeSessionId: z.string().min(1).transform(value => brandString<CodingSessionNativeId>(value)) })
const event = z.object({ id: z.string().min(1).transform(value => brandString<CodingSessionEventId>(value)), role: z.enum(['user', 'assistant', 'system', 'tool']), text: z.string(), digest: z.string().min(1) })
/** Complete snapshot validation at the native provider response boundary. */
export const codingSessionSnapshotSchema = z.object({ source, title: z.string(), cwd: z.string().optional(), writerState: z.enum(['idle', 'active', 'unknown']), events: z.array(event), cursor: z.string() })
/** Persistent mirror schema rejects damaged records before publishing their contents. */
export const codingSessionMirrorSchema = codingSessionSnapshotSchema.extend({
  id: z.string().min(1).transform(value => brandString<CodingSessionMirrorId>(value)), revision: z.number().int().positive(),
  digest: z.string().min(1), refreshedAt: z.string(), status: z.enum(['ready', 'conflict']), conflict: z.literal('history-diverged').optional(),
  capabilities: z.object({ discover: z.boolean(), read: z.boolean(), refresh: z.boolean(), continue: z.boolean(), reason: z.enum(['native-writer-handoff-unavailable', 'exclusive-native-writer', 'source-disconnected']) }),
})
/** Schema-validated mirror records; native files remain under the original source owner. */
export const codingSessionDomain = defineDomain({ name: 'coding_sessions', version: 1, tables: { mirrors: domainTable<CodingSessionMirrorId, z.infer<typeof codingSessionMirrorSchema>>(codingSessionMirrorSchema) } })
