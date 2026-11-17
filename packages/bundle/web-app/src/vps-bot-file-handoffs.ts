/** Copies between two owner Bot workspaces while preserving each workspace's private mount. */

import type { BotId, BotView } from '@yharness/bots'
import { brandString } from '@yharness/brand'
import type { Context } from '@yharness/cordis'
import type { SessionId } from '@yharness/session/types'
import type { ContentBlock } from '@yharness/llm'
import { defineTool, type ToolExecution } from '@yharness/tools'
import { uploadComputerFile, type VpsFileUploadLimits } from './vps-bot-upload.ts'
import { isVpsSharedPath, type VpsRuntime } from './vps-runtime.ts'

/** One recipient the owner can select for a file copy. */
export interface ComputerFileRecipient {
  /** Durable owner Bot identity. */
  readonly id: BotId
  /** Current display name. */
  readonly name: string
}

/** One owner-authorized file and its selected destination Bot. */
export interface ComputerFileCopyRequest {
  /** Exact source Bot Session. */
  readonly sessionId: SessionId
  /** File inside that Bot's Computer workspace. */
  readonly path: string
  /** Displayed version when copied from a preview. */
  readonly version?: string
  /** Exact recipient Bot. */
  readonly targetBotId: BotId
}

/** Settled copy receipt or the reason the destination could not be created. */
export type ComputerFileCopyResult =
  | { readonly status: 'copied'; readonly name: string; readonly recipient: ComputerFileRecipient }
  | { readonly status: 'source-unavailable' | 'source-changed' | 'target-unavailable' | 'exists' | 'too-large' | 'no-space' | 'unavailable' }

function recipientOf(bot: BotView): ComputerFileRecipient {
  return { id: bot.id, name: bot.name }
}

const copyFailure: Readonly<Record<Exclude<ComputerFileCopyResult['status'], 'copied'>, string>> = {
  'source-unavailable': 'The source file is unavailable in your VPS workspace.',
  'source-changed': 'The source file changed. Read it again before copying.',
  'target-unavailable': 'The selected Bot does not have an available private VPS workspace.',
  exists: 'The receiving Bot already has a file with this name.',
  'too-large': 'The source file exceeds the VPS transfer limit.',
  'no-space': 'There is not enough free space on the receiving Bot’s VPS.',
  unavailable: 'The file could not be copied.',
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, text: string): ContentBlock[] => [{ type: 'text', text }],
} as const

/** Owner-only file copy operations backed by the existing private workspace services. */
export class VpsBotFileHandoffs {
  /**
   * @param ctx - composition containing the owner roster and Workspace Files.
   * @param runtimeFor - private runtime selected for an eligible Bot.
   * @param eligible - verifies the VPS deployment assigned that Bot a private Computer.
   * @param limits - private workspace transfer limits.
   */
  constructor(
    private readonly ctx: Pick<Context, 'bots' | 'workspaceFiles'>,
    private readonly runtimeFor: (botId: BotId) => VpsRuntime,
    private readonly eligible: (botId: BotId) => boolean,
    private readonly limits: VpsFileUploadLimits,
  ) {}

  /**
   * List active owner workspace recipients without opening their Computers or chats.
   * @param sessionId - exact source Bot Session.
   * @param signal - request lifetime.
   * @returns visible eligible recipients, or undefined for an ineligible source.
   */
  async recipients(sessionId: SessionId, signal: AbortSignal): Promise<readonly ComputerFileRecipient[] | undefined> {
    const source = await this.ownerWorkspace(sessionId, signal)
    if (source === undefined) return undefined
    const targets = await this.targets(source.id, signal)
    return targets.map(recipientOf)
  }

  /**
   * Transfer a verified private file into the recipient's workspace root.
   * @param request - source and exact recipient selected by the owner or approved Bot action.
   * @param signal - transfer lifetime.
   * @returns the copy receipt. An occupied destination is preserved.
   */
  async copy(request: ComputerFileCopyRequest, signal: AbortSignal): Promise<ComputerFileCopyResult> {
    const source = await this.ownerWorkspace(request.sessionId, signal)
    if (source === undefined || isVpsSharedPath(request.path, this.runtimeFor(source.id).workspace(request.sessionId))) {
      return { status: 'source-unavailable' }
    }
    const target = (await this.targets(source.id, signal)).find(bot => bot.id === request.targetBotId)
    if (target === undefined || (await this.ownerWorkspace(target.sessionId, signal))?.id !== target.id) {
      return { status: 'target-unavailable' }
    }
    let file: Awaited<ReturnType<Context['workspaceFiles']['openComputerFile']>>
    try {
      file = await this.ctx.workspaceFiles.openComputerFile(request.sessionId, request.path, signal, request.version)
    } catch (error) {
      signal.throwIfAborted()
      const changed = typeof error === 'object' && error !== null && 'code' in error && error.code === 'workspace-file/changed'
      return { status: changed ? 'source-changed' : 'source-unavailable' }
    }
    try {
      if (file.bytes === undefined) return { status: 'unavailable' }
      if (file.bytes > this.limits.maxBytes) return { status: 'too-large' }
      const written = await uploadComputerFile(this.runtimeFor(target.id), target.sessionId, {
        directory: '.', name: file.name, bytes: file.bytes, body: file.body,
      }, this.limits, signal)
      switch (written) {
        case 'stored': return { status: 'copied', name: file.name, recipient: recipientOf(target) }
        case 'incomplete': return { status: 'source-changed' }
        case 'folder-unavailable': return { status: 'target-unavailable' }
        default: return { status: written }
      }
    } finally {
      // An interrupted source stream may already carry its settled read error.
      await file.body.cancel().catch((error: unknown) => { void error })
    }
  }

  /**
   * Read a text page from the calling Bot's own Computer.
   * @param sessionId - exact authorized owner Session.
   * @param path - private Computer path.
   * @param offset - requested one-based first line.
   * @param signal - reader lifetime.
   * @returns one page of text.
   */
  async read(sessionId: SessionId, path: string, offset: number, signal: AbortSignal): Promise<string> {
    const owner = await this.ownerWorkspace(sessionId, signal)
    if (owner === undefined) throw new Error('The Bot’s private VPS workspace is unavailable.')
    const workspaceRoot = this.runtimeFor(owner.id).workspace(sessionId)
    if (isVpsSharedPath(path, workspaceRoot)) throw new Error('Use vps_project_files to read a shared project file.')
    const page = await this.ctx.workspaceFiles.read({ sessionId, workspaceRoot }, { computer: path }, { offset, limit: 200 }, signal)
    return page.eof ? page.text : `${page.text}\nContinue at line ${offset + page.lines}.`
  }

  private async ownerWorkspace(sessionId: SessionId, signal: AbortSignal) {
    signal.throwIfAborted()
    const bot = await this.ctx.bots.ownerBotForSession(sessionId)
    signal.throwIfAborted()
    return bot?.state === 'active' && this.eligible(bot.id) ? bot : undefined
  }

  private async targets(source: BotId, signal: AbortSignal): Promise<readonly BotView[]> {
    const { bots } = await this.ctx.bots.list({})
    signal.throwIfAborted()
    return bots.filter(bot => bot.id !== source && bot.state === 'active' && this.eligible(bot.id))
  }
}

/**
 * Register file handoffs for one exact owner Bot Agent.
 * @param ctx - scoped tool registration.
 * @param agent - exact owning Agent.
 * @param files - private file services for this deployment.
 * @param separateWorkspace - add a Computer reader for a desktop-only Bot.
 */
export function registerVpsBotFileTools(ctx: Context, agent: NonNullable<ToolExecution['agent']>, files: VpsBotFileHandoffs, separateWorkspace: boolean): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'copy_vps_file',
    description: 'When the owner asks for a handoff, copy a file from this Bot’s private VPS workspace into another Bot’s workspace root. '
      + 'Use the recipient’s exact id from list_bots or an @mention. Check the result before using send_bot_message to tell them where to continue.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path of the file in your private VPS workspace.' },
      targetBotId: { type: 'string', required: true, description: 'Exact recipient Bot id.' },
    },
    output: textOutput,
    presentCall: () => ({ card: 'generic', title: 'Copy VPS file to Bot' }),
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('File copy requires the owning Bot.')
      const outcome = await files.copy({
        sessionId: agent.session.id, path: args.path, targetBotId: brandString<BotId>(args.targetBotId),
      }, exec.signal)
      if (outcome.status !== 'copied') throw new Error(copyFailure[outcome.status])
      return 'Copied ' + JSON.stringify(outcome.name) + ' into ' + outcome.recipient.name + '’s VPS workspace root.'
    },
  })), 'vps-bots: copy files to another Bot')
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'copy_vps_file'
    ? Promise.resolve({ kind: 'ask', reason: 'This copies a file to another Bot’s private workspace.' })
    : next())
  if (!separateWorkspace) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_vps_file',
    description: 'Read UTF-8 text from this Bot’s own VPS Computer workspace. Use it for text files copied to you by another Bot.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path in your VPS Computer workspace.' },
      offset: { type: 'integer', description: 'First line to read. Starts at 1.' },
    },
    output: textOutput,
    presentCall: () => ({ card: 'generic', title: 'Read VPS file' }),
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('File reads require the owning Bot.')
      return files.read(agent.session.id, args.path, args.offset ?? 1, exec.signal)
    },
  })), 'vps-bots: read private Computer files')
}
