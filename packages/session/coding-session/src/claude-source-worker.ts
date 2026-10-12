#!/usr/bin/env node
/** Private Claude read worker; a bounded settings observation supports opted-in unmanaged handoff. */
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { ClaudeSessionSdk } from './claude.ts'
import type { ClaudeSequentialSdk } from '@deepseek-ai/dsh-subagent-claude-code'
import type { ResolvedSettings, ResolveSettingsOptions } from '@anthropic-ai/claude-agent-sdk'

const absolute = z.string().min(1).refine(isAbsolute)
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** Validated explicitly selected SDK paths and original profile scope. */
export const claudeSourceFields = {
  profileRoot: absolute, directory: absolute, shellHome: absolute,
  sdkModulePath: absolute, sdkManifestPath: absolute,
  sdkModuleSha256: z.string().regex(/^[a-f0-9]{64}$/), sdkVersion: z.literal('0.3.263'),
}
const common = { protocol: z.literal(1), ...claudeSourceFields, maxBytes: count, maxEvents: count }
/** Public project-scoped list/history and a sanitized sequential policy observation enter the worker. */
export const claudeSourceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ ...common, operation: z.literal('listSessions'), limit: count, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...common, operation: z.literal('getSessionInfo'), sessionId: z.string().min(1) }).strict(),
  z.object({ ...common, operation: z.literal('getSessionMessages'), sessionId: z.string().min(1), limit: count, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ ...common, operation: z.literal('inspectSequentialPolicy') }).strict(),
])
/** Complete read-only wire request; no SDK query, resume, CLI or session-store operation exists. */
export type ClaudeSourceRequest = z.infer<typeof claudeSourceRequestSchema>
/** Full SDK metadata, with unknown future fields retained for byte accounting and stability checks. */
export const claudeSourceInfoSchema = z.object({
  sessionId: z.string().min(1), summary: z.string(), lastModified: z.number(),
  fileSize: z.number().nonnegative().optional(), customTitle: z.string().optional(),
  firstPrompt: z.string().optional(), gitBranch: z.string().optional(), cwd: z.string().optional(),
  tag: z.string().optional(), createdAt: z.number().optional(),
}).loose()
/** Raw complete SDK history messages survive validation before reader projection. */
export const claudeSourceMessagesSchema = z.array(z.object({
  type: z.enum(['user', 'assistant', 'system']), uuid: z.string().min(1), session_id: z.string().min(1),
  message: z.unknown(), parent_tool_use_id: z.string().nullable(), parent_agent_id: z.string().nullable(),
}).loose())
const errors = z.enum(['request-limit', 'request-invalid', 'profile-mismatch', 'sdk-verification', 'sdk-read', 'sdk-policy', 'response-limit'])
/** Sanitized worker replies carry no raw stderr, paths, stack traces or SDK exceptions. */
export const claudeSourceReplySchema = z.discriminatedUnion('ok', [
  z.object({ protocol: z.literal(1), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ protocol: z.literal(1), ok: z.literal(false), error: errors }).strict(),
])
type WorkerError = z.infer<typeof errors>
const failure = (error: WorkerError, maxBytes: number): string => {
  const reply = JSON.stringify({ protocol: 1, ok: false, error }) + '\n'
  return Number.isSafeInteger(maxBytes) && Buffer.byteLength(reply, 'utf8') <= maxBytes ? reply : ''
}
async function moduleDigest(path: string): Promise<string> {
  if (await realpath(path) !== resolve(path)) throw new Error('SDK module path must be canonical')
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('SDK module must be a file')
    const hash = createHash('sha256'); const buffer = Buffer.alloc(65536); let bytes = 0
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (read.bytesRead === 0) return hash.digest('hex')
      bytes += read.bytesRead
      if (bytes > 64 * 1024 * 1024) throw new Error('SDK module exceeded the certification limit')
      hash.update(buffer.subarray(0, read.bytesRead))
    }
  } finally { await file.close() }
}
async function manifestText(path: string): Promise<string> {
  if (await realpath(path) !== resolve(path)) throw new Error('SDK manifest path must be canonical')
  const file = await open(path, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('SDK manifest must be a file')
    const bytes = Buffer.alloc(65537); let length = 0
    for (;;) {
      const read = await file.read(bytes, length, bytes.length - length, null)
      length += read.bytesRead
      if (length > 65536) throw new Error('SDK manifest exceeded the certification limit')
      if (read.bytesRead === 0) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    }
  } finally { await file.close() }
}
type InstalledSdkSelection = Pick<ClaudeSourceRequest, 'sdkModulePath' | 'sdkManifestPath' | 'sdkModuleSha256'>
async function verifiedInstalledModule(request: InstalledSdkSelection): Promise<unknown> {
  const manifest = z.object({ name: z.literal('@anthropic-ai/claude-agent-sdk'), version: z.literal('0.3.263'), main: z.string().min(1), exports: z.object({ '.': z.object({ default: z.string().min(1) }).loose() }).loose().optional() }).loose().parse(JSON.parse(await manifestText(request.sdkManifestPath)))
  const base = dirname(request.sdkManifestPath)
  if (resolve(base, manifest.main) !== resolve(request.sdkModulePath) || (manifest.exports !== undefined && resolve(base, manifest.exports['.'].default) !== resolve(request.sdkModulePath))) throw new Error('SDK entry is invalid')
  if (await moduleDigest(request.sdkModulePath) !== request.sdkModuleSha256) throw new Error('SDK digest is invalid')
  return import(pathToFileURL(request.sdkModulePath).href)
}
async function verifiedModule(request: ClaudeSourceRequest): Promise<ClaudeSessionSdk> {
  const sdk = await verifiedInstalledModule(request)
  return z.object({
    listSessions: z.custom<ClaudeSessionSdk['listSessions']>(value => typeof value === 'function'),
    getSessionInfo: z.custom<ClaudeSessionSdk['getSessionInfo']>(value => typeof value === 'function'),
    getSessionMessages: z.custom<ClaudeSessionSdk['getSessionMessages']>(value => typeof value === 'function'),
  }).parse(sdk)
}
/**
 * Resolve only the pinned installed query API after explicit sequential model control was chosen.
 * @param request - selected SDK entry, manifest and exact certified module digest.
 * @returns the official installed query function; resolution starts no native process or turn.
 */
export async function verifiedClaudeSequentialSdk(request: InstalledSdkSelection): Promise<ClaudeSequentialSdk> {
  return z.object({ query: z.custom<ClaudeSequentialSdk['query']>(value => typeof value === 'function') }).parse(await verifiedInstalledModule(request))
}
/** Sanitized observed-empty policy receipt; deployment certification remains a separate required input. */
export const claudeSequentialPolicyReceiptSchema = z.object({
  noManagedSettingsObserved: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
/**
 * Refuse every reported managed/helper/remote/parent or unknown settings cascade.
 * @param value - public SDK resolveSettings result with filesystem sources disabled.
 * @returns only an observed-empty fingerprint; it cannot certify future remote policy or helper absence.
 */
export function claudeSequentialPolicyReceipt(value: unknown): z.infer<typeof claudeSequentialPolicyReceiptSchema> {
  const result = z.object({ effective: z.record(z.string(), z.unknown()), provenance: z.record(z.string(), z.unknown()),
    sources: z.array(z.object({ source: z.enum(['user', 'project', 'local', 'managed', 'flag']), settings: z.record(z.string(), z.unknown()),
      path: z.string().optional(), policyOrigin: z.enum(['helper', 'remote', 'plist', 'hklm', 'file', 'parent', 'hkcu']).optional() }).strict()) }).strict().parse(value)
  if (result.sources.length !== 0 || Object.keys(result.effective).length !== 0 || Object.keys(result.provenance).length !== 0) throw new Error('Claude sequential startup policy is managed or unknown.')
  return { noManagedSettingsObserved: true, fingerprint: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
}
/**
 * Execute one bounded metadata request in the already selected child environment.
 * @param payload - complete UTF8 JSON request, including its framing newline.
 * @param maxBytes - launcher-selected complete request and reply byte budget.
 * @returns one bounded JSON reply with stable, sanitized error codes.
 */
export async function executeClaudeSourceRequest(payload: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || Buffer.byteLength(payload, 'utf8') > maxBytes) return failure('request-limit', maxBytes)
  let request: ClaudeSourceRequest
  try { request = claudeSourceRequestSchema.parse(JSON.parse(payload)) } catch (_error) { return failure('request-invalid', maxBytes) }
  if (request.maxBytes !== maxBytes) return failure('request-invalid', maxBytes)
  if (process.env.CLAUDE_CONFIG_DIR !== request.profileRoot || process.env.HOME !== request.shellHome) return failure('profile-mismatch', maxBytes)
  if (request.operation === 'inspectSequentialPolicy') {
    try {
      const sdk = z.object({ resolveSettings: z.custom<(options?: ResolveSettingsOptions) => Promise<ResolvedSettings>>(value => typeof value === 'function') }).parse(await verifiedInstalledModule(request))
      const value = claudeSequentialPolicyReceipt(await sdk.resolveSettings({ cwd: request.directory, settingSources: [] }))
      const reply = JSON.stringify({ protocol: 1, ok: true, value }) + '\n'
      return Buffer.byteLength(reply, 'utf8') <= maxBytes ? reply : failure('response-limit', maxBytes)
    } catch (_error: unknown) { return failure('sdk-policy', maxBytes) }
  }
  let sdk: ClaudeSessionSdk
  try { sdk = await verifiedModule(request) } catch (_error) { return failure('sdk-verification', maxBytes) }
  let value: unknown
  try {
    // The operation was parsed against the closed allowlist before module resolution.
    switch (request.operation) {
      case 'listSessions': value = await sdk.listSessions({ dir: request.directory, limit: request.limit, offset: request.offset, includeWorktrees: false, includeProgrammatic: true }); break
      case 'getSessionInfo': value = await sdk.getSessionInfo(request.sessionId, { dir: request.directory }) ?? null; break
      case 'getSessionMessages': value = await sdk.getSessionMessages(request.sessionId, { dir: request.directory, limit: request.limit, offset: request.offset, includeSystemMessages: true }); break
    }
    const reply = JSON.stringify({ protocol: 1, ok: true, value }) + '\n'
    if (Buffer.byteLength(reply, 'utf8') > maxBytes) return failure('response-limit', maxBytes)
    switch (request.operation) {
      case 'listSessions': if (z.array(claudeSourceInfoSchema).parse(value).length > request.limit) return failure('response-limit', maxBytes); break
      case 'getSessionInfo': if (value !== null) claudeSourceInfoSchema.parse(value); break
      case 'getSessionMessages': if (claudeSourceMessagesSchema.parse(value).length > Math.min(request.limit, request.maxEvents)) return failure('response-limit', maxBytes); break
    }
    return reply
  } catch (_error) { return failure('sdk-read', maxBytes) }
}
async function main(): Promise<void> {
  const maxBytes = Number(process.argv[2]); const chunks: Buffer[] = []; let bytes = 0
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) { process.stdout.write(failure('request-limit', maxBytes)); return }
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    bytes += chunk.length
    if (bytes > maxBytes) { process.stdout.write(failure('request-limit', maxBytes)); process.stdin.destroy(); return }
    chunks.push(chunk)
  }
  let payload: string
  try { payload = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch (_error) { process.stdout.write(failure('request-invalid', maxBytes)); return }
  process.stdout.write(await executeClaudeSourceRequest(payload, maxBytes))
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((_error: unknown) => { process.stdout.write(failure('sdk-read', Number(process.argv[2]))); process.exitCode = 1 })
}
