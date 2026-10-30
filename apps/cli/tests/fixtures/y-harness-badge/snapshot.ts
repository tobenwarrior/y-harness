import { fileURLToPath } from 'node:url'
import { agentEvents, type Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { boot, loadOverlayPatches } from '@yharness/app-boot'
import { SessionId } from '@yharness/session'
import type {} from '@yharness/skill'
import type {} from '@yharness/tools'
import { unsupportedInbox } from '@yharness/agent-loop-testkit'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('Y Harness badge snapshot requires an overlay path')
const skillName = process.argv[3] ?? 'y-harness-badge'
const snapshotName = `y-harness-badge-snapshot-${skillName}`
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot(snapshotName, rootConfigPath, [
  ...loadOverlayPatches(snapshotName, basePatchPath),
  ...loadOverlayPatches(snapshotName, overlayPath),
])

try {
  const agentId = SessionId(snapshotName)
  const session = ctx.sessions.create(agentId, { meta: { cwd: process.cwd() } })
  const agent: Agent = {
    ctx,
    id: agentId,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('Y Harness badge snapshot must receive the catalog at the step boundary') },
    cancel: () => {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const catalog = decision.kind === 'enter'
    ? decision.messages.find(message => message.role === 'user'
      && message.source.kind === 'skill-catalog')?.content
    : undefined
  const summary = (await ctx.skills.list()).find(skill => skill.name === skillName)
  const directLoad = skillName === 'dsh-badge' ? await ctx.skills.get(skillName) : undefined
  const result = await ctx.tools.execute({
    callId: ToolCallId(`${snapshotName}-load`),
    name: 'skill',
    arguments: { name: skillName },
    signal: new AbortController().signal,
  })
  process.stdout.write(`${JSON.stringify({
    catalog: catalog ?? null,
    summary: summary ?? null,
    result,
    ...directLoad === undefined ? {} : {
      directLoad: {
        name: directLoad.name,
        provider: directLoad.provider,
        invocation: directLoad.invocation,
        content: directLoad.content,
      },
    },
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
