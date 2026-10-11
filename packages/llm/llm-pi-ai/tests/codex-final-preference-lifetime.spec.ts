/** A held display-file read cannot publish a runtime after its plugin owner closes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Llm from '@deepseek-ai/dsh-llm'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CodexBackendConnection } from '../src/codex-backend-connection.ts'

const reads = vi.hoisted(() => ({ path: '', enter: () => {}, release: Promise.resolve() }))
vi.mock('node:fs/promises', async (original) => {
  const fileSystem = await original<typeof import('node:fs/promises')>()
  return { ...fileSystem, readFile: async (...args: Parameters<typeof fileSystem.readFile>) => {
    if (args[0] === reads.path) { reads.enter(); await reads.release }
    return fileSystem.readFile(...args)
  } }
})

it('refuses delayed preference initialization after plugin disposal without registering a route', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-final-preference-'))
  const ctx = new Context()
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  onTestFinished(async () => { release.resolve(undefined); reads.path = ''; await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  reads.path = join(home, 'harness-backend.json'); reads.enter = () => { entered.resolve(undefined) }; reads.release = release.promise
  await writeFile(reads.path, JSON.stringify({ enabled: true, tiers: {}, models: [] }))
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_CODEX_HOME: home, DSH_CODEX_BINARY: join(home, 'never-executed.js'), DSH_CODEX_CWD: home,
    DSH_CODEX_SHELL_HOME: join(home, 'shell'), DSH_CODEX_NODE: process.execPath,
  } }]))
  await ctx.plugin(Llm)
  const owner = await ctx.plugin(CodexBackendConnection)
  const connection = ctx.codexBackendConnection
  const state = connection.getState()
  const refused = expect(state).rejects.toThrow('Codex backend is closed')
  await entered.promise
  await owner.dispose()
  release.resolve(undefined)
  await refused
  expect(ctx.llm.listProviders()).toEqual([])
})
