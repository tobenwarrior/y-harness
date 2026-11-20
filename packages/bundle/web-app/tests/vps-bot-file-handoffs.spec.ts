import { BotId, type BotView } from '@yharness/bots'
import { Context, type Context as CordisContext } from '@yharness/cordis'
import { SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime, { type ToolRunContext } from '@yharness/tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadComputerFile, type VpsFileUploadLimits } from '../src/vps-bot-upload.ts'
import {
  VpsBotFileHandoffs,
  registerVpsBotFileTools,
  type ComputerFileCopyRequest,
} from '../src/vps-bot-file-handoffs.ts'
import type { VpsRuntime } from '../src/vps-runtime.ts'

vi.mock('../src/vps-bot-upload.ts', () => ({ uploadComputerFile: vi.fn() }))

const SOURCE_ID = BotId('bot-source')
const TARGET_ID = BotId('bot-target')
const OTHER_ID = BotId('bot-other')
const SOURCE_SESSION = SessionId('session-source')
const TARGET_SESSION = SessionId('session-target')
const OTHER_SESSION = SessionId('session-other')
const LIMITS: VpsFileUploadLimits = { maxBytes: 100, reserveBytes: 0, timeoutMs: 1000 }

function bot(id: BotId, sessionId: SessionId, name: string, state: BotView['state'] = 'active'): BotView {
  return {
    id,
    sessionId,
    name,
    identity: 'agent',
    accent: 'blue',
    cwd: '/workspace',
    state,
    availability: 'idle',
    pinned: false,
    hidden: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

const SOURCE = bot(SOURCE_ID, SOURCE_SESSION, 'Source Bot')
const TARGET = bot(TARGET_ID, TARGET_SESSION, 'Target Bot')
const OTHER = bot(OTHER_ID, OTHER_SESSION, 'Other Bot')

function transfer(
  bytes: number | undefined,
  name = 'notes.txt',
  cancel = vi.fn<ReadableStream<Uint8Array<ArrayBuffer>>['cancel']>().mockResolvedValue(undefined),
) {
  return {
    name,
    bytes,
    cancel,
    body: { cancel } as never as ReadableStream<Uint8Array<ArrayBuffer>>,
  }
}

function request(targetBotId: BotId = TARGET_ID, path = '/private/source/notes.txt', version?: string): ComputerFileCopyRequest {
  return version === undefined
    ? { sessionId: SOURCE_SESSION, path, targetBotId }
    : { sessionId: SOURCE_SESSION, path, targetBotId, version }
}

function toolRun(agent: NonNullable<ToolRunContext['agent']>, signal = new AbortController().signal): ToolRunContext {
  return { agent, signal } as never
}

function runtimeFor(botId: BotId): VpsRuntime {
  return { workspace: (sessionId: SessionId) => `/private/${String(botId)}/${String(sessionId)}` } as never as VpsRuntime
}

function harness() {
  const ownerBotForSession = vi.fn<CordisContext['bots']['ownerBotForSession']>()
  const list = vi.fn<CordisContext['bots']['list']>()
  const openComputerFile = vi.fn<CordisContext['workspaceFiles']['openComputerFile']>()
  const read = vi.fn<CordisContext['workspaceFiles']['read']>()
  const bots = [SOURCE, TARGET]
  ownerBotForSession.mockImplementation(async sessionId => bots.find(candidate => candidate.sessionId === sessionId))
  list.mockResolvedValue({ bots })
  const ctx = { bots: { ownerBotForSession, list }, workspaceFiles: { openComputerFile, read } } as never as Pick<CordisContext, 'bots' | 'workspaceFiles'>
  const eligible = vi.fn<(botId: BotId) => boolean>().mockReturnValue(true)
  const files = new VpsBotFileHandoffs(ctx, runtimeFor, eligible, LIMITS)
  return { files, ownerBotForSession, list, openComputerFile, read, eligible }
}

describe('VpsBotFileHandoffs', () => {
  beforeEach(() => {
    vi.mocked(uploadComputerFile).mockReset()
  })

  it('lists only active eligible recipients for an active eligible owner', async () => {
    const h = harness()
    h.list.mockResolvedValue({ bots: [SOURCE, TARGET, OTHER, bot(BotId('bot-cold'), SessionId('session-cold'), 'Cold Bot', 'provisioning')] })
    h.eligible.mockImplementation(id => id === SOURCE_ID || id === TARGET_ID)

    await expect(h.files.recipients(SOURCE_SESSION, new AbortController().signal)).resolves.toEqual([
      { id: TARGET_ID, name: 'Target Bot' },
    ])
    expect(h.list).toHaveBeenCalledExactlyOnceWith({})
  })

  it('does not enumerate recipients for an absent or ineligible owner', async () => {
    const h = harness()
    h.ownerBotForSession.mockResolvedValueOnce(undefined)
    await expect(h.files.recipients(SessionId('missing'), new AbortController().signal)).resolves.toBeUndefined()
    expect(h.list).not.toHaveBeenCalled()

    h.eligible.mockReturnValue(false)
    await expect(h.files.recipients(SOURCE_SESSION, new AbortController().signal)).resolves.toBeUndefined()
    expect(h.list).not.toHaveBeenCalled()
  })

  it('honors cancellation before lookup and after owner/list resolution', async () => {
    const h = harness()
    const before = new AbortController()
    before.abort()
    await expect(h.files.recipients(SOURCE_SESSION, before.signal)).rejects.toThrow()

    const afterOwner = new AbortController()
    h.ownerBotForSession.mockImplementationOnce(async () => {
      afterOwner.abort()
      return SOURCE
    })
    await expect(h.files.recipients(SOURCE_SESSION, afterOwner.signal)).rejects.toThrow()

    const afterList = new AbortController()
    h.list.mockImplementationOnce(async () => {
      afterList.abort()
      return { bots: [SOURCE, TARGET] }
    })
    await expect(h.files.recipients(SOURCE_SESSION, afterList.signal)).rejects.toThrow()
  })

  it('rejects shared source paths and recipients outside the active owner roster', async () => {
    const shared = harness()
    await expect(shared.files.copy(request(TARGET_ID, '/workspace/notes.txt'), new AbortController().signal)).resolves.toEqual({ status: 'source-unavailable' })
    expect(shared.openComputerFile).not.toHaveBeenCalled()

    const missingTarget = harness()
    missingTarget.list.mockResolvedValue({ bots: [SOURCE] })
    await expect(missingTarget.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'target-unavailable' })

    const wrongOwner = harness()
    wrongOwner.ownerBotForSession.mockImplementation(async sessionId => sessionId === SOURCE_SESSION ? SOURCE : OTHER)
    await expect(wrongOwner.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'target-unavailable' })
  })

  it('maps changed and unavailable source opens, including cancellation during the open', async () => {
    const changed = harness()
    changed.openComputerFile.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'workspace-file/changed' }))
    await expect(changed.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'source-changed' })

    const unavailable = harness()
    unavailable.openComputerFile.mockRejectedValueOnce(new Error('gone'))
    await expect(unavailable.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'source-unavailable' })

    const cancelled = harness()
    const controller = new AbortController()
    cancelled.openComputerFile.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('gone')
    })
    await expect(cancelled.files.copy(request(), controller.signal)).rejects.toThrow()
  })

  it('preserves unavailable and oversized files without uploading them', async () => {
    const noSize = harness()
    const noSizeFile = transfer(undefined)
    noSize.openComputerFile.mockResolvedValueOnce(noSizeFile)
    await expect(noSize.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'unavailable' })
    expect(noSizeFile.cancel).toHaveBeenCalledExactlyOnceWith()
    expect(uploadComputerFile).not.toHaveBeenCalled()

    const tooLarge = harness()
    const largeFile = transfer(101)
    tooLarge.openComputerFile.mockResolvedValueOnce(largeFile)
    await expect(tooLarge.files.copy(request(), new AbortController().signal)).resolves.toEqual({ status: 'too-large' })
    expect(largeFile.cancel).toHaveBeenCalledExactlyOnceWith()
    expect(uploadComputerFile).not.toHaveBeenCalled()
  })

  it.each([
    ['stored', { status: 'copied', name: 'notes.txt', recipient: { id: TARGET_ID, name: 'Target Bot' } }],
    ['incomplete', { status: 'source-changed' }],
    ['folder-unavailable', { status: 'target-unavailable' }],
    ['exists', { status: 'exists' }],
    ['no-space', { status: 'no-space' }],
    ['unavailable', { status: 'unavailable' }],
  ] as const)('maps upload result %s and always cancels the source body', async (written, expected) => {
    const h = harness()
    const file = transfer(4)
    h.openComputerFile.mockResolvedValueOnce(file)
    vi.mocked(uploadComputerFile).mockResolvedValueOnce(written)

    await expect(h.files.copy(request(), new AbortController().signal)).resolves.toEqual(expected)
    const uploadCall = vi.mocked(uploadComputerFile).mock.calls[0]
    expect(uploadCall?.[0].workspace(TARGET_SESSION)).toBe('/private/bot-target/session-target')
    expect(uploadCall?.[1]).toBe(TARGET_SESSION)
    expect(uploadCall?.[2]).toEqual({ directory: '.', name: 'notes.txt', bytes: 4, body: file.body })
    expect(uploadCall?.[3]).toBe(LIMITS)
    expect(uploadCall?.[4]).toBeInstanceOf(AbortSignal)
    expect(file.cancel).toHaveBeenCalledExactlyOnceWith()
  })

  it('swallows a settled source body cancellation failure after a successful upload', async () => {
    const h = harness()
    const cancel = vi.fn<ReadableStream<Uint8Array<ArrayBuffer>>['cancel']>().mockRejectedValue(new Error('already closed'))
    const file = transfer(4, 'notes.txt', cancel)
    h.openComputerFile.mockResolvedValueOnce(file)
    vi.mocked(uploadComputerFile).mockResolvedValueOnce('stored')

    await expect(h.files.copy(request(), new AbortController().signal)).resolves.toMatchObject({ status: 'copied' })
    expect(cancel).toHaveBeenCalledExactlyOnceWith()
  })

  it('reads private pages, continues incomplete pages, and denies unavailable/shared paths', async () => {
    const h = harness()
    h.read.mockResolvedValueOnce({ absolutePath: '/private/source/notes.txt', version: 'v1', offset: 3, text: 'one', lines: 2, eof: false })
    const signal = new AbortController().signal
    await expect(h.files.read(SOURCE_SESSION, '/private/source/notes.txt', 3, signal)).resolves.toBe('one\nContinue at line 5.')
    expect(h.read).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SOURCE_SESSION, workspaceRoot: '/private/bot-source/session-source' },
      { computer: '/private/source/notes.txt' }, { offset: 3, limit: 200 }, signal,
    )

    h.read.mockResolvedValueOnce({ absolutePath: '/private/source/end.txt', version: 'v2', offset: 1, text: 'done', lines: 1, eof: true })
    await expect(h.files.read(SOURCE_SESSION, '/private/source/end.txt', 1, signal)).resolves.toBe('done')

    await expect(h.files.read(SOURCE_SESSION, '/workspace/notes.txt', 1, signal)).rejects.toThrow('Use vps_project_files')
    h.ownerBotForSession.mockResolvedValueOnce(undefined)
    await expect(h.files.read(SessionId('missing'), '/private/missing.txt', 1, signal)).rejects.toThrow('workspace is unavailable')
  })
})

describe('registerVpsBotFileTools', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  })

  async function setup(separateWorkspace: boolean) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const h = harness()
    const agent = { session: { id: SOURCE_SESSION } } as never as NonNullable<ToolRunContext['agent']>
    registerVpsBotFileTools(ctx, agent, h.files, separateWorkspace)
    return { ctx, h, agent }
  }

  it('registers and guards the owner-only copy tool while omitting an absent version', async () => {
    const { ctx, h, agent } = await setup(false)
    const definition = ctx.tools.get('copy_vps_file')
    expect(definition).toBeDefined()
    expect(ctx.tools.get('read_vps_file')).toBeUndefined()
    expect(definition?.presentCall?.({ path: '/private/source/notes.txt', targetBotId: String(TARGET_ID) })).toEqual({ card: 'generic', title: 'Copy VPS file to Bot' })
    expect(definition?.output.render({}, 'copied')).toEqual([{ type: 'text', text: 'copied' }])

    const signal = new AbortController().signal
    const copy = vi.spyOn(h.files, 'copy').mockResolvedValue({ status: 'copied', name: 'notes.txt', recipient: { id: TARGET_ID, name: 'Target Bot' } })
    await expect(definition?.execute({ path: '/private/source/notes.txt', targetBotId: String(TARGET_ID) }, toolRun(agent, signal))).resolves.toBe('Copied "notes.txt" into Target Bot’s VPS workspace root.')
    expect(copy.mock.calls).toStrictEqual([
      [{ sessionId: SOURCE_SESSION, path: '/private/source/notes.txt', targetBotId: TARGET_ID }, signal],
    ])

    await expect(definition?.execute({ path: '/private/source/notes.txt', targetBotId: String(TARGET_ID) }, toolRun({} as never as NonNullable<ToolRunContext['agent']>, signal))).rejects.toThrow('owning Bot')

    const downstream = { kind: 'allow' as const }
    await expect(ctx.waterfall('tools/pre-execute', { name: 'copy_vps_file' } as never, () => Promise.resolve(downstream as never))).resolves.toMatchObject({ kind: 'ask' })
    await expect(ctx.waterfall('tools/pre-execute', { name: 'other_tool' } as never, () => Promise.resolve(downstream as never))).resolves.toBe(downstream)
  })

  it.each([
    ['source-unavailable', 'source file is unavailable'],
    ['source-changed', 'source file changed'],
    ['target-unavailable', 'selected Bot does not have'],
    ['exists', 'already has a file'],
    ['too-large', 'exceeds the VPS transfer limit'],
    ['no-space', 'not enough free space'],
    ['unavailable', 'could not be copied'],
  ] as const)('reports copy failure %s', async (status, message) => {
    const { ctx, h, agent } = await setup(false)
    const definition = ctx.tools.get('copy_vps_file')
    vi.spyOn(h.files, 'copy').mockResolvedValue({ status })
    await expect(definition?.execute({ path: '/private/source/notes.txt', targetBotId: String(TARGET_ID) }, toolRun(agent))).rejects.toThrow(message)
  })

  it('adds an owner-only private reader with its default and explicit offsets', async () => {
    const { ctx, h, agent } = await setup(true)
    const definition = ctx.tools.get('read_vps_file')
    expect(definition).toBeDefined()
    expect(definition?.presentCall?.({ path: '/private/source/notes.txt' })).toEqual({ card: 'generic', title: 'Read VPS file' })
    expect(definition?.output.render({}, 'page')).toEqual([{ type: 'text', text: 'page' }])
    const read = vi.spyOn(h.files, 'read').mockResolvedValue('page')

    await expect(definition?.execute({ path: '/private/source/notes.txt' }, toolRun(agent))).resolves.toBe('page')
    await expect(definition?.execute({ path: '/private/source/notes.txt', offset: 4 }, toolRun(agent))).resolves.toBe('page')
    expect(read).toHaveBeenNthCalledWith(1, SOURCE_SESSION, '/private/source/notes.txt', 1, expect.any(AbortSignal))
    expect(read).toHaveBeenNthCalledWith(2, SOURCE_SESSION, '/private/source/notes.txt', 4, expect.any(AbortSignal))

    await expect(definition?.execute({ path: '/private/source/notes.txt' }, toolRun({} as never as NonNullable<ToolRunContext['agent']>))).rejects.toThrow('owning Bot')
  })
})
