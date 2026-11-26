/** Propose reversible changes to the active Y Harness interface. */
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/cordis-host-runner'
import { defineTool } from '@yharness/tools'

/** Stable preset entry name. */
export const name = 'tool-live-edit-ui'
/** Services required to propose a change. */
export const inject = ['tools', 'dynamicCordisRunner']

/**
 * Register the Live Edit proposal tool in an interactive agent preset.
 * @param ctx - preset context carrying the tools and UI preview service.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'live_edit_ui',
    description: 'Preview reversible changes to the open Y Harness interface without restarting. Use only when the user explicitly asks to change the app UI. Inspect before previewing to see the current patch and supported targets. A preview replaces the previous patch, so include earlier edits the user wants to keep. The window offers Keep and Undo, which only the user can select.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'preview'], description: 'Inspect the current patch or preview a complete new one.' },
      patch: { type: 'json', description: 'For preview, provide {title, operations}. Operations: {kind:"hide",target}; {kind:"add",target,id,position:"before"|"after"|"start"|"end",title,text?}; {kind:"style",target,color?,background?,radius?,padding?,order?}. Colors are six-digit hex strings. Radius and padding are pixels. Targets are exact UI marker names, not CSS selectors. Added content is plain text.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('Live Edit requires a conversation')
      if (agent.id.startsWith('shared-session-') || agent.id.startsWith('bot-session-')
        || (agent.session.header.delegationDepth ?? 0) > 0) {
        throw new Error('Live Edit is available from a private main conversation')
      }
      const runner = ctx.dynamicCordisRunner
      exec.signal.throwIfAborted()
      if (args.action === 'inspect') {
        return JSON.stringify({
          state: runner.liveEditState(),
          targets: [
            'sidebar-brand', 'sidebar-modes', 'new-session', 'sidebar-workspaces',
            'sidebar-panel-plugins', 'sidebar-panel-skills', 'sidebar-panel-schedules',
            'conversation-breadcrumbs', 'assistant-prose', 'user-bubble', 'provider-model-label',
          ],
          hint: 'Target availability follows the visible view. Keep and Undo are in the window.',
        })
      }
      const preview = await runner.stageLiveEdit(args.patch)
      return JSON.stringify({ revision: preview.revision, message: 'Preview sent to the open window. Ask the user to review it with Keep or Undo.' })
    },
    presentCall: args => ({ card: 'generic', title: 'Live Edit', kind: args.action === 'inspect' ? 'read' : 'other', rawInput: args }),
  }))
}
