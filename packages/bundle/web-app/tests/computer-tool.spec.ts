import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import { AttachmentId, type SaveImageAttachment } from '@yharness/attachment'
import LlmRuntime, { ToolCallId } from '@yharness/llm'
import SessionStore, { SessionId } from '@yharness/session'
import SessionProjections from '@yharness/session-projection'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { apply, applyMacComputer, inject } from '../src/computer-tool.ts'
import { MacComputerBridge } from '../src/mac-computer.ts'

const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const frame = { jpeg: screenshot.toString('base64'), width: 1280, height: 800 }
const attachment = {
  attachmentId: AttachmentId('computer-image'), mediaType: 'image/jpeg' as const,
  width: 640, height: 400, bytes: screenshot.length,
}

describe('Computer tool', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentLoop, { agents: [] })
  })

  afterEach(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('uses the latest Session model route before capturing a shared VPS frame', async () => {
    const observe = vi.fn(async () => frame)
    const actAsBot = vi.fn(async () => undefined)
    const saveImage = vi.fn(async (_input: SaveImageAttachment) => attachment)
    const resolveModel = vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider, model) => ({
      provider, id: model, name: model, inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
    }))
    ctx.provide('attachments', { saveImage } as never)
    ctx.provide('vpsComputer', { observe, actAsBot })
    const fiber = await ctx.inject(inject, apply)
    const agent = await ctx.agentLoop.create(SessionId('shared-vps'), { provider: 'initial', model: 'text' })
    const signal = new AbortController().signal
    const call = { name: 'vps_computer', arguments: { action: 'observe' }, signal }

    expect(ctx.tools.get(call.name)?.presentCall?.(call.arguments)).toEqual({ card: 'generic', title: 'Computer' })
    await expect(ctx.tools.execute({ ...call, callId: ToolCallId('no-model-route') })).resolves.toMatchObject({
      isError: true, error: { message: 'The current model route could not be resolved.' },
    })
    await expect(ctx.tools.execute({ ...call, callId: ToolCallId('text-route'), agent })).resolves.toMatchObject({
      isError: true, error: { message: 'Select a model that accepts images to observe the desktop.' },
    })
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith('initial', 'text', signal)
    expect(observe).not.toHaveBeenCalled()
    expect(saveImage).not.toHaveBeenCalled()

    agent.session.append('request/header', { header: { config: { provider: 'selected', model: 'vision' } }, reason: 'initial' })
    await expect(ctx.tools.execute({ ...call, callId: ToolCallId('image-route'), agent })).resolves.toMatchObject({
      isError: false,
      content: [
        { type: 'text', text: 'Desktop coordinates are 1280×800 pixels. This attachment is 640×400 pixels. Scale coordinates if the sizes differ.' },
        { type: 'image', attachment },
      ],
    })
    expect(resolveModel).toHaveBeenLastCalledWith('selected', 'vision', signal)
    expect(observe).toHaveBeenCalledExactlyOnceWith(signal)
    expect(saveImage).toHaveBeenCalledExactlyOnceWith({ data: screenshot, mediaType: 'image/jpeg', name: 'Computer.jpg' })

    await expect(ctx.tools.execute({
      ...call, callId: ToolCallId('shared-input'), arguments: { action: 'key', key: 'Escape' }, agent,
    })).resolves.toMatchObject({ isError: false, content: [{ type: 'text', text: 'Computer input sent.' }] })
    expect(actAsBot).toHaveBeenCalledExactlyOnceWith({ kind: 'key', key: 'Escape' }, signal)
    await fiber.dispose()
    expect(ctx.tools.get(call.name)).toBeUndefined()
  })

  it('passes the calling Session and cancellation to the native Mac bridge', async () => {
    const bridge = new MacComputerBridge()
    const observe = vi.spyOn(bridge, 'observe').mockResolvedValue(frame)
    const request = vi.spyOn(bridge, 'request').mockResolvedValue(undefined)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockResolvedValue({
      provider: 'fixture', id: 'vision', name: 'Vision', inputModalities: ['text', 'image'],
    })
    ctx.provide('attachments', { saveImage: async () => attachment } as never)
    try {
      await ctx.inject(['tools', 'attachments', 'llm'], (scope) => { applyMacComputer(scope, bridge) })
      const agent = await ctx.agentLoop.create(SessionId('native-mac'), { provider: 'fixture', model: 'vision' })
      const signal = new AbortController().signal
      const call = { name: 'mac_computer', signal, agent }

      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('mac-frame'), arguments: { action: 'observe' } }))
        .resolves.toMatchObject({ isError: false, content: [
          { type: 'text' }, { type: 'image', attachment },
        ] })
      expect(observe).toHaveBeenCalledExactlyOnceWith(agent.session.id, signal)
      await expect(ctx.tools.execute({ ...call, callId: ToolCallId('mac-input'), arguments: { action: 'key', key: 'Escape' } }))
        .resolves.toMatchObject({ isError: false })
      expect(request).toHaveBeenCalledExactlyOnceWith(agent.session.id, { kind: 'key', key: 'Escape' }, signal)
    } finally {
      bridge.dispose()
    }
  })
})
