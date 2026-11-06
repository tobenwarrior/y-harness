/** Drive a shared connected-app call through the durable collaborator approval route. */

import type { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { SharedAccessAuthority } from '@yharness/client-connection'
import type { PeerScope } from '@yharness/typert-protocol'
import type { ToolExecution, PreToolDecision } from '@yharness/tools'
import { BotService, SharedBotService } from '@yharness/bots'
import { setApprovalPolicy } from '@yharness/user-approval'
import { apply as applyConnectedApp } from './shared-bot-connected-app-prereqs.ts'

export const name = 'snapshot-shared-bot-connected-app-approval-prereqs'
export const inject = ['agentDefaultModel', 'agents', 'credentials', 'sessions', 'storageDomain', 'tools', 'web']

const SHARED_BOT_ID = 'bot-grok'
const SHARED_SESSION_PREFIX = 'shared-session-'
const FIXTURE_TOOL = 'mcp__fixture__lookup'
const POLL_INTERVAL_MS = 5
const POLL_TIMEOUT_MS = 10_000

interface SharedApprovalDriver {
  readonly authority: SharedAccessAuthority
  readonly peer: PeerScope
  readonly service: SharedBotService
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the private shared service mounted by the production Bot service. */
function productionSharedService(service: BotService): SharedBotService {
  const descriptor = Object.getOwnPropertyDescriptor(service, 'sharedService')
  const value = descriptor?.value as SharedBotService | undefined
  if (!(value instanceof SharedBotService)) throw new Error('snapshot shared Bot service is unavailable')
  return value
}

function productionSharedAuthority(service: SharedBotService): SharedAccessAuthority {
  const descriptor = Object.getOwnPropertyDescriptor(service, 'authority')
  const value = descriptor?.value as SharedAccessAuthority | undefined
  if (!(value instanceof SharedAccessAuthority)) throw new Error('snapshot shared Bot authority is unavailable')
  return value
}

function approvalId(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.approvals)) return undefined
  const pending = value.approvals.find(isRecord)
  return pending !== undefined && typeof pending.id === 'string' ? pending.id : undefined
}

function hasFixtureApprovalGrant(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.grants)) return false
  return value.grants.some(grant => isRecord(grant)
    && grant.appId === 'fixture'
    && grant.toolName === FIXTURE_TOOL)
}

function cookieOf(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? setCookie
}

async function createSharedApprovalDriver(ctx: Context): Promise<SharedApprovalDriver> {
  const bots = ctx.get('bots')
  if (bots === undefined) throw new Error('snapshot Bot service is unavailable')
  const service = productionSharedService(bots)
  const authority = productionSharedAuthority(service)
  const enrollment = await service.enrollOwner({ headers: { host: '127.0.0.1:3080' } })
  const admitted = await authority.admit({
    headers: { host: '127.0.0.1:3080', cookie: cookieOf(enrollment.setCookie) },
  })
  if ('rejection' in admitted) throw new Error(`snapshot shared approval peer rejected: ${String(admitted.rejection)}`)
  return { authority, peer: admitted.peer, service }
}

async function waitForApprovalAndAllow(
  driver: SharedApprovalDriver,
  signal: AbortSignal,
  decision: 'allow' | 'always-allow',
  onDecision: () => void,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (true) {
    signal.throwIfAborted()
    const listed = await driver.service.handle(
      'bots/share/list-approvals',
      { botId: SHARED_BOT_ID },
      signal,
      driver.peer,
    )
    if (!listed.ok) throw new Error(`shared approval list failed: ${listed.error.message}`)
    const id = approvalId(listed.value)
    if (id !== undefined) {
      const decided = await driver.service.handle(
        'bots/share/decide-approval',
        { id, decision },
        signal,
        driver.peer,
      )
      if (!decided.ok) throw new Error(`shared approval decision failed: ${decided.error.message}`)
      if (decision === 'always-allow') {
        const grants = await driver.service.handle(
          'bots/share/list-approval-grants',
          { botId: SHARED_BOT_ID },
          signal,
          driver.peer,
        )
        if (!grants.ok || !hasFixtureApprovalGrant(grants.value)) {
          throw new Error('shared connected-app Always allow did not persist its grant')
        }
      }
      onDecision()
      return
    }
    if (Date.now() >= deadline) throw new Error('shared connected-app approval did not become pending')
    await new Promise<void>((resolve) => { setTimeout(resolve, POLL_INTERVAL_MS) })
  }
}

/** Add an ask decision, a collaborator endpoint driver, and session policy setup. */
export async function apply(ctx: Context): Promise<void> {
  const sharedAgentReady = Promise.withResolvers<Agent>()
  const exerciseAlwaysAllow = process.env.DSH_SNAPSHOT_SHARED_APP_ALWAYS_ALLOW === '1'
  let rememberedApproval = false
  let approvalCount = 0
  ctx.on('agent/created', ({ agent }: { readonly agent: Agent }) => {
    if (!String(agent.id).startsWith(SHARED_SESSION_PREFIX)) return
    setApprovalPolicy(agent.session, 'ask')
    agent.ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      const decision = await next()
      if (exec.name !== FIXTURE_TOOL || rememberedApproval) return decision
      return {
        kind: 'ask',
        reason: 'Collaborator approval is required before the shared connected app runs.',
      } satisfies PreToolDecision
    })
    sharedAgentReady.resolve(agent)
  })
  await applyConnectedApp(ctx)
  const driverReady = sharedAgentReady.promise.then(() => createSharedApprovalDriver(ctx))
  const drivers = new Set<Promise<void>>()
  let approvalStarted = false

  ctx.effect(() => async () => {
    for (const pending of drivers) await pending
    await driverReady
  }, 'snapshot shared approval driver')

  ctx.on('llm/stream', (options, next) => {
    if (approvalStarted || options.sessionId === undefined || !String(options.sessionId).startsWith(SHARED_SESSION_PREFIX)) {
      return next()
    }
    const sharedAgent = ctx.agents.get(options.sessionId)
    if (sharedAgent !== undefined) setApprovalPolicy(sharedAgent.session, 'ask')
    approvalStarted = true
    const pending = driverReady.then(driver => waitForApprovalAndAllow(
      driver,
      new AbortController().signal,
      exerciseAlwaysAllow ? 'always-allow' : 'allow',
      () => {
        approvalCount += 1
        if (exerciseAlwaysAllow && approvalCount !== 1) {
          throw new Error('snapshot shared Bot Always allow asked for a second approval')
        }
        if (exerciseAlwaysAllow) rememberedApproval = true
      },
    ))
    drivers.add(pending)
    return next()
  })
}
