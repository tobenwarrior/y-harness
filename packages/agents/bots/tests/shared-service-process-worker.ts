import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { SharedAccessAuthority, SharedInviteCode } from '@yharness/client-connection'
import { SessionId } from '@yharness/session'
import Storage from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import { JsonStorageBackend } from '@yharness/storage-json'
import { Config as SqliteConfig, SqliteStorageBackend } from '@yharness/storage-sqlite'
import { LocalCredentialProvider } from '../../../credentials/credentials-local/src/index.ts'
import { BotId, type BotView } from '../src/types.ts'
import { SharedBotService, type SharedBotHost } from '../src/shared-service.ts'

interface WorkerArguments {
  readonly backendName: 'json' | 'sqlite'
  readonly storageRoot: string
  readonly credentialsPath: string
  readonly operation: string
  readonly input: Record<string, string>
}

function readWorkerArguments(): WorkerArguments {
  const backendName = process.argv[2]
  const storageRoot = process.argv[3]
  const credentialsPath = process.argv[4]
  const operation = process.argv[5]
  const inputText = process.argv[6]
  if ((backendName !== 'json' && backendName !== 'sqlite') || storageRoot === undefined
    || credentialsPath === undefined || operation === undefined) {
    throw new Error('invalid shared-service process worker arguments')
  }
  const parsedInput: unknown = inputText === undefined ? {} : JSON.parse(inputText)
  if (parsedInput === null || typeof parsedInput !== 'object' || Array.isArray(parsedInput)) {
    throw new Error('invalid shared-service process worker input')
  }
  const input: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsedInput)) {
    if (typeof value !== 'string') throw new Error(`invalid shared-service process worker input field: ${key}`)
    input[key] = value
  }
  return { backendName, storageRoot, credentialsPath, operation, input }
}

const { backendName, storageRoot, credentialsPath, operation, input } = readWorkerArguments()

function bot(): BotView {
  return {
    id: BotId('bot-chief'),
    sessionId: SessionId('bot-session-chief'),
    name: 'Chief of staff',
    description: 'Cross-process test Bot',
    identity: 'agent',
    accent: 'violet',
    cwd: '/tmp',
    state: 'active',
    availability: 'idle',
    pinned: false,
    hidden: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function sharedHost(): SharedBotHost {
  const current = bot()
  return {
    listBots: async () => [current],
    withBotRoster: async (expected, _signal, callback) => {
      if (!expected.some(candidate => candidate.id === current.id)) return { valid: false }
      return { valid: true, value: await callback() }
    },
    findBot: async botId => botId === current.id ? current : undefined,
    withBot: async (botId, signal, callback) => {
      signal?.throwIfAborted()
      if (botId !== current.id) return { found: false }
      return { found: true, value: await callback(current) }
    },
    updateProfile: async () => current,
    createPrivateSession: async (_bot, sessionId) => ({
      id: sessionId,
      cancel: () => {},
      whenIdle: async () => {},
    } satisfies Pick<Agent, 'id' | 'cancel' | 'whenIdle'>),
    resolvePrivateAgent: async sessionId => ({
      agent: {
        id: sessionId,
        followup: () => {},
        cancel: () => {},
        whenIdle: async () => {},
      },
    }),
    inspectPrivateSession: async () => ({ events: [] }),
    validatePrivateSession: async () => {},
    flushPrivateSession: async () => {},
  }
}

function request(cookie: string | undefined): { headers: Record<string, string> } {
  return {
    headers: {
      host: '127.0.0.1:3080',
      ...(cookie === undefined ? {} : { cookie: cookie.split(';', 1)[0]! }),
    },
  }
}

async function run(): Promise<Record<string, unknown>> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = backendName === 'json'
    ? new JsonStorageBackend(storageRoot)
    : new SqliteStorageBackend(new SqliteConfig({ path: storageRoot }))
  ctx.effect(() => ctx.storage.backend.register(backendName, backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: backendName })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const credentialsFiber = ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
  await credentialsFiber
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('cross-process worker credentials were not mounted')
  const authority = await SharedAccessAuthority.create(ctx, credentials, {
    sessionMaxAgeMs: 60_000,
    inviteMaxAgeMs: 60_000,
    now: () => 1_000,
  })
  const service = await SharedBotService.create(ctx, facility, authority, sharedHost(), {
    now: () => 1_000,
    membershipPollIntervalMs: 10,
  })
  try {
    if (operation === 'owner') {
      const invite = await service.createInvite(BotId('bot-chief'), 'owner')
      const enrollment = await service.enroll(invite.code, request(undefined))
      if (!('botId' in enrollment)) throw new Error('owner enrollment returned a group result')
      return { principalId: String(enrollment.principalId), setCookie: enrollment.setCookie }
    }
    if (operation === 'invite') {
      const invite = await service.createInvite(BotId('bot-chief'), 'collaborator')
      return { code: String(invite.code) }
    }
    if (operation === 'orphan-invite') {
      const domain = facility.get('agent_bot_shares')
      if (domain === undefined) throw new Error('shared Bot domain is not open')
      const invites = domain.table('invites')
      const originalPut = invites.put.bind(invites)
      let failed = false
      invites.put = async (key, record) => {
        await originalPut(key, record)
        if (!failed) {
          failed = true
          throw new Error('injected cross-process invite publication failure')
        }
      }
      invites.delete = async () => { throw new Error('injected cross-process invite cleanup failure') }
      await service.createInvite(BotId('bot-chief'), 'collaborator').catch(() => undefined)
      return { orphaned: true }
    }
    if (operation === 'redeem') {
      if (input.code === undefined) throw new Error('redeem operation requires a code')
      const enrollment = await service.enroll(SharedInviteCode(input.code), request(input.cookie))
      if (!('botId' in enrollment)) throw new Error('redeem returned a group result')
      return { principalId: String(enrollment.principalId), setCookie: enrollment.setCookie }
    }
    if (operation === 'members') {
      const members = await service.listMembers(BotId('bot-chief'))
      return { members: members.map(member => ({ ...member, principalId: String(member.principalId) })) }
    }
    if (operation === 'counts') {
      const domain = facility.get('agent_bot_shares')
      if (domain === undefined) throw new Error('shared Bot domain is not open')
      return {
        invites: domain.table('invites').size,
        memberships: domain.table('memberships').size,
        privateSessions: domain.table('private_sessions').size,
      }
    }
    throw new Error(`unknown shared-service process operation '${operation}'`)
  } finally {
    await service.dispose()
    await authority.dispose()
    await ctx.fiber.dispose()
  }
}

try {
  console.log(`WORKER_RESULT:${JSON.stringify({ ok: true, value: await run() })}`)
} catch (error: unknown) {
  console.log(`WORKER_RESULT:${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}`)
}
