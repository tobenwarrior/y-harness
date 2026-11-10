/** Operator preset tool for the same VPS desktop shown in the Computer panel. */

import type { Context } from '@yharness/cordis'
import { AttachmentId } from '@yharness/attachment'
import type { ContentBlock } from '@yharness/llm'
import type { MacComputerBridge } from './mac-computer.ts'
import { defineTool } from '@yharness/tools'

/** Stable Cordis plugin name. */
export const name = 'vps-computer-tool'

/** The opt-in Computer service and ordinary tool and attachment providers. */
export const inject = ['vpsComputer', 'tools', 'attachments', 'llm']

interface ComputerAgentControls {
  observe(signal: AbortSignal): Promise<{ readonly jpeg: string; readonly width: number; readonly height: number }>
  actAsBot(action: unknown, signal: AbortSignal): Promise<unknown>
}

declare module '@yharness/cordis' {
  interface Context {
    /** The operator's private VPS desktop controller. */
    vpsComputer: ComputerAgentControls
  }
}

const ATTACHMENT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    mediaType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], required: true },
  },
} as const

/**
 * Add the Computer tool to an operator preset that opted into the VPS display.
 * @param ctx - Preset context carrying the private desktop, tool registry, and attachment store.
 */
export function apply(ctx: Context): void {
  const computer = ctx.vpsComputer
  registerComputerTool(ctx, {
    name: 'vps_computer',
    description: 'Observe or operate the private VPS desktop shown in the Computer panel. '
      + 'Observe before targeting visible controls. Input is paused while the user is in control.',
    keyDescription: 'X11 key or chord, for example Return or ctrl+a.',
    observe: (_sessionId, signal) => computer.observe(signal),
    act: (_sessionId, action, signal) => computer.actAsBot(action, signal),
  })
}

/**
 * Expose the Mac Computer to a local operator Agent.
 * @param ctx - Agent preset scope with tools and attachments.
 * @param computer - the Desktop Host bridge for the current application.
 */
export function applyMacComputer(ctx: Context, computer: MacComputerBridge): void {
  registerComputerTool(ctx, {
    name: 'mac_computer',
    description: 'Observe or operate the primary Mac display shared in this Bot’s Computer panel. '
      + 'Use this tool when the user mentions @Computer. The user must choose Share this Mac. Observe before sending input and verify its effect with a fresh observation. '
      + 'Use screenshot coordinates scaled to the reported display dimensions.',
    keyDescription: 'Mac key or chord, for example Return or cmd+a.',
    observe: (sessionId, signal) => computer.observe(sessionId, signal),
    act: async (sessionId, action, signal) => { await computer.request(sessionId, action, signal) },
  })
}

interface ComputerToolTarget {
  readonly name: 'vps_computer' | 'mac_computer'
  readonly description: string
  readonly keyDescription: string
  observe(sessionId: string, signal: AbortSignal): ReturnType<ComputerAgentControls['observe']>
  act(sessionId: string, action: object, signal: AbortSignal): Promise<unknown>
}

function registerComputerTool(ctx: Context, target: ComputerToolTarget): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: target.name,
    description: target.description,
    parameters: {
      action: {
        type: 'string',
        enum: ['observe', 'move', 'click', 'drag', 'scroll', 'key', 'text'],
        required: true,
        description: 'Observe the screen or send one pointer, keyboard, or text action.',
      },
      x: { type: 'integer', description: 'Horizontal pixel for move, click, drag, or scroll.' },
      y: { type: 'integer', description: 'Vertical pixel for move, click, drag, or scroll.' },
      toX: { type: 'integer', description: 'Destination horizontal pixel for drag.' },
      toY: { type: 'integer', description: 'Destination vertical pixel for drag.' },
      button: { type: 'integer', enum: [1, 2, 3], description: 'Pointer button for click. 1 is primary.' },
      delta: { type: 'integer', description: 'Scroll steps. Positive is down, negative is up.' },
      key: { type: 'string', description: target.keyDescription },
      text: { type: 'string', description: 'Literal text to type into the focused application.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          image: ATTACHMENT,
        },
      },
      render: (_args, value) => {
        const content: ContentBlock[] = [{ type: 'text', text: value.message }]
        if (value.image !== undefined) {
          content.push({
            type: 'image',
            attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) },
          })
        }
        return content
      },
    },
    presentCall: () => ({ card: 'generic', title: 'Computer' }),
    async execute(args, exec) {
      const { action, ...values } = args
      const sessionId = exec.agent?.session.id ?? ''
      if (action !== 'observe') {
        await target.act(sessionId, { kind: action, ...values }, exec.signal)
        return { message: 'Computer input sent.' }
      }
      const activeRoute = exec.agent?.session.requestHeader()?.config
      const provider = activeRoute?.provider ?? exec.agent?.options.provider
      const model = activeRoute?.model ?? exec.agent?.options.model
      if (provider === undefined || model === undefined) throw new Error('The current model route could not be resolved.')
      const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
      if (info.inputModalities?.includes('image') !== true) throw new Error('Select a model that accepts images to observe the desktop.')
      const frame = await target.observe(sessionId, exec.signal)
      const image = await ctx.attachments.saveImage({ data: Buffer.from(frame.jpeg, 'base64'), mediaType: 'image/jpeg', name: 'Computer.jpg' })
      return {
        message: `Desktop coordinates are ${String(frame.width)}×${String(frame.height)} pixels. `
          + `This attachment is ${String(image.width)}×${String(image.height)} pixels. Scale coordinates if the sizes differ.`,
        image: {
          attachmentId: image.attachmentId, mediaType: image.mediaType, bytes: image.bytes, width: image.width, height: image.height,
        },
      }
    },
  })), 'computer: operator tool')
}
