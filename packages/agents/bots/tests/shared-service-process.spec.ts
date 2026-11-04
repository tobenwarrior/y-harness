import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import z from 'zod'

const workerResultSchema = z.object({
  ok: z.boolean(),
  value: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
}).strict()
type WorkerResult = z.infer<typeof workerResultSchema>

const worker = join(process.cwd(), 'packages/agents/bots/tests/shared-service-process-worker.ts')

async function runWorker(
  backend: 'json' | 'sqlite',
  storageRoot: string,
  credentialsPath: string,
  operation: string,
  input: Record<string, string> = {},
): Promise<WorkerResult> {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', worker, backend, storageRoot, credentialsPath, operation, JSON.stringify(input),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const [result] = await once(child, 'close') as [number]
  const line = stdout.split('\n').findLast(candidate => candidate.startsWith('WORKER_RESULT:'))
  if (line === undefined) throw new Error(`shared-service worker produced no result (exit ${String(result)}): ${stderr}`)
  return workerResultSchema.parse(JSON.parse(line.slice('WORKER_RESULT:'.length)))
}

describe('shared Bot authority across separate Hosts', () => {
  it.each(['json', 'sqlite'] as const)('serializes invite redemption through the %s backend', async (backend) => {
    const root = await mkdtemp(join(tmpdir(), `yh-shared-process-${backend}-`))
    const storageRoot = backend === 'json' ? join(root, 'storage') : join(root, 'shared.sqlite')
    const credentialsPath = join(root, 'credentials.yaml')
    try {
      const owner = await runWorker(backend, storageRoot, credentialsPath, 'owner')
      expect(owner.ok).toBe(true)
      const invite = await runWorker(backend, storageRoot, credentialsPath, 'invite')
      expect(invite.ok).toBe(true)
      const codeValue = invite.value?.code
      if (typeof codeValue !== 'string') throw new Error('cross-process invite did not return a code')
      const code = codeValue
      const [first, second] = await Promise.all([
        runWorker(backend, storageRoot, credentialsPath, 'redeem', { code }),
        runWorker(backend, storageRoot, credentialsPath, 'redeem', { code }),
      ])
      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
      expect([first.ok, second.ok].filter(value => !value)).toHaveLength(1)
      const members = await runWorker(backend, storageRoot, credentialsPath, 'members')
      expect(members).toMatchObject({ ok: true, value: { members: [{ role: 'owner' }, { role: 'collaborator' }] } })
      const orphan = await runWorker(backend, storageRoot, credentialsPath, 'orphan-invite')
      expect(orphan).toMatchObject({ ok: true, value: { orphaned: true } })
      const recovered = await runWorker(backend, storageRoot, credentialsPath, 'counts')
      expect(recovered).toMatchObject({
        ok: true,
        value: { invites: 0, memberships: 2, privateSessions: 0 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
