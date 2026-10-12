/** Test-only source launcher: explicit repository paths keep engine imports off built lib/. */
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { ProviderSyncEngine, type LocalNamespace, type SyncStatus } from '../../src/engine.ts'

const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sync'), id: z.number().int(), pauseApply: z.boolean(), pauseStart: z.boolean() }),
  z.strictObject({ kind: z.literal('edit'), id: z.number().int(), provider: z.string(), value: z.record(z.string(), z.unknown()).nullable() }),
  z.strictObject({ kind: z.literal('release') }),
  z.strictObject({ kind: z.literal('finish') }),
])
export type WriterCommand = z.infer<typeof commandSchema>
export type WriterMessage =
  | { kind: 'ready'; pid: number }
  | { kind: 'prelock'; id: number }
  | { kind: 'locked'; id: number }
  | { kind: 'apply-barrier'; id: number }
  | { kind: 'sync-barrier'; id: number }
  | { kind: 'edited'; id: number }
  | { kind: 'committed'; id: number; status: SyncStatus }
  | { kind: 'error'; message: string }

const [sharedPath, receiptPath, localPath] = process.argv.slice(2)
if (sharedPath === undefined || receiptPath === undefined || localPath === undefined || process.send === undefined) {
  throw new Error('sync-writer requires three file paths and an IPC channel')
}
const send = (message: WriterMessage): void => { process.send?.(message) }
const local: LocalNamespace = z.strictObject({ schema: z.unknown(), revision: z.number().int().nonnegative(),
  providers: z.record(z.string(), z.unknown()), inherited: z.record(z.string(), z.unknown()),
}).parse(JSON.parse(await readFile(localPath, 'utf8')))
const persist = async (): Promise<void> => { await writeFile(localPath, JSON.stringify(local), { mode: 0o600 }) }
let commandId = 0
let reads = 0
let pauseApply = false
let releaseApply: (() => void) | undefined
let releaseStart: (() => void) | undefined
const engine = new ProviderSyncEngine({ sharedPath, receiptPath,
  read: () => {
    reads++
    if (reads === 1 || reads === 2) send({ kind: reads === 1 ? 'prelock' : 'locked', id: commandId })
    return local
  },
  mutate: async (ops, revision) => {
    if (revision !== local.revision) throw new Error('Fixture local revision changed')
    if (pauseApply) {
      const released = new Promise<void>((resolve) => { releaseApply = resolve })
      send({ kind: 'apply-barrier', id: commandId })
      await released
      releaseApply = undefined
    }
    for (const op of ops) {
      const id = op.path[1]
      if (id === undefined) throw new Error('Fixture mutation has no provider identity')
      if (op.path.length === 2) {
        if (op.op === 'unset') Reflect.deleteProperty(local.providers, id)
        else local.providers[id] = structuredClone(op.value)
      } else {
        const field = op.path[2]
        if (field === undefined) throw new Error('Fixture mutation has no provider field')
        const profile = local.providers[id] as Record<string, unknown>
        if (op.op === 'unset') Reflect.deleteProperty(profile, field)
        else profile[field] = structuredClone(op.value)
      }
    }
    local.revision++
    await persist()
  },
})

let queue = Promise.resolve()
process.on('message', (raw: unknown) => {
  const parsed = commandSchema.safeParse(raw)
  if (!parsed.success) {
    send({ kind: 'error', message: 'Invalid fixture command' })
    process.exitCode = 1
    process.disconnect()
    return
  }
  const command = parsed.data
  if (command.kind === 'release') { releaseStart?.(); releaseApply?.(); return }
  queue = queue.then(async () => {
    if (command.kind === 'finish') { process.disconnect(); return }
    commandId = command.id
    if (command.kind === 'edit') {
      if (command.value === null) Reflect.deleteProperty(local.providers, command.provider)
      else local.providers[command.provider] = command.value
      local.revision++
      await persist()
      send({ kind: 'edited', id: commandId })
      return
    }
    reads = 0
    pauseApply = command.pauseApply
    if (command.pauseStart) {
      const released = new Promise<void>((resolve) => { releaseStart = resolve })
      send({ kind: 'sync-barrier', id: commandId })
      await released
      releaseStart = undefined
    }
    const status = await engine.synchronize()
    send({ kind: 'committed', id: commandId, status })
  }).catch((error: unknown) => {
    send({ kind: 'error', message: error instanceof Error ? error.message : 'Fixture operation failed' })
    process.exitCode = 1
    process.disconnect()
  })
})
send({ kind: 'ready', pid: process.pid })
