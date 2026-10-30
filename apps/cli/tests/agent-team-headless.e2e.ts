import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@yharness/loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const fixturePlugin = pathToFileURL(fileURLToPath(
  new URL('./profiles/headless/tests/fixtures/team-llm.mjs', import.meta.url),
)).href

function records(content: string): Record<string, unknown>[] {
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('dsh run with Agent Teams enabled', () => {
  it('runs two teammates, durable peer mail, dependent tasks, waiting, and final aggregation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-agent-team-headless-'))
    try {
      const home = join(cwd, '.dsh')
      const sessions = join(home, 'sessions')
      const profileDir = join(home, 'profiles', 'headless')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-headless',
        private: true,
        dependencies: {
          '@yharness/experimental-agent-team-profile': 'workspace:^',
        },
        dsh: {
          profile: {
            bundles: [
              '@yharness/base',
              '@yharness/headless',
              '@yharness/experimental-agent-team-profile',
            ],
          },
        },
      }, undefined, 2) + '\n')
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: '${sessions}'`,
        '    compression: none',
        '- insert:',
        '    - id: team-fixture-llm',
        `      name: '${fixturePlugin}'`,
        '',
      ].join('\n'))
      const launch = resolveExampleLaunch({
        srcBin: dshBinScript,
        configArgs: ['--profile', 'headless', '\u{8BF7}\u{5148}\u{8FD0}\u{884C} workflow \u{68C0}\u{67E5}，\u{518D}\u{4F7F}\u{7528} Agent Teams \u{628A}\u{8C03}\u{7814}\u{548C}\u{5B9E}\u{73B0}\u{62C6}\u{7ED9}\u{4E24}\u{4E2A} teammate，\u{7B49}\u{5F85}\u{5B8C}\u{6210}\u{540E}\u{6C47}\u{603B}。'],
        tsconfigPath,
        env: {
          DSH_HOME: home,
          DSH_AGENTS_HOME: join(cwd, '.agents'),
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: '',
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            '--disable-warning=ExperimentalWarning',
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
          ].filter(Boolean).join(' '),
        },
      })
      const result = await execa(launch.command, launch.args, {
        cwd,
        env: launch.env,
        input: '',
        timeout: 90_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      expect(
        result.exitCode,
        `dsh headless profile exited unexpectedly.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('TEAM_WORKFLOW_OK')

      const files = (await readdir(sessions, { recursive: true }))
        .filter(file => file.endsWith('.jsonl'))
      expect(files).toHaveLength(4)
      const logs = await Promise.all(files.map(file => readFile(join(sessions, file), 'utf8')))
      const parsed = logs.map(records)
      const workflowChild = parsed.find(log => log.some(record => record.type === 'subagent/descriptor'
        && (record.data as { mode: string }).mode === 'one-shot'))
      expect(workflowChild).toBeDefined()
      expect(workflowChild!.find(record => record.type === 'subagent/descriptor')?.data)
        .toMatchObject({ mode: 'one-shot', provider: 'spawn' })
      expect(workflowChild!.filter(record => record.type === 'user/message'
        && (record.data as { source: { kind: string } }).source.kind === 'user').map(record => record.data))
        .toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'TEAM_WORKFLOW_CHILD' }] })])
      const root = parsed.find((log) => {
        const header = log[0]
        return header?.type === 'session' && typeof header.parentSession !== 'string'
      })
      expect(root).toBeDefined()
      const eventTypes = root!.map(record => record.type)
      expect(eventTypes.filter(type => type === 'team/member')).toHaveLength(4)
      expect(eventTypes).toContain('team/message/queued')
      expect(eventTypes).toContain('team/message/delivered')
      const taskEvents = root!.filter(record => record.type === 'team/task')
      expect(taskEvents.filter((record) => {
        const data = record.data as { task?: { status?: string } } | undefined
        return data?.task?.status === 'completed'
      })).toHaveLength(2)
      const toolNames = root!.filter(record => record.type === 'tool/call')
        .map(record => (record.data as { name?: string } | undefined)?.name)
      expect(toolNames).toContain('wait_agent')
      expect(toolNames).toContain('team_task_list')
      expect(toolNames).toContain('list_agents')
      expect(toolNames).toContain('workflow')
      expect(root!.find(record => record.type === 'tool-workflow/run-end')?.data)
        .toMatchObject({ stopReason: 'completed' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 105_000)
})
