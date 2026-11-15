/** Exercise the native Cloud workspace across failed SSH attempts. */
import { EventEmitter } from 'node:events'
import { BrowserWindow } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { openCloudConnection, openCloudForward } from '../src/cloud-connection.ts'
import { DesktopCloudWorkspace } from '../src/cloud-workspace.ts'
import type { DesktopCloudVault } from '../src/cloud-vault-window.ts'
import { en } from '../src/locale.ts'

type RequestHandler = (request: { url: string }, reply: (result: { cancel: boolean }) => void) => void

const fixture = vi.hoisted(() => ({
  preference: '',
  views: [] as Array<{ options: { webPreferences: { session?: object } } }>,
  open: vi.fn<typeof openCloudConnection>(),
  forward: vi.fn<typeof openCloudForward>(),
  write: vi.fn(async () => {}),
  installCookie: vi.fn(async () => {}),
  interceptRequest: vi.fn<(listener: RequestHandler) => void>(),
  vault: { close: vi.fn<DesktopCloudVault['close']>(), open: vi.fn<DesktopCloudVault['open']>() },
}))

vi.mock('node:fs', () => ({ readFileSync: () => fixture.preference }))
vi.mock('@yharness/atomic-write', () => ({ writeFileAtomic: fixture.write }))
vi.mock('../src/cloud-connection.ts', () => ({
  isCloudTarget: (target: string) => /^[a-z0-9-]+$/u.test(target),
  openCloudConnection: fixture.open,
  openCloudForward: fixture.forward,
}))

vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    readonly webContents = { focus: vi.fn() }
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly isDestroyed = () => false
    readonly getContentBounds = () => ({ width: 900, height: 700 })
  },
  WebContentsView: class {
    readonly setBounds = vi.fn()
    readonly setVisible = vi.fn()
    readonly webContents = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
      focus: vi.fn(),
      getUserAgent: vi.fn(() => 'Cloud workspace fixture'),
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: { webRequest: { onBeforeRequest: vi.fn() } },
      loadURL: vi.fn(async (url: string) => {
        if (url.startsWith('http://')) this.webContents.emit('did-navigate', {}, url, 200)
      }),
    })
    constructor(readonly options: { webPreferences: { session?: object } }) {
      Object.assign(this.webContents, { session: options.webPreferences.session ?? this.webContents.session })
      fixture.views.push(this)
    }
  },
  session: { fromPartition: vi.fn(() => ({
    setProxy: vi.fn(async () => {}),
    cookies: { set: fixture.installCookie },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: fixture.interceptRequest },
  })) },
}))

const ORIGIN = 'http://127.0.0.1:43112'
const TOKEN = 'a'.repeat(43)
const connection = (origin = ORIGIN) => {
  const ended = Promise.withResolvers<undefined>()
  const close = vi.fn(() => { ended.resolve(undefined) })
  return { value: { origin, loginUrl: origin + '/?token=' + TOKEN, closed: ended.promise, close }, ended }
}
const forward = (origin = ORIGIN) => {
  const ended = Promise.withResolvers<undefined>()
  return { origin, closed: ended.promise, close: vi.fn(() => { ended.resolve(undefined) }) }
}

type FakeView = {
  readonly webContents: EventEmitter & {
    close: ReturnType<typeof vi.fn>
    loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
  }
  readonly setVisible: ReturnType<typeof vi.fn>
}

function view(index: number): FakeView {
  return fixture.views[index] as (typeof fixture.views)[number] & FakeView
}
function visibleControls(): string {
  const url = view(0).webContents.loadURL.mock.lastCall?.[0]
  return decodeURIComponent(url?.slice(url.indexOf(',') + 1) ?? '')
}

let workspace: DesktopCloudWorkspace

beforeEach(() => {
  vi.useFakeTimers()
  fixture.preference = JSON.stringify({ target: 'cloud-fixture', selected: true })
  fixture.forward.mockImplementation(async () => forward())
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {
    status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-' + TOKEN + '=v1.payload.signature; HttpOnly' },
  })))
  workspace = new DesktopCloudWorkspace('cloud-preference.json', () => en, vi.fn(), fixture.vault)
})

afterEach(async () => {
  await workspace.dispose()
  fixture.views.length = 0
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps the loaded Cloud chat across a failed reconnect and reauthenticates at the same origin', async () => {
  const first = connection()
  const restored = connection()
  fixture.open.mockResolvedValueOnce(first.value).mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(restored.value)
  workspace.attach(new BrowserWindow())
  await vi.advanceTimersByTimeAsync(0)
  expect(visibleControls()).toContain('Connected')
  const chat = view(1)

  first.ended.resolve(undefined)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(fixture.open).toHaveBeenCalledTimes(2)
  expect(chat.webContents.close).not.toHaveBeenCalled()
  expect(chat.setVisible).toHaveBeenLastCalledWith(true)
  expect(visibleControls()).toContain('Reconnecting to Cloud')
  workspace.showVault()
  expect(fixture.vault.open).not.toHaveBeenCalled()

  const signedIn = Promise.withResolvers<undefined>()
  fixture.installCookie.mockReturnValueOnce(signedIn.promise)
  await vi.advanceTimersByTimeAsync(10_000)
  const shouldCancel = vi.fn()
  const request = { url: ORIGIN.replace('http:', 'ws:') + '/rpc' }
  fixture.interceptRequest.mock.lastCall?.[0](request, shouldCancel)
  signedIn.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  fixture.interceptRequest.mock.lastCall?.[0](request, shouldCancel)
  expect(shouldCancel.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }]])
  expect(fixture.open).toHaveBeenCalledTimes(3)
  expect(fixture.forward).toHaveBeenCalledOnce()
  expect(fixture.views).toHaveLength(2)
  expect(chat.webContents.loadURL).toHaveBeenCalledExactlyOnceWith(ORIGIN + '/')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(visibleControls()).toContain('Connected')
  workspace.showVault()
  expect(fixture.vault.open).toHaveBeenCalledOnce()
})

it('waits for a saved Cloud server on launch and stops retrying on Mac', async () => {
  const online = connection()
  fixture.open.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(online.value)
  workspace.attach(new BrowserWindow())
  await vi.advanceTimersByTimeAsync(0)
  expect(visibleControls()).toContain('Reconnecting to Cloud')

  workspace.showMac()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fixture.open).toHaveBeenCalledTimes(1)
  expect(workspace.isCloudSelected()).toBe(false)

  workspace.showCloud()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.open).toHaveBeenCalledTimes(2)
  expect(visibleControls()).toContain('Connected')
})

it('cancels the old retry and closes the old chat when the owner changes servers', async () => {
  const first = connection()
  const initialForward = forward()
  const newOrigin = 'http://127.0.0.1:43191'
  fixture.forward.mockResolvedValueOnce(initialForward).mockResolvedValueOnce(forward(newOrigin))
  const next = connection(newOrigin)
  fixture.open.mockResolvedValueOnce(first.value).mockResolvedValueOnce(next.value)
  workspace.attach(new BrowserWindow())
  await vi.advanceTimersByTimeAsync(0)
  const chat = view(1)
  first.ended.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)

  function choose(url: string) {
    view(0).webContents.emit('will-navigate', { preventDefault: vi.fn() }, url)
  }
  choose('https://workspace.invalid/configure')
  expect(initialForward.close).toHaveBeenCalledOnce()
  expect(chat.webContents.close).toHaveBeenCalledOnce()
  choose('https://workspace.invalid/connect?target=another-cloud')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fixture.open.mock.calls.map(([target]) => target)).toEqual(['cloud-fixture', 'another-cloud'])
  expect(view(2).webContents.loadURL).toHaveBeenCalledExactlyOnceWith(newOrigin + '/')
})
