/** Owner action changes persist through the profile configuration editor. */
import { readFile } from 'node:fs/promises'
import { Context } from '@yharness/cordis'
import z from '@yharness/schemastery'
import { expect, it, onTestFinished, vi } from 'vitest'
import SettingsController from '../src/index.ts'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'

const signal = () => new AbortController().signal
const actionName = 'records.read:recent'

async function workspace() {
  let connected = true
  const fixture = await configurationFixture({
    schema: z.object({
      ordinary: z.string().required(),
      serverName: z.string(),
      token: z.string(),
      disabledTools: z.array(String).default([]),
    }),
    apply: (ctx, configuration) => {
      const config = configuration as { serverName?: string; disabledTools: string[] }
      const entryId = ctx.fiber.entry?.id
      if (config.serverName === undefined || entryId === undefined) return
      const serverName = config.serverName
      ctx.on('mcp/actions/catalog', (accept) => {
        accept({
          serverName,
          entryId,
          connected,
          actions: [
            { name: actionName, description: 'Read recent records', enabled: !config.disabledTools.includes(actionName) },
            { name: 'peer', enabled: !config.disabledTools.includes('peer') },
          ],
        })
      }, { global: true })
    },
  })
  const { ctx } = fixture
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  await ctx.configEditor.edit(entry, raw => ({ ...raw, serverName: 'records', disabledTools: ['peer'] }))
  await ctx.plugin(SettingsController)
  return {
    ...fixture,
    controller: ctx.settingsController,
    disconnect: () => { connected = false },
    setConnected: (next: boolean) => { connected = next },
  }
}

it('persists an exact action while retaining its peer and private configuration', async () => {
  const { controller, profile } = await workspace()
  const initial = controller.listMcpActions()
  expect(initial).toEqual([{ serverName: 'records', connected: true, editable: true, actions: [
    { name: actionName, description: 'Read recent records', enabled: true },
    { name: 'peer', enabled: false },
  ] }])
  const disabled = await controller.setMcpActionEnabled('records', actionName, false, signal())
  expect(disabled[0]?.actions.every(action => !action.enabled)).toBe(true)
  expect(JSON.stringify(disabled)).not.toContain('private')
  expect(JSON.stringify(disabled)).not.toContain('entryId')
  const edited = await readFile(profile.patchPath, 'utf8')
  expect(edited).toContain('records.read:recent')
  expect(edited).toContain('token: private')
  await controller.setMcpActionEnabled('records', actionName, false, signal())
  expect(await readFile(profile.patchPath, 'utf8')).toBe(edited)
  const enabled = await controller.setMcpActionEnabled('records', actionName, true, signal())
  expect(enabled).toEqual(initial)
})

it('leaves inherited settings intact after removing the last disabled name', async () => {
  const { controller, profile } = await workspace()
  const enabled = await controller.setMcpActionEnabled('records', 'peer', true, signal())
  expect(enabled[0]?.actions.every(action => action.enabled)).toBe(true)
  expect(await readFile(profile.patchPath, 'utf8')).not.toContain('disabledTools')
})

it('rejects unknown, disconnected, malformed, and cancelled action requests', async () => {
  const { controller, ctx, disconnect, profile } = await workspace()
  const before = await readFile(profile.patchPath, 'utf8')
  await expect(controller.setMcpActionEnabled('', actionName, false, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
  await expect(controller.setMcpActionEnabled('records', 'absent', false, signal())).rejects.toMatchObject({ code: 'settings/mcp-action-rejected' })
  await expect(controller.setMcpActionEnabled('records', actionName, false, AbortSignal.abort())).rejects.toMatchObject({ code: 'gateway/cancelled' })
  const write = vi.spyOn(ctx.configEditor, 'edit').mockRejectedValueOnce(new Error('token: sentinel-secret'))
  await expect(controller.setMcpActionEnabled('records', actionName, false, signal()))
    .rejects.toMatchObject({ message: 'Could not save the connector action change.' })
  write.mockRestore()
  disconnect()
  expect(controller.listMcpActions()[0]).toMatchObject({ connected: false, editable: false })
  await expect(controller.setMcpActionEnabled('records', actionName, false, signal())).rejects.toMatchObject({ code: 'settings/mcp-action-rejected' })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(before)
})

it('returns an empty catalog when there are no registered workspace connectors', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const controller = new SettingsController(ctx)
  expect(controller.listMcpActions()).toEqual([])
})

it('lists connectors in name order and marks entries without editable connector config read-only', async () => {
  const { controller, ctx } = await workspace()
  const settings = ctx.configEditor.entries().find(row => row.options.id === 'settings')!
  ctx.on('mcp/actions/catalog', (accept) => {
    accept({ serverName: 'another', entryId: settings.id, connected: true, actions: [] })
  }, { global: true })
  expect(controller.listMcpActions().map(row => [row.serverName, row.editable])).toEqual([
    ['another', false], ['records', true],
  ])
})

it('rejects action edits if the config or the live discovery changes before the edit', async () => {
  const { controller, ctx, disconnect, profile } = await workspace()
  const before = await readFile(profile.patchPath, 'utf8')
  const editor = ctx.configEditor
  const edit = editor.edit.bind(editor)
  const override = vi.spyOn(editor, 'edit').mockImplementationOnce((entry, derive, signal) => edit(
    entry,
    (current, inherited) => derive({ ...current, serverName: 'replacement' }, inherited),
    signal,
  ))
  await expect(controller.setMcpActionEnabled('records', actionName, false, signal()))
    .rejects.toMatchObject({ code: 'settings/mcp-action-rejected' })
  override.mockImplementationOnce((entry, derive, signal) => edit(entry, (current, inherited) => {
    disconnect()
    return derive(current, inherited)
  }, signal))
  await expect(controller.setMcpActionEnabled('records', actionName, false, signal()))
    .rejects.toMatchObject({ code: 'settings/mcp-action-rejected' })
  expect(await readFile(profile.patchPath, 'utf8')).toBe(before)
})

it('requests a reconnect for the exact disconnected connector without exposing config', async () => {
  const { controller, ctx, disconnect, setConnected } = await workspace()
  const requests: Array<{ readonly serverName: string; readonly entryId: string }> = []
  ctx.on('mcp/actions/reconnect', (request) => {
    requests.push({ serverName: request.serverName, entryId: request.entryId })
    setConnected(true)
    request.onSettled(Promise.resolve())
    request.onSettled(Promise.withResolvers<undefined>().promise)
  }, { global: true })
  disconnect()
  await expect(controller.reconnectMcpConnector('records', signal())).resolves.toMatchObject([
    { serverName: 'records', connected: true, editable: true },
  ])
  expect(requests).toEqual([{ serverName: 'records', entryId: 'include:first' }])
  await expect(controller.reconnectMcpConnector('', signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
  await expect(controller.reconnectMcpConnector('missing', signal())).rejects.toMatchObject({ code: 'settings/mcp-action-rejected' })
  await expect(controller.reconnectMcpConnector('records', AbortSignal.abort())).rejects.toMatchObject({ code: 'gateway/cancelled' })
  expect(JSON.stringify(requests)).not.toContain('token')
})

it('returns the current catalog when the connector has gone away or its retry fails', async () => {
  const { controller, ctx, disconnect } = await workspace()
  disconnect()
  const offline = [{ serverName: 'records', connected: false, editable: false }]
  await expect(controller.reconnectMcpConnector('records', signal())).resolves.toMatchObject(offline)

  ctx.on('mcp/actions/reconnect', (request) => {
    request.onSettled(Promise.reject(new Error('Transport unavailable')))
  }, { global: true })
  await expect(controller.reconnectMcpConnector('records', signal())).resolves.toMatchObject(offline)
})

it('returns an offline view if the transport does not finish reconnecting within the settings request', async () => {
  const { controller, ctx, disconnect } = await workspace()
  disconnect()
  const retry: PromiseWithResolvers<void> = Promise.withResolvers()
  ctx.on('mcp/actions/reconnect', (request) => { request.onSettled(retry.promise) }, { global: true })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = controller.reconnectMcpConnector('records', signal())
    const result = expect(pending).resolves.toMatchObject([{ serverName: 'records', connected: false }])
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  } finally {
    retry.resolve()
    vi.useRealTimers()
  }
})
