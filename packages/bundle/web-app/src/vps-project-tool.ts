/** An owner Bot uses its shared project mount through the Computer file policies. */

import { resolve } from 'node:path/posix'
import type { WorkspaceFileAccess } from '@yharness/api-workspace-files'
import type { Context } from '@yharness/cordis'
import { FsVersion } from '@yharness/fs'
import type { ContentBlock } from '@yharness/llm'
import { defineTool, type ToolExecution } from '@yharness/tools'
import { isVpsSharedPath } from './vps-runtime.ts'

/**
 * Expose shared project files to one Bot while its owner grants access.
 * @param ctx - Scoped services used to register and execute the tool.
 * @param agent - Exact Agent that owns the selected Bot.
 * @param workspaceFiles - Existing Computer file reader and listing service.
 * @param access - Revalidate and select the shared filesystem for this Bot.
 * @returns An updater for the Bot's registration after its owner changes access.
 */
export function registerVpsProjectTool(
  ctx: Context,
  agent: NonNullable<ToolExecution['agent']>,
  workspaceFiles: Pick<Context['workspaceFiles'], 'list' | 'read'>,
  access: (signal: AbortSignal) => Promise<WorkspaceFileAccess | undefined>,
): (granted: boolean) => Promise<void> {
  const definition = defineTool({
    name: 'vps_project_files',
    description: 'List, read, or save text in /workspace, the shared project folder for participating VPS Bots. '
      + 'Read returns a version. Use that exact version to update an existing file. A write without a version creates a new file only.',
    parameters: {
      action: { type: 'string', enum: ['list', 'read', 'write'], required: true, description: 'Project operation.' },
      path: { type: 'string', description: 'Path relative to /workspace or an absolute path within it. List defaults to the project root.' },
      offset: { type: 'integer', description: 'First line to read, starting at 1.' },
      content: { type: 'string', description: 'Complete new UTF-8 text for write.' },
      version: { type: 'string', description: 'Exact version returned by read when replacing a file.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, result: string): ContentBlock[] => [{ type: 'text', text: result }],
    },
    presentCall: args => ({ card: 'generic', title: args.action === 'write' ? 'Save project file' : 'Read shared project' }),
    async execute(args, exec) {
      if (exec.agent !== agent) throw new Error('Shared project access requires the participating Bot.')
      const project = await access(exec.signal)
      if (project === undefined) throw new Error('This Bot does not have shared project access.')
      if (args.path === undefined && args.action !== 'list') throw new Error('Choose a project file path.')
      const path = resolve(project.workspaceRoot, args.path ?? '.')
      if (!isVpsSharedPath(path)) throw new Error('Choose a path inside the shared project.')
      const scope = { sessionId: agent.session.id, workspaceRoot: project.workspaceRoot }
      const address = { computer: path }
      switch (args.action) {
        case 'list':
          return JSON.stringify(await workspaceFiles.list(scope, address, exec.signal))
        case 'read': {
          const page = await workspaceFiles.read(scope, address, { offset: args.offset ?? 1, limit: 200 }, exec.signal)
          return JSON.stringify({ text: page.text, version: page.version, ...(page.eof ? {} : { nextOffset: page.offset + page.lines }) })
        }
        case 'write': {
          if (args.content === undefined) throw new Error('Supply the complete text to save.')
          const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
          if (policy === undefined || policy.mode === 'read-only') throw new Error('This Bot Session is read-only.')
          const target = await project.fs.resolve(path, { signal: exec.signal })
          const intent = args.version === undefined
            ? { kind: 'createIfAbsent' as const }
            : { kind: 'replaceIfVersion' as const, version: FsVersion(args.version) }
          const saved = await project.fs.writeText(target, args.content, intent, exec.signal, policy)
          return JSON.stringify({ path, version: saved.version })
        }
      }
    },
  })
  let dispose: (() => Promise<void>) | undefined
  return async (granted) => {
    if (granted) {
      dispose ??= ctx.effect(() => ctx.tools.register(definition), 'vps-bots: shared project files')
    } else {
      const registered = dispose
      dispose = undefined
      await registered?.()
    }
  }
}
