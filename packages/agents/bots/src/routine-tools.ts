/** Bot-scoped routine tools backed by the Host Schedule service. */

import type { Context } from '@yharness/cordis'
import { scopeOf } from '@yharness/scope'
import { defineTool } from '@yharness/tools'
import type { PreToolDecision, ToolExecution } from '@yharness/tools'
import type { JsonValue } from '@yharness/util-values'

const ROUTINE_MUTATIONS = new Set([
  'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_pause', 'schedule_resume',
  'schedule_event_create', 'schedule_event_update', 'schedule_event_delete', 'schedule_event_pause', 'schedule_event_resume',
])

/** Bot-native adapter used by the model-visible event routine tools. */
export interface BotEventRoutineToolHost {
  /** Run one event-routine action against the current Bot Session. */
  readonly run: (
    action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume' | 'history',
    args: Record<string, unknown>,
    exec: ToolExecution,
  ) => Promise<JsonValue>
}

const EVENT_OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function eventParameters(action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume' | 'history') {
  if (action === 'create') return {
    title: { type: 'string', required: true }, prompt: { type: 'string', required: true },
    event: {
      type: 'object', required: true, additionalProperties: false,
      properties: { type: { type: 'string', required: true, const: 'message' }, source: { type: 'string', required: true, enum: ['bot', 'user'] } },
    },
  } as const
  if (action === 'list') return {} as const
  if (action === 'update') return {
    id: { type: 'string', required: true }, title: { type: 'string' }, prompt: { type: 'string' },
    event: {
      type: 'object', additionalProperties: false,
      properties: { type: { type: 'string', required: true, const: 'message' }, source: { type: 'string', required: true, enum: ['bot', 'user'] } },
    },
  } as const
  if (action === 'history') return { id: { type: 'string', required: true }, limit: { type: 'integer' } } as const
  return { id: { type: 'string', required: true } } as const
}

function eventDescription(action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume' | 'history'): string {
  if (action === 'create') return 'Create a Bot routine triggered by a message from a peer Bot or the user. This action requires approval.'
  if (action === 'list') return 'List event-triggered routines owned by this Bot.'
  if (action === 'update') return 'Edit an event-triggered routine owned by this Bot. This action requires approval.'
  if (action === 'delete') return 'Delete an event-triggered routine owned by this Bot. This action requires approval.'
  if (action === 'pause') return 'Pause an event-triggered routine owned by this Bot. This action requires approval.'
  if (action === 'resume') return 'Resume an event-triggered routine owned by this Bot. This action requires approval.'
  return 'Read retained deliveries and completed model results for an event-triggered routine owned by this Bot.'
}

/**
 * Add durable routine management to one Bot Agent scope.
 *
 * The Schedule tools already bind every operation to `exec.agent.session.id`.
 * This helper only adds the Bot-specific approval policy; the selected Agent
 * preset owns the tool registration. That keeps `minimal` capability-poor and
 * avoids shadowing the shipped `standard` Schedule registration.
 *
 * @param scope - Agent scope owned by one Bot.
 * @param eventHost - Optional Bot service adapter for message-triggered routine tools.
 * @returns The scope injection fiber, which resolves after the policy is attached.
 */
export function installBotRoutineTools(
  scope: Context,
  eventHost?: BotEventRoutineToolHost,
): ReturnType<Context['inject']> {
  return scope.inject(['tools'], (scheduleScope: Context) => {
    const key = scopeOf(scheduleScope)
    if (key === undefined || scheduleScope.tools.get('schedule_create', key) === undefined) return
    const disposers: Array<() => unknown> = []
    if (eventHost !== undefined) {
      for (const action of ['create', 'list', 'update', 'delete', 'pause', 'resume', 'history'] as const) {
        disposers.push(scheduleScope.tools.register(defineTool({
          name: `schedule_event_${action}`,
          description: eventDescription(action),
          parameters: eventParameters(action),
          output: EVENT_OUTPUT,
          async execute(args, exec) {
            return eventHost.run(action, args as Record<string, unknown>, exec)
          },
        })))
      }
    }
    disposers.push(scheduleScope.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => ROUTINE_MUTATIONS.has(exec.name)
      ? Promise.resolve({ kind: 'ask', reason: 'This action changes the Bot routine schedule.' as const })
      : next()))
    return () => {
      for (const dispose of disposers.reverse()) void dispose()
    }
  })
}
