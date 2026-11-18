import { Context } from '@yharness/cordis'
import ToolRuntime, { type ToolRunContext } from '@yharness/tools'
import SystemPrompt from '@yharness/system-prompt'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  applyMacComputer,
  applyVpsBotComputer,
  sharedVpsBrowserTool,
} from '../src/computer-tool.ts'

const SESSION = 'bot-session-computer-tool'

interface FixtureControls {
  observe: ReturnType<typeof vi.fn>
  actAsBot: ReturnType<typeof vi.fn>
}

function controls(): FixtureControls {
  return {
    observe: vi.fn(async () => ({ jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), width: 1280, height: 800 })),
    actAsBot: vi.fn(async () => undefined),
  }
}

async function context() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const saveImage = vi.fn(async () => ({ attachmentId: 'fixture-attachment', mediaType: 'image/jpeg' as const, bytes: 4, width: 1280, height: 800 }))
  const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['image'] as const }))
  ctx.provide('attachments', { saveImage } as never)
  ctx.provide('llm', { resolveModelInfo } as never)
  return { ctx, saveImage, resolveModelInfo }
}

function agent() {
  return {
    id: SESSION,
    options: { provider: 'fixture-provider', model: 'fixture-model' },
    session: { id: SESSION, requestHeader: () => ({ config: { provider: 'fixture-provider', model: 'fixture-model' } }) },
  } as never as NonNullable<ToolRunContext['agent']>
}

function execution(agentValue: NonNullable<ToolRunContext['agent']> | undefined = agent()): ToolRunContext {
  return { agent: agentValue, signal: new AbortController().signal } as never
}

function executionWithoutAgent(): ToolRunContext {
  return { signal: new AbortController().signal } as never
}

describe('Computer tool definitions', () => {
  it('registers the legacy VPS and Mac tools through their public installers', async () => {
    const legacy = await context()
    const vps = controls()
    legacy.ctx.provide('vpsComputer', vps as never)
    apply(legacy.ctx)
    const vpsDefinition = legacy.ctx.tools.get('vps_computer')
    expect(vpsDefinition).toBeDefined()
    await expect(vpsDefinition?.execute({ action: 'move', x: 1, y: 2 }, execution())).resolves.toEqual({ message: 'Computer input sent.' })
    await expect(vpsDefinition?.execute({ action: 'observe' }, execution())).resolves.toMatchObject({ image: { width: 1280 } })
    expect(vps.actAsBot).toHaveBeenCalledWith({ kind: 'move', x: 1, y: 2 }, expect.any(AbortSignal))

    const mac = await context()
    const observe = vi.fn(async () => ({ jpeg: 'fixture', width: 640, height: 480 }))
    const request = vi.fn(async () => {})
    applyMacComputer(mac.ctx, { observe, request } as never)
    const macDefinition = mac.ctx.tools.get('mac_computer')
    expect(macDefinition?.presentCall?.({ action: 'observe' })).toEqual({ card: 'generic', title: 'Computer' })
    await expect(macDefinition?.execute({ action: 'observe' }, execution())).resolves.toMatchObject({ image: { width: 1280 } })
    await expect(macDefinition?.execute({ action: 'click', x: 3, y: 4, button: 1 }, execution())).resolves.toEqual({ message: 'Computer input sent.' })
    expect(observe).toHaveBeenCalledWith(SESSION, expect.any(AbortSignal))
    expect(request).toHaveBeenCalledWith(SESSION, { kind: 'click', x: 3, y: 4, button: 1 }, expect.any(AbortSignal))
    await legacy.ctx.fiber.dispose()
    await mac.ctx.fiber.dispose()
  })

  it('executes owner VPS input, navigation, sign-in, and saved-login outcomes', async () => {
    const { ctx } = await context()
    const primary = controls()
    const desktop = controls()
    const resolve = vi.fn(async () => primary)
    const desktopResolve = vi.fn(async () => desktop)
    const signIn = vi.fn(async () => 'completed' as const)
    const navigate = vi.fn(async () => {})
    const savedLogin = vi.fn(async () => ({ state: 'submitted' as const }))
    applyVpsBotComputer(ctx, resolve, signIn, navigate, savedLogin, desktopResolve)
    const definition = ctx.tools.get('vps_computer')
    if (definition === undefined) throw new Error('VPS Computer tool was not registered')
    expect(definition.parameters).toMatchObject({ properties: { surface: { enum: ['desktop'] } } })
    await expect(definition.execute({ action: 'move', x: 1, y: 2 }, execution())).resolves.toEqual({ message: 'Computer input sent.' })
    await expect(definition.execute({ action: 'click', surface: 'desktop', x: 1, y: 2, button: 1 }, execution())).resolves.toEqual({ message: 'Computer input sent.' })
    await expect(definition.execute({ action: 'observe', surface: 'desktop' }, execution())).resolves.toEqual({
      message: 'Desktop coordinates are 1280×800 pixels. This attachment is 1280×800 pixels. Scale coordinates if the sizes differ.',
      image: { attachmentId: 'fixture-attachment', mediaType: 'image/jpeg', bytes: 4, width: 1280, height: 800 },
    })
    expect(primary.actAsBot).toHaveBeenCalled()
    expect(desktop.actAsBot).toHaveBeenCalled()
    await expect(definition.execute({ action: 'navigate', url: 'https://example.test' }, execution())).resolves.toEqual({ message: 'Browser navigation sent.' })
    expect(navigate).toHaveBeenCalledWith(SESSION, 'https://example.test', expect.any(AbortSignal))
    for (const result of ['completed', 'cancelled', 'interrupted'] as const) {
      signIn.mockResolvedValueOnce(result)
      await expect(definition.execute({ action: 'request_sign_in' }, execution())).resolves.toEqual({ message: {
        completed: 'The owner returned the Computer. Observe the current page before continuing.',
        cancelled: 'The owner declined the sign-in request.',
        interrupted: 'The sign-in wait ended. Wait for the owner before continuing with the site.',
      }[result] })
    }
    for (const result of [
      { purpose: 'verification' as const, state: 'submitted' as const },
      { purpose: 'verification' as const, state: 'approval-required' as const },
      { purpose: 'verification' as const, state: 'needs-owner' as const },
      { purpose: 'verification' as const, state: 'unavailable' as const },
      { purpose: 'signup' as const, state: 'submitted' as const },
      { purpose: 'signup' as const, state: 'approval-required' as const },
      { purpose: 'signup' as const, state: 'needs-owner' as const },
      { purpose: 'signup' as const, state: 'unavailable' as const },
      { state: 'submitted' as const },
      { state: 'approval-required' as const },
      { state: 'needs-owner' as const },
      { state: 'unavailable' as const },
    ]) {
      savedLogin.mockResolvedValueOnce(result)
      await expect(definition.execute({ action: 'request_saved_login' }, execution())).resolves.toHaveProperty('message')
    }
    await expect(definition.execute({ action: 'request_sign_in', extra: true }, execution())).rejects.toThrow('no arguments')
    const bareOwner = await context()
    const barePrimary = controls()
    bareOwner.ctx.provide('vpsComputer', barePrimary as never)
    applyVpsBotComputer(bareOwner.ctx, async () => barePrimary)
    const bareDefinition = bareOwner.ctx.tools.get('vps_computer')
    if (bareDefinition === undefined) throw new Error('Bare owner Computer tool was not registered')
    expect(bareDefinition.description).toContain('private VPS desktop')
    await bareOwner.ctx.fiber.dispose()
    await expect(definition.execute({ action: 'navigate', url: 'https://example.test', extra: true }, execution())).rejects.toThrow('one HTTP(S) URL')
    await expect(definition.execute({ action: 'request_saved_login', extra: true }, execution())).rejects.toThrow('no arguments')
    await ctx.fiber.dispose()
  })

  it('guards shared-browser access and covers desktop/observe rendering branches', async () => {
    const { ctx, saveImage, resolveModelInfo } = await context()
    const browser = controls()
    const desktop = controls()
    const authorize = vi.fn(async () => false)
    const navigate = vi.fn(async () => {})
    const savedLogin = vi.fn(async () => ({ state: 'needs-owner' as const }))
    const signIn = vi.fn(async () => 'cancelled' as const)
    const definition = sharedVpsBrowserTool(ctx, browser, authorize, navigate, savedLogin, signIn)
    expect(definition.presentCall?.({ action: 'observe' })).toEqual({ card: 'generic', title: 'Browser' })
    await expect(definition.execute({ action: 'observe' }, execution())).rejects.toThrow('unavailable for this chat')
    authorize.mockResolvedValue(true)
    const noAgent = executionWithoutAgent()
    await expect(definition.execute({ action: 'observe' }, noAgent)).rejects.toThrow('unavailable for this chat')
    const allowed = execution()
    await expect(definition.execute({ action: 'navigate', url: 'https://example.test' }, allowed)).resolves.toEqual({ message: 'Browser navigation sent.' })
    await expect(definition.execute({ action: 'move', x: 1, y: 2 }, allowed)).resolves.toEqual({ message: 'Computer input sent.' })
    await expect(definition.execute({ action: 'request_sign_in' }, allowed)).resolves.toEqual({ message: 'The owner declined the sign-in request.' })
    await expect(definition.execute({ action: 'request_saved_login' }, allowed)).resolves.toEqual({ message: 'The website needs a manual sign-in or verification step. Use request_sign_in to ask the owner to take over.' })
    await expect(definition.execute({ action: 'request_sign_in', extra: true }, allowed)).rejects.toThrow('Browser sign-in takes no arguments.')
    await expect(definition.execute({ action: 'request_saved_login', extra: true }, allowed)).rejects.toThrow('Secure website sign-in takes no arguments.')
    const noSignIn = sharedVpsBrowserTool(ctx, browser, async () => true, navigate,
      vi.fn(async () => ({ purpose: 'verification' as const, state: 'needs-owner' as const })), undefined)
    await expect(noSignIn.execute({ action: 'request_saved_login' }, allowed)).resolves.toEqual({ message: 'The website needs manual verification.' })
    const noSignInSignup = sharedVpsBrowserTool(ctx, browser, async () => true, navigate,
      vi.fn(async () => ({ purpose: 'signup' as const, state: 'needs-owner' as const })), undefined)
    await expect(noSignInSignup.execute({ action: 'request_saved_login' }, allowed)).resolves.toEqual({ message: 'The website needs a manual signup or verification step.' })
    authorize.mockResolvedValue(false)
    const desktopTool = sharedVpsBrowserTool(ctx, desktop, async () => true, navigate,
      vi.fn(async () => ({ state: 'submitted' as const })), vi.fn(async () => 'completed' as const))
    await expect(desktopTool.execute({ action: 'observe', surface: 'desktop' }, allowed)).rejects.toThrow('desktop selection')
    const modelInfo = resolveModelInfo.mockResolvedValue({ inputModalities: [] })
    void modelInfo
    await ctx.fiber.dispose()
    void desktop
    void saveImage
  })

  it('covers desktop provider observation, attachment rendering, and model capability checks', async () => {
    const { ctx, saveImage, resolveModelInfo } = await context()
    const primary = controls()
    const desktop = controls()
    const definition = sharedVpsBrowserTool(ctx, primary, async () => true, vi.fn(), undefined, undefined)
    const withDesktop = sharedVpsBrowserTool(ctx, desktop, async () => true, vi.fn(), undefined, undefined)
    await expect(withDesktop.execute({ action: 'observe' }, execution())).resolves.toEqual({
      message: 'Browser coordinates are 1280×800 pixels. This attachment is 1280×800 pixels. Scale coordinates if the sizes differ.',
      image: { attachmentId: 'fixture-attachment', mediaType: 'image/jpeg', bytes: 4, width: 1280, height: 800 },
    })
    const route = execution()
    await expect(definition.execute({ action: 'observe' }, route)).resolves.toMatchObject({ image: { attachmentId: 'fixture-attachment' } })
    expect(saveImage).toHaveBeenCalled()
    resolveModelInfo.mockResolvedValueOnce({ inputModalities: [] })
    await expect(definition.execute({ action: 'observe' }, execution())).rejects.toThrow('accepts images')
    resolveModelInfo.mockRejectedValueOnce(new Error('route unavailable'))
    await expect(definition.execute({ action: 'observe' }, execution())).rejects.toThrow('route unavailable')
    expect(definition.output.render?.({}, { message: 'fixture' })).toEqual([{ type: 'text', text: 'fixture' }])
    expect(definition.output.render?.({}, { message: 'fixture', image: {
      attachmentId: 'fixture-attachment', bytes: 4, width: 1280, height: 800, mediaType: 'image/jpeg',
    } })).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('rejects unsupported surface and missing model route before provider access', async () => {
    const { ctx } = await context()
    const primary = controls()
    const desktop = controls()
    const definition = sharedVpsBrowserTool(ctx, primary, async () => true, vi.fn(), undefined, undefined)
    await expect(definition.execute({ action: 'move', surface: 'desktop', x: 1, y: 2 }, execution())).rejects.toThrow('desktop selection')
    const desktopTool = sharedVpsBrowserTool(ctx, desktop, async () => true, vi.fn(),
      vi.fn(async () => ({ state: 'submitted' as const })), vi.fn(async () => 'completed' as const))
    await expect(desktopTool.execute({ action: 'navigate', surface: 'desktop', url: 'https://example.test' }, execution())).rejects.toThrow('desktop selection')
    await expect(desktopTool.execute({ action: 'request_sign_in', surface: 'desktop' }, execution())).rejects.toThrow('desktop selection')
    await expect(desktopTool.execute({ action: 'request_saved_login', surface: 'desktop' }, execution())).rejects.toThrow('desktop selection')
    const bare = await context()
    const bareControls = controls()
    bare.ctx.provide('vpsComputer', bareControls as never)
    apply(bare.ctx)
    const bareDefinition = bare.ctx.tools.get('vps_computer')
    if (bareDefinition === undefined) throw new Error('Bare VPS Computer tool was not registered')
    await expect(bareDefinition.execute({ action: 'move', x: 1, y: 2 }, executionWithoutAgent())).resolves.toEqual({ message: 'Computer input sent.' })
    const fallback = {
      id: SESSION, options: { provider: 'fallback-provider', model: 'fallback-model' },
      session: { id: SESSION, requestHeader: () => ({ config: { model: 'active-model' } }) },
    } as never as NonNullable<ToolRunContext['agent']>
    await expect(bareDefinition.execute({ action: 'observe' }, execution(fallback))).resolves.toMatchObject({ image: { width: 1280 } })
    const missing = {
      id: SESSION, options: { provider: undefined, model: undefined },
      session: { id: SESSION, requestHeader: () => undefined },
    } as never as NonNullable<ToolRunContext['agent']>
    await expect(bareDefinition.execute({ action: 'observe' }, execution(missing))).rejects.toThrow('could not be resolved')
    await ctx.fiber.dispose()
    await bare.ctx.fiber.dispose()
  })
})
