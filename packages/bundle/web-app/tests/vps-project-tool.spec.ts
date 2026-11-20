import type { Agent } from '@yharness/agent'
import type { WorkspaceFileAccess } from '@yharness/api-workspace-files'
import { Context } from '@yharness/cordis'
import { FsTargetKey, FsVersion } from '@yharness/fs'
import { ToolCallId } from '@yharness/llm'
import { SandboxPolicyService } from '@yharness/sandbox-policy'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@yharness/session'
import SessionProjections from '@yharness/session-projection'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsBotFileSystem } from '../src/vps-bot-files.ts'
import { registerVpsProjectTool } from '../src/vps-project-tool.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const ROOT = '/workspace'
const SESSION = SessionId('bot-session-fixture')
const TARGET = { targetKey: FsTargetKey('notes'), displayPath: '/workspace/notes.txt' }
const VERSION = FsVersion('version-one')
const PAGE = { absolutePath: TARGET.displayPath, version: VERSION, offset: 1, text: 'Page', lines: 2, eof: false }
const TOOL = 'vps_project_files'
const roots: Context[] = []

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

async function setup(mode?: 'workspace-write' | 'read-only') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (mode !== undefined) {
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: ROOT })
  }
  const session = Session.create(SESSION, [], {
    id: SESSION, version: SESSION_FORMAT_VERSION, cwd: ROOT, isSeeded: false, createdAt: 0,
  })
  const owner = { id: SESSION, session, ctx } as Agent
  const runtime = new VpsRuntime('/fixture', 'localhost/fixture', {}, { sharedWorkspace: true })
  const fs = new VpsBotFileSystem(ctx, runtime, SESSION, 'shared')
  const resolve = vi.spyOn(fs, 'resolve').mockResolvedValue(TARGET)
  const write = vi.spyOn(fs, 'writeText').mockResolvedValue({ operation: 'create', before: null, after: '', version: VERSION })
  const access = vi.fn<(signal: AbortSignal) => Promise<WorkspaceFileAccess | undefined>>()
    .mockResolvedValue({ workspaceRoot: ROOT, fs })
  const list = vi.fn<Context['workspaceFiles']['list']>().mockResolvedValue({ path: '', entries: [], truncated: false })
  const read = vi.fn<Context['workspaceFiles']['read']>().mockResolvedValue(PAGE)
  const setGrant = registerVpsProjectTool(ctx, owner, { read, list }, access)
  const signal = new AbortController().signal
  const call = async (args: Record<string, unknown>, agent = owner) => {
    const result = await ctx.tools.execute({ name: TOOL, callId: ToolCallId('fixture'), arguments: args, agent, signal })
    return { success: !result.isError, text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }
  }
  return { ctx, owner, resolve, write, access, list, read, setGrant, signal, call }
}

describe('VPS Bot project tool', () => {
  it('registers the owner tool once per grant and closes its registration after revocation', async () => {
    const { ctx, setGrant } = await setup()
    await setGrant(false)
    expect(ctx.tools.get(TOOL)).toBeUndefined()
    await setGrant(true)
    const definition = ctx.tools.get(TOOL)
    await setGrant(true)
    expect(definition?.presentCall?.({ action: 'write' })).toEqual({ card: 'generic', title: 'Save project file' })
    expect(definition?.presentCall?.({ action: 'list' })).toEqual({ card: 'generic', title: 'Read shared project' })
    expect(ctx.tools.get(TOOL)).toBe(definition)
    await setGrant(false)
    expect(ctx.tools.get(TOOL)).toBeUndefined()
  })

  it('revalidates ownership and access and rejects paths outside the project', async () => {
    const { owner, access, list, read, setGrant, call } = await setup()
    await setGrant(true)
    await expect(call({ action: 'list' }, { ...owner })).resolves.toMatchObject({ success: false, text: 'Error: Shared project access requires the participating Bot.' })
    expect(access).not.toHaveBeenCalled()
    access.mockResolvedValueOnce(undefined)
    await expect(call({ action: 'list' })).resolves.toMatchObject({ success: false, text: 'Error: This Bot does not have shared project access.' })
    await expect(call({ action: 'read' })).resolves.toMatchObject({ success: false, text: 'Error: Choose a project file path.' })
    await expect(call({ action: 'read', path: '../outside.txt' })).resolves.toMatchObject({ success: false, text: 'Error: Choose a path inside the shared project.' })
    expect(list).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it('lists the project root and reads bounded pages with exact file versions', async () => {
    const { list, read, setGrant, call, signal } = await setup()
    await setGrant(true)
    const scope = { sessionId: SESSION, workspaceRoot: ROOT }
    const address = { computer: '/workspace/notes.txt' }
    await expect(call({ action: 'list' })).resolves.toEqual({ success: true, text: '{"path":"","entries":[],"truncated":false}' })
    expect(list).toHaveBeenCalledExactlyOnceWith(scope, { computer: ROOT }, signal)
    await expect(call({ action: 'read', path: 'notes.txt' })).resolves.toEqual({ success: true, text: '{"text":"Page","version":"version-one","nextOffset":3}' })
    expect(read).toHaveBeenLastCalledWith(scope, address, { offset: 1, limit: 200 }, signal)
    read.mockResolvedValueOnce({ ...PAGE, eof: true })
    await expect(call({ action: 'read', path: '/workspace/notes.txt', offset: 3 })).resolves.toEqual({ success: true, text: '{"text":"Page","version":"version-one"}' })
    expect(read).toHaveBeenLastCalledWith(scope, address, { offset: 3, limit: 200 }, signal)
  })

  it.each([undefined, 'read-only'] as const)('denies writes with policy %s', async (mode) => {
    const { write, resolve, setGrant, call } = await setup(mode)
    await setGrant(true)
    await expect(call({ action: 'write', path: 'notes.txt' })).resolves.toMatchObject({ success: false, text: 'Error: Supply the complete text to save.' })
    await expect(call({ action: 'write', path: 'notes.txt', content: '' })).resolves.toMatchObject({ success: false, text: 'Error: This Bot Session is read-only.' })
    expect(resolve).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('passes create-only or compare-and-swap intent to the authorized filesystem', async () => {
    const { ctx, owner, write, resolve, setGrant, call, signal } = await setup('workspace-write')
    await setGrant(true)
    const policy = ctx.sandboxPolicy.resolve({ session: owner.session })
    await expect(call({ action: 'write', path: 'notes.txt', content: '' })).resolves.toEqual({ success: true, text: '{"path":"/workspace/notes.txt","version":"version-one"}' })
    expect(resolve).toHaveBeenLastCalledWith('/workspace/notes.txt', { signal })
    expect(write).toHaveBeenLastCalledWith(TARGET, '', { kind: 'createIfAbsent' }, signal, policy)
    await expect(call({ action: 'write', path: 'notes.txt', content: 'Update', version: VERSION })).resolves.toMatchObject({ success: true })
    expect(write).toHaveBeenLastCalledWith(TARGET, 'Update', { kind: 'replaceIfVersion', version: VERSION }, signal, policy)
  })
})
