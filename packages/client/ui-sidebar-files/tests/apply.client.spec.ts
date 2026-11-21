/**
 * The plugin's registrations, and their removal when the plugin goes.
 *
 * The registry is real, because "registered" means what it says a type is; the
 * slot, locale, and Remote faces are recorders, because what matters here is
 * what was handed to them — one body seat under the type's id with its store
 * and face — and that every registration is gone after dispose, which is what
 * makes a reload safe.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@yharness/cordis'
import type { SessionId } from '@yharness/session/types'
import type { TabId } from '@yharness/client-ui-dockkit'
import type { ShortcutCommand } from '@yharness/client-shortcuts/client'
import { SidebarRightTabRegistry } from '@yharness/client-ui-sidebar-right/src/client/tab-registry.ts'
import { COMPUTER_FILES_KIND, COMPUTER_SHARED_FILES_KIND, FILES_ID, FILES_KIND } from '../src/client/definition.tsx'
import type { filesFace, WorkspaceFilesListRemote } from '../src/client/face.ts'
import type { createFilesStore } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { FilesBody } from '../src/client/FilesBody.tsx'
import { FilesTitle } from '../src/client/FilesTitle.tsx'
import { en } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: ReturnType<typeof createFilesStore>
  inject?: ReturnType<typeof filesFace>
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const list = vi.fn<WorkspaceFilesListRemote['workspaceFiles']['list']>()
  const stream = vi.fn()
  const workspaceFiles = { list }
  const sidebar = { commandTarget: vi.fn(), openTabFromTarget: vi.fn() }
  const commands: ShortcutCommand[] = []
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.push(command)
    return () => { commands.splice(commands.indexOf(command), 1) }
  } } as never)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { workspaceFiles, $stream: stream } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber, sidebar, commands, list, stream }
}

describe('ui-sidebar-files apply', () => {
  it('opens files for the command target and refuses without a selected Session', async () => {
    const h = await boot()
    try {
      const command = h.commands[0]!
      const input = { region: 'page', modal: null, target: null } as const
      expect(command.resolve(input)).toEqual({ status: 'blocked', reason: 'shortcut.noSession' })
      const target = { sessionId: 'files-session' }
      h.sidebar.commandTarget.mockReturnValue(target)
      const result = command.resolve(input)
      if (result.status !== 'handled') throw new Error('Expected files command to be available')
      result.run()
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledWith('files', target)
    } finally { await h.fiber.dispose() }
    expect(h.commands).toEqual([])
  })
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers the type, its dictionaries, and the body and title seats under the type\'s id', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(FILES_KIND)
    expect(definition?.id).toBe(FILES_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('sidebar://files')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[10, 'guide.title', 'guide.description']])
    expect(tabs.get(COMPUTER_FILES_KIND)?.guide).toEqual([])
    expect(tabs.get(COMPUTER_SHARED_FILES_KIND)?.guide).toEqual([])
    expect(tabs.get(COMPUTER_SHARED_FILES_KIND)?.title('')).toBe('sharedType.label')
    expect(dictionaries.get('sidebarFiles')).toEqual({ en })
    // The seat key is the implementation's id, not the kind: an extension may
    // take the kind over, and the seat must still find this body.
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', FILES_ID, 'sidebarFiles', FilesBody],
      ['sidebar.right.pane.tab.title', FILES_ID, undefined, FilesTitle],
      ['sidebar.right.pane.tab', `${FILES_ID}/computer`, 'sidebarFiles', FilesBody],
      ['sidebar.right.pane.tab.title', `${FILES_ID}/computer`, undefined, FilesTitle],
      ['sidebar.right.pane.tab', `${FILES_ID}/${COMPUTER_SHARED_FILES_KIND}`, 'sidebarFiles', FilesBody],
      ['sidebar.right.pane.tab.title', `${FILES_ID}/${COMPUTER_SHARED_FILES_KIND}`, undefined, FilesTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(typeof registered[0]?.inject).toBe('function')
  })

  it.each([
    { kind: COMPUTER_FILES_KIND, root: '.' },
    { kind: COMPUTER_SHARED_FILES_KIND, root: '/workspace' },
  ])('loads $kind on mount and on refresh without opening a workspace watch', async ({ kind, root }) => {
    const { tabs, registered, fiber, list, stream } = await boot()
    const controller = new AbortController()
    onTestFinished(async () => {
      controller.abort()
      await fiber.dispose()
    })
    const entry = registered.find(item => item.name === 'sidebar.right.pane.tab' && item.key === tabs.get(kind)?.id)
    if (entry?.store === undefined || entry.inject === undefined) throw new Error('Expected a Computer file tree')
    const instance = entry.store.create()
    const tabId = 'computer-files-tab' as TabId
    const sessionId = 'computer-session' as SessionId
    const initial = { entries: [{ name: 'initial.md', type: 'file' }], truncated: false } as const
    const updated = { entries: [{ name: 'updated.md', type: 'file' }], truncated: false } as const
    list.mockResolvedValueOnce({ ok: true, value: { path: root, ...initial } })
    list.mockResolvedValueOnce({ ok: true, value: { path: root, ...updated } })
    const files = entry.inject(sessionId, instance.actions)
    const level = () => instance.getSnapshot().byTab[tabId]?.levels[root]

    files.start(tabId, root, controller.signal)
    await expect.poll(level).toEqual({ kind: 'ready', level: initial })
    const requestSignal = list.mock.calls[0]?.[2]
    expect(list).toHaveBeenCalledExactlyOnceWith(sessionId, { computer: root }, requestSignal)
    expect(requestSignal?.aborted).toBe(false)

    files.refresh(tabId)
    await expect.poll(level).toEqual({ kind: 'ready', level: updated })
    expect(list).toHaveBeenCalledTimes(2)
    expect(list).toHaveBeenLastCalledWith(sessionId, { computer: root }, requestSignal)
    expect(stream).not.toHaveBeenCalled()

    controller.abort()
    expect(requestSignal?.aborted).toBe(true)
    expect(instance.getSnapshot().byTab[tabId]).toBeUndefined()
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(FILES_KIND)).toBeUndefined()
    expect(tabs.get(COMPUTER_FILES_KIND)).toBeUndefined()
    expect(tabs.get(COMPUTER_SHARED_FILES_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
