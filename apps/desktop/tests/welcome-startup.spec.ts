vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))
/** Account-free startup and optional account transitions use the same workspace. */

import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { DesktopLocale } from '../src/locale.ts'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { WelcomeOperations } from '../src/welcome-api.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'

const state = vi.hoisted(() => ({
  appListeners: new Map<string, (...args: unknown[]) => void>(),
  dialogLocale: undefined as (() => DesktopLocale) | undefined,
  beforeRead: vi.fn(async () => {}),
  beforeLocale: vi.fn(async () => {}),
  external: vi.fn(async () => {}),
  beforeWelcome: vi.fn(async () => {}),
  copy: vi.fn(),
  expiryListener: undefined as (() => void) | undefined,
  accountListener: undefined as ((value: AccountView) => void) | undefined,
  accountState: vi.fn<() => Promise<AccountView>>().mockResolvedValue({
    status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' },
  }),
  quit: vi.fn(),
  startHost: vi.fn().mockResolvedValue({ url: 'http://127.0.0.1:3080/?token=test', injections: [] }),
  stopHost: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  loadWorkspace: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  showWorkspace: vi.fn(),
  showInactiveWorkspace: vi.fn(),
  focusWorkspace: vi.fn(),
  moveTopWorkspace: vi.fn(),
  openDevTools: vi.fn(),
  closeWelcome: vi.fn(),
  welcomeLocale: undefined as DesktopLocale | undefined,
  preference: 'zh',
  hasApiKey: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  contents: undefined as { mainFrame: { url: string } } | undefined,
  windowOptions: undefined as BrowserWindowConstructorOptions | undefined,
  menu: vi.fn(),
  operations: undefined as WelcomeOperations | undefined,
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
}))

vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn(async () => undefined),
  pruneCrashReports: vi.fn(async () => {}),
}))
vi.mock('electron', () => ({
  clipboard: { writeText: state.copy },
  shell: { openExternal: state.external },
  app: {
    isPackaged: false,
    name: 'Harness',
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en',
    getVersion: () => '1.0.0',
    setAboutPanelOptions: vi.fn(),
    getAppPath: () => '/development-app',
    getPath: (name: string) => name === 'userData' ? '/desktop-user-data' : `/development-${name}`,
    setAppLogsPath: vi.fn(),
    getPreferredSystemLanguages: () => ['en-US'],
    on: (name: string, callback: (...args: unknown[]) => void) => { state.appListeners.set(name, callback) },
    quit: state.quit,
    exit: vi.fn(),
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { state.windowOptions = options }
    private ready: (() => void) | undefined
    webContents = { mainFrame: { url: 'dsh-app://app/' }, setWindowOpenHandler: vi.fn(),
      on: vi.fn(), once: vi.fn(), send: vi.fn(), openDevTools: state.openDevTools }
    static getAllWindows() { return [] }
    once(name: string, callback: () => void) { if (name === 'ready-to-show') this.ready = callback; return this }
    on() { return this }
    isDestroyed() { return false }
    isMinimized() { return false }
    restore = vi.fn()
    focus = state.focusWorkspace
    moveTop = state.moveTopWorkspace
    hide = vi.fn()
    show = state.showWorkspace
    showInactive = state.showInactiveWorkspace
    async loadURL(url: string) { state.contents = this.webContents; await state.loadWorkspace(url); this.ready?.() }
  },
  net: { fetch: vi.fn() },
  nativeTheme: state.nativeTheme,
  session: { defaultSession: {
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) => { state.handlers.set(name, callback) },
    on: (name: string, callback: (...args: unknown[]) => void) => { state.listeners.set(name, callback) },
  },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  Menu: { buildFromTemplate: state.menu, setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
// The Windows tray relabels through Menu as well; keep the menu call counts below platform-neutral.
vi.mock('../src/tray.ts', () => ({ DesktopTray: class { relabel() {} dispose() {} } }))

vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: '/profile' }) }))
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: async (base: NodeJS.ProcessEnv) => ({ environment: base, failures: [] }),
}))
vi.mock('../src/project-manager.ts', () => ({ DesktopProjectManager: class {
  applyRelease = vi.fn(async () => {})
  canRecoverProfile = vi.fn(() => true)
} }))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    start = state.startHost
    stop = state.stopHost
    fetch() {
      return Promise.resolve(Response.json({
        loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference,
      }))
    }
  },
}))
vi.mock('../src/welcome-backend.ts', () => ({
  connectDesktopWelcome: async () => ({
    analyticsEnabled: async () => false,
    readLocalePreference: async () => { await state.beforeLocale(); return state.preference },
    read: async () => {
      await state.beforeRead()
      return { loggedIn: false, hasApiKey: state.hasApiKey, writable: true, localePreference: state.preference }
    },
    save: async () => ({ ok: true }),
    account: {
      watch: (listener: (value: AccountView) => void, _failed: () => void, expired: () => void) => {
        state.accountListener = listener
        state.expiryListener = expired
        return () => {}
      },
      state: state.accountState,
    },
  }),
}))
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => '{}'),
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  constructor(_preload: string, locale: () => DesktopLocale) { state.dialogLocale = locale }
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  state = { phase: 'idle' }
  check = vi.fn(async () => this.state)
  dispose = vi.fn()
} }))
vi.mock('../src/welcome-window.ts', () => ({
  openWelcomeWindow: async (locale: DesktopLocale, operations: WelcomeOperations) => {
    state.welcomeLocale = locale
    state.operations = operations
    await state.beforeWelcome()
    return { once: vi.fn(), close: state.closeWelcome, isDestroyed: () => false,
      show: vi.fn(), focus: vi.fn(), webContents: { send: vi.fn() } }
  },
}))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function prepare(updated = false) {
  vi.resetModules()
  vi.clearAllMocks()
  state.preference = 'zh'
  state.operations = undefined
  if (updated) vi.stubGlobal('process', { ...process, platform: 'win32', argv: ['desktop', '--updated'] })
  vi.useFakeTimers()
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', '/development-profile')
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', '/runtime/node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', '/runtime/pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', '/runtime/dsh')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', '/runtime/primary-runtime')
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_OPEN_DEVTOOLS', '0')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
}

it.each([
  ['fresh', false, false], ['existing provider', true, false], ['update restart', false, true],
] as const)('opens the workspace for %s without reading provider or account credentials', async (_name, key, updated) => {
  prepare(updated)
  state.hasApiKey = key
  const reading = Promise.withResolvers<undefined>()
  state.beforeLocale.mockReturnValueOnce(reading.promise)
  await import('../src/main.ts')
  try {
    await vi.waitFor(() => { expect(state.beforeLocale).toHaveBeenCalledOnce() })
    state.appListeners.get('second-instance')!()
    expect(state.showWorkspace).not.toHaveBeenCalled()
    reading.resolve(undefined)
    await vi.waitFor(() => { expect(state.showWorkspace).toHaveBeenCalledOnce() })
  } finally { reading.resolve(undefined) }
  expect(state.beforeRead).not.toHaveBeenCalled()
  expect(state.accountState).not.toHaveBeenCalled()
  expect(state.beforeWelcome).not.toHaveBeenCalled()
  expect(state.operations).toBeUndefined()
  expect(state.startHost).toHaveBeenCalledOnce()
  expect(state.loadWorkspace).toHaveBeenCalledExactlyOnceWith('dsh-app://app/')
  expect(state.dialogLocale!().id).toBe('zh-CN')
  expect(state.windowOptions).toMatchObject({
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar' } : {}),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  expect(state.moveTopWorkspace).toHaveBeenCalledTimes(updated ? 1 : 0)
  expect(state.focusWorkspace).toHaveBeenCalledTimes(updated ? 1 : 0)
  state.appListeners.get('open-url')!({ preventDefault: vi.fn() }, 'dsh://open')
  expect(state.loadWorkspace).toHaveBeenCalledOnce()
  expect(state.showWorkspace).toHaveBeenCalledTimes(2)
  expect(state.focusWorkspace).toHaveBeenCalledTimes(updated ? 2 : 1)
})

it('keeps the workspace through saved sign-in, optional login, cancellation, failure, sign-out and expiry', async () => {
  prepare()
  state.hasApiKey = false
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.showWorkspace).toHaveBeenCalledOnce() })
  const id = 'optional-login' as NonNullable<AccountView['attempt']>['id']
  const base: AccountView = { status: 'signed-out', attempt: null, links: { usageUrl: '', topUpUrl: '' } }
  state.accountListener!({ ...base, status: 'credential-stored' })
  state.accountListener!(base)
  state.expiryListener!()
  state.nativeTheme.shouldUseDarkColors = true
  const waiting: AccountView = { ...base, attempt: { id, phase: 'waiting-browser', authorizeUrl: 'https://example.test/login' } }
  state.accountListener!(waiting)
  state.accountListener!(waiting)
  expect(state.external).toHaveBeenCalledExactlyOnceWith('https://example.test/login?theme=dark')
  state.nativeTheme.shouldUseDarkColors = false
  state.accountListener!({ ...base, attempt: { id, phase: 'cancelled' } })
  state.accountListener!({ ...base, attempt: { id, phase: 'failed' } })
  state.accountListener!({ ...base, status: 'credential-stored', attempt: { id, phase: 'succeeded' } })
  state.accountListener!(base)
  state.expiryListener!()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.beforeWelcome).not.toHaveBeenCalled()
  expect(state.beforeRead).not.toHaveBeenCalled()
  expect(state.accountState).not.toHaveBeenCalled()
  expect(state.loadWorkspace).toHaveBeenCalledOnce()
  expect(state.stopHost).not.toHaveBeenCalled()
  expect(state.quit).not.toHaveBeenCalled()
  expect(state.showInactiveWorkspace).not.toHaveBeenCalled()
  expect(state.showWorkspace).toHaveBeenCalledTimes(2)
})

it('reads the saved UI locale without inference-provider availability and preserves later language changes', async () => {
  prepare()
  state.beforeRead.mockImplementation(async () => { throw new Error('provider offline') })
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(state.showWorkspace).toHaveBeenCalledOnce() })
  const contents = state.contents!
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const bootstrap = state.handlers.get(DESKTOP_IPC.localeBootstrap)!
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'zh' })
  state.preference = 'en'
  expect(await bootstrap(event)).toEqual({ languages: ['en-US'], preference: 'en' })
  const changed = state.listeners.get(DESKTOP_IPC.localeChanged)!
  const initialMenus = state.menu.mock.calls.length
  changed({ ...event, senderFrame: {} }, 'en')
  changed(event, 42)
  expect(state.menu).toHaveBeenCalledTimes(initialMenus)
  changed(event, 'en')
  expect(state.dialogLocale!().id).toBe('en')
  expect(state.menu).toHaveBeenCalledTimes(initialMenus + 1)
  expect(state.beforeRead).not.toHaveBeenCalled()
})
