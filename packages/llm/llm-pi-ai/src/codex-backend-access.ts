/** Session-owned native Codex execution policy and human interaction routing. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import { declineCodexRequest } from './codex-backend.ts'

type Obj = Record<string, unknown>
const questionSchema = z.object({ questions: z.array(z.object({
  id: z.string().min(1), header: z.string(), question: z.string().min(1),
  isSecret: z.boolean().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string() })).nullish(),
})).min(1) })
const permissionSchema = z.object({
  network: z.object({ enabled: z.boolean().nullish() }).strict().nullish(),
  fileSystem: z.object({
    read: z.array(z.string()).nullish(), write: z.array(z.string()).nullish(),
    globScanMaxDepth: z.number().int().positive().nullish(),
    entries: z.array(z.object({
      access: z.enum(['read', 'write', 'deny']),
      path: z.discriminatedUnion('type', [
        z.object({ type: z.literal('path'), path: z.string() }).strict(),
        z.object({ type: z.literal('glob_pattern'), pattern: z.string() }).strict(),
        z.object({ type: z.literal('special'), value: z.record(z.string(), z.json()) }).strict(),
      ]),
    }).strict()).nullish(),
  }).strict().nullish(),
}).strict()

/** Native execution settings and the interaction handler captured for one Harness turn. */
export interface CodexTurnAccess {
  cwd: string
  sandbox: SandboxMode
  writableRoots: string[]
  approvalPolicy: 'on-request' | 'never'
  sandboxPolicy: Obj
  request: (method: string, params: Obj) => Promise<unknown>
}

/**
 * Resolve native execution from the exact live initiating Harness agent. Harness
 * file policy does not restrict networking, so confined native policies allow it.
 * Missing session authority or policy services fail before a native turn starts.
 * @param ctx - context owning the live agent and policy services.
 * @param options - assembled request identity and cancellation lifetime.
 * @returns session settings and action-scoped approval/question forwarding.
 */
export function resolveCodexAccess(ctx: Context, options: GenerateOptions | Pick<GenerateOptions, 'sessionId' | 'signal'>): CodexTurnAccess {
  const agents = ctx.get('agents')
  const agent = agents?.currentInitiator()
  if (agent === undefined || agents?.get(agent.id) !== agent
    || (options.sessionId !== undefined && options.sessionId !== agent.session.id)) {
    throw new Error('Native Codex turns require the exact live Harness session initiator.')
  }
  const session = agent.session
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const approval = ctx.get('approval')
  if (sandboxPolicy === undefined || approval === undefined) throw new Error('Native Codex requires Harness sandbox and approval services.')
  const policy = sandboxPolicy.resolve({ session })
  const cwd = session.header.cwd ?? policy.workspaceRoot
  if (!isAbsolute(cwd)) throw new Error('Native Codex requires an absolute Harness session working directory.')
  const roots = writableRoots(policy)
  const approvalPolicy = (approval.overrideOf(session) ?? approval.config.policy ?? 'ask') === 'never' ? 'never' : 'on-request'
  const nativePolicy: Obj = policy.mode === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : policy.mode === 'read-only' ? { type: 'readOnly', networkAccess: true }
      : { type: 'workspaceWrite', writableRoots: roots, networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
  return { cwd, sandbox: policy.mode, writableRoots: roots, approvalPolicy, sandboxPolicy: nativePolicy,
    request: async (method, params) => {
      if (options.signal?.aborted) return declineCodexRequest(method, params)
      if (method === 'item/tool/requestUserInput') {
        const { questions } = questionSchema.parse(params)
        if (questions.some(question => question.isSecret === true)) throw new Error('Native secret questions require a dedicated credential flow.')
        const interaction = ctx.get('userQuestions')
        if (interaction === undefined) throw new Error('Native Codex questions require the Harness user-questions service.')
        const answer = await interaction.ask({ agent,
          questions: questions.map(({ isSecret: _isSecret, options: choices, ...question }) => ({
            ...question, ...(choices == null ? {} : { options: choices }),
          })), ...(options.signal === undefined ? {} : { signal: options.signal }) })
        return { answers: Object.fromEntries(answer.answers.map(item => [item.id, {
          answers: [...item.selected, ...(item.custom === undefined ? [] : [item.custom])],
        }])) }
      }
      if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval'
        && method !== 'item/permissions/requestApproval') return declineCodexRequest(method, params)
      const permissions = method === 'item/permissions/requestApproval' ? permissionSchema.parse(params.permissions) : undefined
      const outcome = await approval.request({ agent, toolName: method,
        reason: JSON.stringify(params), ...(options.signal === undefined ? {} : { signal: options.signal }) })
      if (permissions !== undefined) return { permissions: outcome === 'allowed-once' ? permissions : {}, scope: 'turn' }
      return { decision: outcome === 'allowed-once' ? 'accept' : outcome === 'cancelled' ? 'cancel' : 'decline' }
    } }
}
