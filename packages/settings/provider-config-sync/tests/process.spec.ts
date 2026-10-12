/** Independent source processes exercise shared-file locking, receipts, and restart persistence. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { afterEach, expect, it } from 'vitest'
import type { LocalNamespace } from '../src/engine.ts'
import type { WriterCommand, WriterMessage } from './fixtures/sync-writer.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const fixturePath = fileURLToPath(new URL('./fixtures/sync-writer.ts', import.meta.url))
const waitBudget = Math.max(30_000, Number(process.env['DSH_COVERAGE_TEST_TIMEOUT_MS']) || 0)
const messageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), pid: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('prelock'), id: z.number().int() }),
  z.strictObject({ kind: z.literal('locked'), id: z.number().int() }),
  z.strictObject({ kind: z.literal('apply-barrier'), id: z.number().int() }),
  z.strictObject({ kind: z.literal('sync-barrier'), id: z.number().int() }),
  z.strictObject({ kind: z.literal('edited'), id: z.number().int() }),
  z.strictObject({ kind: z.literal('committed'), id: z.number().int(), status: z.strictObject({
    state: z.enum(['ready', 'pending', 'conflict', 'unconfigured', 'error']), conflicts: z.array(z.string()),
  }) }),
  z.strictObject({ kind: z.literal('error'), message: z.string() }),
])
const ordinaryProfile = z.strictObject({ displayName: z.string().optional(),
  models: z.array(z.strictObject({ id: z.string(), name: z.string().optional() })).optional(),
})
const localSchema = z.object({ revision: z.number().int().nonnegative(),
  providers: z.record(z.string(), ordinaryProfile.loose()),
})
const recordsSchema = z.object({ version: z.literal(1), schemaFingerprint: z.string(),
  providers: z.record(z.string(), z.strictObject({ revision: z.number().int().nonnegative(), value: ordinaryProfile.nullable() })),
})
const roots: string[] = []
const writers: Writer[] = []

class Writer {
  private readonly messages: WriterMessage[] = []
  private readonly changed = new Set<() => void>()
  private readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private exited = false
  private failure: Error | undefined
  private stderr = ''
  private nextId = 0
  readonly localPath: string
  readonly receiptPath: string
  readonly child: ChildProcess

  constructor(home: string, name: string, sharedPath: string) {
    this.localPath = join(home, `${name}.local.json`)
    this.receiptPath = join(home, `${name}.receipt.json`)
    // No ambient credential variables or app homes enter a test child.
    this.child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fixturePath, sharedPath, this.receiptPath, this.localPath], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'],
        TMPDIR: home, TMP: home, TEMP: home, TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.base.json') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    writers.push(this)
    this.done = new Promise((resolve) => {
      this.child.once('error', (error) => { this.failure = error; this.wake() })
      this.child.once('close', (code, signal) => {
        this.exited = true
        resolve({ code, signal })
        this.wake()
      })
    })
    this.child.stderr?.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192) })
    this.child.on('message', (raw: unknown) => {
      const parsed = messageSchema.safeParse(raw)
      if (!parsed.success) this.failure = new Error('Invalid sync-writer response')
      else if (parsed.data.kind === 'error') this.failure = new Error(parsed.data.message)
      else this.messages.push(parsed.data)
      this.wake()
    })
  }

  private wake(): void { for (const callback of this.changed) callback() }

  async wait<K extends WriterMessage['kind']>(kind: K, id?: number): Promise<Extract<WriterMessage, { kind: K }>> {
    const take = (): WriterMessage | undefined => {
      const index = this.messages.findIndex(message => message.kind === kind && (id === undefined || 'id' in message && message.id === id))
      return index < 0 ? undefined : this.messages.splice(index, 1)[0]
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { settle(new Error(`Timed out waiting for sync-writer ${kind}`)) }, waitBudget)
      const settle = (error?: Error, message?: WriterMessage): void => {
        clearTimeout(timer)
        this.changed.delete(check)
        if (error !== undefined) reject(error)
        else resolve(message as Extract<WriterMessage, { kind: K }>)
      }
      const check = (): void => {
        const message = take()
        if (message !== undefined) { settle(undefined, message); return }
        if (this.failure !== undefined) settle(this.failure)
        else if (this.exited) settle(new Error(`Sync-writer exited before ${kind}: ${this.stderr}`))
      }
      this.changed.add(check)
      check()
    })
  }

  send(command: WriterCommand): void {
    this.child.send(command, (error) => {
      if (error !== null) { this.failure = error; this.wake() }
    })
  }

  beginSync({ pauseApply = false, pauseStart = false }: { pauseApply?: boolean; pauseStart?: boolean } = {}): number {
    const id = ++this.nextId
    this.send({ kind: 'sync', id, pauseApply, pauseStart })
    return id
  }

  async sync() { return this.wait('committed', this.beginSync()) }

  async edit(provider: string, value: Record<string, unknown> | null): Promise<void> {
    const id = ++this.nextId
    this.send({ kind: 'edit', id, provider, value })
    await this.wait('edited', id)
  }

  async finish(): Promise<void> {
    this.send({ kind: 'finish' })
    const exit = await this.exit()
    expect(exit).toEqual({ code: 0, signal: null })
    expect(this.stderr).toBe('')
  }

  async crash(): Promise<void> {
    expect(this.child.kill('SIGKILL')).toBe(true)
    expect(await this.exit()).toEqual({ code: null, signal: 'SIGKILL' })
  }

  private async exit() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([this.done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Timed out awaiting sync-writer exit')) }, waitBudget)
      })])
    } finally { clearTimeout(timer) }
  }

  async dispose(): Promise<void> {
    this.child.removeAllListeners('message')
    if (!this.exited) {
      this.failure ??= new Error('Sync-writer fixture disposed')
      this.wake()
      this.changed.clear()
      this.child.kill('SIGKILL')
    }
    await this.exit()
  }
}

afterEach(async () => {
  const stopped = await Promise.allSettled(writers.splice(0).map(writer => writer.dispose()))
  for (const result of stopped) if (result.status === 'rejected') throw result.reason
  await Promise.all(roots.splice(0).map(home => rm(home, { recursive: true, force: true })))
}, waitBudget)

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'provider-sync-process-'))
  roots.push(home)
  const sharedPath = join(home, 'providers.json')
  async function start(name: string, initial?: Record<string, unknown>) {
    if (initial !== undefined) {
      const local: LocalNamespace = { schema: { type: 'process-fixture', version: 1 }, revision: 0, providers: initial, inherited: {} }
      await writeFile(join(home, `${name}.local.json`), JSON.stringify(local), { mode: 0o600, flag: 'wx' })
    }
    const writer = new Writer(home, name, sharedPath)
    await writer.wait('ready')
    return writer
  }
  return { home, sharedPath, start }
}

const readLocal = async (path: string) => localSchema.parse(JSON.parse(await readFile(path, 'utf8')))
const readRecords = async (path: string) => recordsSchema.parse(JSON.parse(await readFile(path, 'utf8')))

it('merges different-provider edits from overlapping independent processes and converges both local files', async () => {
  const { sharedPath, start } = await fixture()
  const seed = await start('seed', { anchor: { displayName: 'Anchor' } })
  await seed.sync(); await seed.finish()
  const [main, test] = await Promise.all([
    start('main', { first: { models: [{ id: 'same', name: 'Same' }] } }),
    start('test', { second: { models: [{ id: 'same', name: 'Same' }] } }),
  ])
  const mainPass = main.beginSync({ pauseApply: true })
  await main.wait('apply-barrier', mainPass)
  expect(await readFile(`${sharedPath}.lock`, 'utf8')).toBe(`${String(main.child.pid)}\n`)
  const testPass = test.beginSync()
  await test.wait('prelock', testPass)
  expect(await readFile(`${sharedPath}.lock`, 'utf8')).toBe(`${String(main.child.pid)}\n`)
  main.send({ kind: 'release' })
  expect((await main.wait('committed', mainPass)).status).toEqual({ state: 'ready', conflicts: [] })
  expect((await test.wait('committed', testPass)).status).toEqual({ state: 'ready', conflicts: [] })
  await main.sync(); await test.sync()
  await Promise.all([main.finish(), test.finish()])
  for (const writer of [main, test]) {
    const local = await readLocal(writer.localPath)
    expect(Object.keys(local.providers).sort()).toEqual(['anchor', 'first', 'second'])
    expect(local.providers.first?.models).toEqual([{ id: 'same', name: 'Same' }])
    expect(local.providers.second?.models).toEqual([{ id: 'same', name: 'Same' }])
    expect(Object.keys((await readRecords(writer.receiptPath)).providers).sort()).toEqual(['anchor', 'first', 'second'])
  }
  const shared = await readRecords(sharedPath)
  expect(Object.keys(shared.providers).sort()).toEqual(['anchor', 'first', 'second'])
  expect(await readFile(sharedPath, 'utf8')).not.toMatch(/apiKeyEnv|headers|Authorization|token|credential/)
  expect(main.localPath).not.toBe(test.localPath)
  expect(main.receiptPath).not.toBe(test.receiptPath)
}, waitBudget)

it('retains the local loser when concurrent same-baseline update and deletion race without resurrecting it', async () => {
  const { sharedPath, start } = await fixture()
  const initial = { example: { displayName: 'Initial' } }
  const [updater, remover] = await Promise.all([start('updater', initial), start('remover', initial)])
  await updater.sync(); await remover.sync()
  const updated = { displayName: 'Updated' }
  await Promise.all([updater.edit('example', updated), remover.edit('example', null)])
  const updatePass = updater.beginSync({ pauseStart: true })
  const deletePass = remover.beginSync({ pauseStart: true })
  await Promise.all([updater.wait('sync-barrier', updatePass), remover.wait('sync-barrier', deletePass)])
  expect((await readRecords(updater.receiptPath)).providers.example?.value).toEqual(initial.example)
  expect((await readRecords(remover.receiptPath)).providers.example?.value).toEqual(initial.example)
  updater.send({ kind: 'release' }); remover.send({ kind: 'release' })
  const [updateResult, deleteResult] = await Promise.all([
    updater.wait('committed', updatePass), remover.wait('committed', deletePass),
  ])
  expect([updateResult.status.state, deleteResult.status.state].sort()).toEqual(['conflict', 'ready'])
  const updateWon = updateResult.status.state === 'ready'
  const loser = updateWon ? remover : updater
  const loserName = updateWon ? 'remover' : 'updater'
  const winnerValue = updateWon ? updated : null
  expect((updateWon ? deleteResult : updateResult).status.conflicts).toEqual(['example'])
  expect((await readRecords(sharedPath)).providers.example).toEqual({ revision: 2, value: winnerValue })
  expect((await readLocal(updater.localPath)).providers).toEqual({ example: updated })
  expect((await readLocal(remover.localPath)).providers).toEqual({})
  expect((await readRecords(loser.receiptPath)).providers.example?.value).toEqual(initial.example)
  const committedShared = await readFile(sharedPath, 'utf8')
  expect((await loser.sync()).status).toEqual({ state: 'conflict', conflicts: ['example'] })
  expect(await readFile(sharedPath, 'utf8')).toBe(committedShared)
  await Promise.all([updater.finish(), remover.finish()])
  const restarted = await start(loserName)
  expect((await restarted.sync()).status).toEqual({ state: 'conflict', conflicts: ['example'] })
  expect((await readLocal(restarted.localPath)).providers).toEqual(updateWon ? {} : { example: updated })
  expect(await readFile(sharedPath, 'utf8')).toBe(committedShared)
  await restarted.finish()
}, waitBudget)

it('recovers a killed importer after shared publication and takes over its exited PID lock before local apply', async () => {
  const { sharedPath, start } = await fixture()
  const anchor = { displayName: 'Anchor' }
  const fresh = { displayName: 'Fresh' }
  const seed = await start('seed', { anchor })
  await seed.sync(); await seed.finish()
  const importer = await start('importer', { fresh })
  const interruptedPass = importer.beginSync({ pauseApply: true })
  await importer.wait('apply-barrier', interruptedPass)
  const published = await readRecords(sharedPath)
  expect(published.providers.anchor?.value).toEqual(anchor)
  expect(published.providers.fresh?.value).toEqual(fresh)
  expect((await readLocal(importer.localPath)).providers).toEqual({ fresh })
  await expect(readFile(importer.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const abandonedLock = `${String(importer.child.pid)}\n`
  expect(await readFile(`${sharedPath}.lock`, 'utf8')).toBe(abandonedLock)
  await importer.crash()
  expect(await readFile(`${sharedPath}.lock`, 'utf8')).toBe(abandonedLock)
  const committedShared = await readFile(sharedPath, 'utf8')
  const restarted = await start('importer')
  expect(restarted.child.pid).not.toBe(importer.child.pid)
  const recoveryPass = restarted.beginSync({ pauseApply: true })
  await restarted.wait('apply-barrier', recoveryPass)
  expect(await readFile(`${sharedPath}.lock`, 'utf8')).toBe(`${String(restarted.child.pid)}\n`)
  expect((await readLocal(restarted.localPath)).providers).toEqual({ fresh })
  await expect(readFile(restarted.receiptPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  restarted.send({ kind: 'release' })
  expect((await restarted.wait('committed', recoveryPass)).status).toEqual({ state: 'ready', conflicts: [] })
  const recoveredLocal = await readLocal(restarted.localPath)
  expect(Object.keys(recoveredLocal.providers).sort()).toEqual(['anchor', 'fresh'])
  expect(recoveredLocal.providers.anchor).toMatchObject(anchor)
  expect(recoveredLocal.providers.fresh).toEqual(fresh)
  const recoveredReceipt = await readRecords(restarted.receiptPath)
  expect(recoveredReceipt.providers).toEqual(published.providers)
  expect(await readFile(sharedPath, 'utf8')).toBe(committedShared)
  await restarted.finish()
  await expect(readFile(`${sharedPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  const committedLocal = await readFile(restarted.localPath, 'utf8')
  const committedReceipt = await readFile(restarted.receiptPath, 'utf8')
  const again = await start('importer')
  expect((await again.sync()).status).toEqual({ state: 'ready', conflicts: [] })
  await again.finish()
  expect(await readFile(again.localPath, 'utf8')).toBe(committedLocal)
  expect(await readFile(again.receiptPath, 'utf8')).toBe(committedReceipt)
  expect(await readFile(sharedPath, 'utf8')).toBe(committedShared)
}, waitBudget)

it('retains divergent same-provider updates across process exits and resolves only matching local repair', async () => {
  const { sharedPath, start } = await fixture()
  const [main, test] = await Promise.all([
    start('main', { example: { displayName: 'Initial' } }), start('test', { example: { displayName: 'Initial' } }),
  ])
  await main.sync(); await test.sync()
  await Promise.all([main.edit('example', { displayName: 'Main change' }), test.edit('example', { displayName: 'Test change' })])
  const results = await Promise.all([main.sync(), test.sync()])
  expect(results.map(result => result.status.state).sort()).toEqual(['conflict', 'ready'])
  const conflictIndex = results.findIndex(result => result.status.state === 'conflict')
  expect(results[conflictIndex]?.status.conflicts).toEqual(['example'])
  const loser = conflictIndex === 0 ? main : test
  const winnerName = conflictIndex === 0 ? 'Test change' : 'Main change'
  expect((await readRecords(sharedPath)).providers.example?.value?.displayName).toBe(winnerName)
  expect((await readLocal(main.localPath)).providers.example?.displayName).toBe('Main change')
  expect((await readLocal(test.localPath)).providers.example?.displayName).toBe('Test change')
  expect((await readRecords(loser.receiptPath)).providers.example?.value?.displayName).toBe('Initial')
  await Promise.all([main.finish(), test.finish()])
  const restarted = await start(conflictIndex === 0 ? 'main' : 'test')
  expect((await restarted.sync()).status).toEqual({ state: 'conflict', conflicts: ['example'] })
  await restarted.edit('example', { displayName: winnerName })
  expect((await restarted.sync()).status).toEqual({ state: 'ready', conflicts: [] })
  expect((await readRecords(restarted.receiptPath)).providers.example?.value?.displayName).toBe(winnerName)
  await restarted.finish()
}, waitBudget)

it('applies a durable deletion tombstone on restart without resurrecting a stale keyless profile', async () => {
  const { sharedPath, start } = await fixture()
  const ordinary = { example: { displayName: 'Initial', models: [{ id: 'fixture-model' }] } }
  const [main, test] = await Promise.all([start('main', ordinary), start('test', ordinary)])
  await main.sync(); await test.sync()
  await test.finish()
  await main.edit('example', null)
  expect((await main.sync()).status).toEqual({ state: 'ready', conflicts: [] })
  expect((await readRecords(sharedPath)).providers.example).toEqual({ revision: 2, value: null })
  await main.finish()
  const restarted = await start('test')
  expect((await readLocal(restarted.localPath)).providers).toEqual(ordinary)
  expect((await restarted.sync()).status).toEqual({ state: 'ready', conflicts: [] })
  expect((await readLocal(restarted.localPath)).providers).toEqual({})
  expect((await readRecords(restarted.receiptPath)).providers.example).toEqual({ revision: 2, value: null })
  await restarted.finish()
  const committedLocal = await readFile(restarted.localPath, 'utf8')
  const committedReceipt = await readFile(restarted.receiptPath, 'utf8')
  const again = await start('test')
  expect((await again.sync()).status).toEqual({ state: 'ready', conflicts: [] })
  await again.finish()
  expect(await readFile(again.localPath, 'utf8')).toBe(committedLocal)
  expect(await readFile(again.receiptPath, 'utf8')).toBe(committedReceipt)
  expect((await readRecords(sharedPath)).providers.example).toEqual({ revision: 2, value: null })
}, waitBudget)
