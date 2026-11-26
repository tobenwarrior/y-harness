/** Native desktop view of the private VPS workspace. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeFileAtomic } from '@yharness/atomic-write'
import { WebContentsView, session, type BrowserWindow, type Session } from 'electron'
import { isCloudTarget, openCloudConnection, openCloudForward, type CloudConnection, type CloudForward } from './cloud-connection.ts'
import {
  CLOUD_DESKTOP_USER_AGENT,
  cloudAction,
  cloudDocument,
  cloudRequestAllowed,
  cloudSignInCookie,
  cloudWebsiteLoginUseRequestId,
  cloudVaultRequestId,
  type CloudWorkspaceStatus,
} from './cloud-workspace-document.ts'
import type { DesktopCloudVault } from './cloud-vault-window.ts'
import { DESKTOP_IPC } from './ipc.ts'
import type { DesktopMessages } from './locale.ts'

const RETRY_MS = 5_000
const MAX_RETRY_MS = 30_000
const LOAD_TIMEOUT_MS = 20_000

function readTarget(file: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof value === 'object' && value !== null && 'target' in value
      && typeof value.target === 'string' && isCloudTarget(value.target)) {
      return value.target
    }
  } catch {
    // A missing or unreadable preference opens Mac with Cloud setup available.
  }
}

function closeView(view: WebContentsView | undefined): void {
  const contents = view?.webContents
  if (contents !== undefined && !contents.isDestroyed()) contents.close()
}

/** Keeps the Cloud renderer isolated from the desktop-owned renderer and its IPC. */
export class DesktopCloudWorkspace {
  private owner: BrowserWindow | undefined
  private controls: WebContentsView | undefined
  private remote: WebContentsView | undefined
  private remoteReady = false
  private controlsDocument: string | undefined
  private forward: CloudForward | undefined
  private connection: CloudConnection | undefined
  private authenticated = false
  private readonly flights = new Set<Promise<void>>()
  private pending: AbortController | undefined
  private savedTarget: string | undefined
  private target: string | undefined
  private selected = false
  private configuring = false
  private invalidTarget = false
  private status: CloudWorkspaceStatus = 'setup'
  private retry: NodeJS.Timeout | undefined
  private retryDelay = RETRY_MS
  private writes = Promise.resolve()

  /**
   * @param file - owner-private local preference path.
   * @param messages - current native shell dictionary.
   * @param preferenceError - notification when the choice cannot be saved.
   * @param vault - application-owned VPS secret window.
   * @param onShowCloud - revokes access scoped to the Mac workspace.
   */
  constructor(private readonly file: string, private readonly messages: () => DesktopMessages,
    private readonly preferenceError: () => void, private readonly vault: Pick<DesktopCloudVault, 'open' | 'close'>,
    private readonly onShowCloud?: () => void) {}

  private onClosed = (): void => { void this.dispose() }

  /** @param owner - ready desktop window that owns the workspace views. */
  attach(owner: BrowserWindow): void {
    if (this.owner === owner) return
    this.owner = owner
    this.savedTarget = readTarget(this.file)
    this.target = this.savedTarget
    owner.on('resize', this.layout)
    owner.on('enter-full-screen', this.syncFullscreen)
    owner.on('leave-full-screen', this.syncFullscreen)
    owner.once('closed', this.onClosed)
    if (this.target !== undefined) {
      this.selected = true
      this.onShowCloud?.()
      this.connect(this.target)
    }
  }

  /** @returns Whether Cloud or its settings cover the local workspace. */
  isCloudSelected(): boolean { return this.selected || this.configuring }

  /** Configure the server while keeping the current connection and chat open until submission. */
  showSettings(): void {
    if (this.owner === undefined) return
    this.configuring = true
    this.invalidTarget = false
    this.onShowCloud?.()
    this.render()
  }

  /** Open Vault for the active Cloud connection. @returns Whether Vault opened. */
  showVault(): boolean {
    const { connection, owner, remote, target } = this
    if (!this.selected || this.configuring || this.status !== 'online' || connection === undefined || owner === undefined
      || remote === undefined || target === undefined) return false
    const contents = remote.webContents
    this.vault.open(owner, target, { kind: 'manage' }, {
      origin: connection.origin,
      fetch: async (url, options) => {
        if (this.connection !== connection || contents.isDestroyed()) throw new Error('Cloud workspace disconnected')
        return contents.session.fetch(url, options)
      },
    })
    return true
  }

  /**
   * Release the view and SSH forward without affecting the server.
   * @returns when the forward and pending preference writes have settled.
   */
  async dispose(): Promise<void> {
    const owner = this.owner
    this.owner = undefined
    owner?.off('resize', this.layout)
    owner?.off('enter-full-screen', this.syncFullscreen)
    owner?.off('leave-full-screen', this.syncFullscreen)
    owner?.off('closed', this.onClosed)
    this.resetWorkspace(owner)
    this.selected = false
    this.configuring = false
    this.status = 'setup'
    this.release(this.controls, owner)
    this.controls = undefined
    this.controlsDocument = undefined
    await Promise.all([...this.flights, this.writes])
  }

  private save(target: string): void {
    this.savedTarget = target
    this.writes = this.writes.then(() => writeFileAtomic(this.file, JSON.stringify({ target }) + '\n', {
      mode: 0o600, dirMode: 0o700,
    })).catch(() => { if (this.owner !== undefined) this.preferenceError() })
  }

  private layout = (): void => {
    if (this.owner === undefined || this.owner.isDestroyed()) return
    const { width, height } = this.owner.getContentBounds()
    this.controls?.setBounds({ x: 0, y: 0, width, height })
    this.remote?.setBounds({ x: 0, y: 0, width, height })
  }

  private syncFullscreen = (): void => {
    const { owner, remote } = this
    if (owner !== undefined && !owner.isDestroyed() && remote !== undefined && !remote.webContents.isDestroyed()) {
      remote.webContents.send(DESKTOP_IPC.windowFullscreen, owner.isFullScreen())
    }
  }

  private release(view: WebContentsView | undefined, owner = this.owner): void {
    if (view === undefined) return
    if (owner !== undefined && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    closeView(view)
  }

  private render(): void {
    const owner = this.owner
    if (owner === undefined || owner.isDestroyed()) return
    if (!this.isCloudSelected()) {
      this.controls?.setVisible(false)
      this.remote?.setVisible(false)
      return
    }
    if (this.remoteReady && !this.configuring) {
      this.controls?.setVisible(false)
      this.layout()
      this.remote?.setVisible(true)
      if (this.status === 'online') this.remote?.webContents.focus()
      return
    }
    if (this.controls === undefined) {
      const controls = new WebContentsView({ webPreferences: {
        partition: `cloud-controls-${randomUUID()}`, nodeIntegration: false, contextIsolation: true,
        sandbox: true, devTools: false,
      } })
      this.controls = controls
      controls.webContents.session.webRequest.onBeforeRequest({ urls: ['https://workspace.invalid/*'] }, (_details, callback) => {
        callback({ cancel: true })
      })
      controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      controls.webContents.on('will-navigate', (event, url) => {
        event.preventDefault()
        const action = cloudAction(url)
        if (action === undefined) return
        switch (action.type) {
          case 'cancel':
            this.configuring = false
            this.render()
            if (!this.selected) owner.webContents.focus()
            break
          case 'configure': this.showSettings(); break
          case 'retry': if (this.target !== undefined) this.connect(this.target); break
          case 'connect':
            this.invalidTarget = !isCloudTarget(action.target)
            if (this.invalidTarget) this.render()
            else {
              this.configuring = false
              this.selected = true
              if (action.target === this.target && (this.connection !== undefined || this.pending !== undefined)) {
                this.render()
              } else {
                this.resetWorkspace()
                this.connect(action.target)
              }
            }
            break
        }
      })
      owner.contentView.addChildView(controls)
    }
    const document = cloudDocument(this.messages(), this.configuring ? 'setup' : this.status, this.invalidTarget)
    if (this.controlsDocument !== document) {
      this.controlsDocument = document
      void this.controls.webContents.loadURL(document).catch(() => {
        // Electron cancels the previous controls load when the connection changes.
      })
    }
    this.layout()
    this.controls.setVisible(true)
    this.remote?.setVisible(false)
  }

  private track(task: Promise<void>): void {
    this.flights.add(task)
    const done = (): void => { this.flights.delete(task) }
    void task.then(done, done)
  }

  private clearRetry(): void {
    clearTimeout(this.retry)
    this.retry = undefined
  }

  private stopConnection(): void {
    this.vault.close()
    this.clearRetry()
    const { pending, connection } = this
    this.pending = undefined
    this.connection = undefined
    this.authenticated = false
    pending?.abort()
    if (connection !== undefined) {
      connection.close()
      this.track(connection.closed)
    }
  }

  private dropRemote(owner = this.owner): void {
    const remote = this.remote
    this.remote = undefined
    this.remoteReady = false
    this.release(remote, owner)
  }

  private resetWorkspace(owner = this.owner): void {
    this.stopConnection()
    this.dropRemote(owner)
    const forward = this.forward
    this.forward = undefined
    if (forward !== undefined) {
      forward.close()
      this.track(forward.closed)
    }
    this.retryDelay = RETRY_MS
  }

  private offline(): void {
    const target = this.target
    if (this.selected && target !== undefined && target === this.savedTarget) {
      this.status = 'reconnecting'
      this.retry = setTimeout(() => {
        this.retry = undefined
        this.connect(target)
      }, this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS)
    } else {
      this.status = 'offline'
    }
    this.render()
  }

  private disconnected(connection: CloudConnection): void {
    if (this.connection !== connection) return
    this.stopConnection()
    if (!this.remoteReady) this.dropRemote()
    this.offline()
  }

  private isPending(pending: AbortController): boolean {
    return this.pending === pending && !pending.signal.aborted
  }

  private connect(target: string): void {
    const owner = this.owner
    if (!this.selected || owner === undefined || owner.isDestroyed()
      || this.pending !== undefined || this.connection !== undefined) return
    this.clearRetry()
    const reconnecting = this.target === target && this.status === 'reconnecting'
    this.target = target
    this.status = reconnecting ? 'reconnecting' : 'connecting'
    const pending = new AbortController()
    this.pending = pending
    this.render()
    this.track(this.connectOnce(owner, target, pending))
  }

  private async connectOnce(owner: BrowserWindow, target: string, pending: AbortController): Promise<void> {
    const timer = setTimeout(() => { pending.abort() }, LOAD_TIMEOUT_MS)
    try {
      let forward = this.forward
      if (forward === undefined) {
        const opened = await openCloudForward()
        if (!this.isPending(pending)) { opened.close(); await opened.closed; return }
        this.forward = forward = opened
        void opened.closed.then(() => {
          if (this.forward !== opened) return
          this.resetWorkspace()
          this.offline()
        })
      }
      const connection = await openCloudConnection(target, pending.signal, { forward })
      if (!this.isPending(pending)) { connection.close(); await connection.closed; return }
      this.connection = connection
      void connection.closed.then(() => { this.disconnected(connection) })

      const activeView = this.remote
      const isolated = activeView?.webContents.session ?? session.fromPartition(`cloud-workspace-${randomUUID()}`, { cache: false })
      if (activeView === undefined) await isolated.setProxy({ mode: 'direct' })
      const response = await fetch(connection.loginUrl, { redirect: 'manual', signal: pending.signal })
      const cookie = cloudSignInCookie(connection.origin, response)
      if (cookie === undefined) throw new Error('Cloud authentication failed')
      if (!this.isPending(pending)) return
      await isolated.cookies.set(cookie)
      if (!this.isPending(pending)) return
      this.authenticated = true
      if (activeView === undefined) await this.loadWorkspace(owner, isolated, forward, target, pending)
      if (!this.isPending(pending)) return

      this.status = 'online'
      this.retryDelay = RETRY_MS
      if (this.savedTarget !== target) this.save(target)
      this.render()
    } catch {
      // Raw SSH and Electron errors can contain the destination or sign-in URL.
    } finally {
      clearTimeout(timer)
      if (this.pending === pending) {
        this.pending = undefined
        if (this.status !== 'online') {
          this.stopConnection()
          if (!this.remoteReady) this.dropRemote()
          this.offline()
        }
      }
    }
  }

  private async loadWorkspace(
    owner: BrowserWindow, isolated: Session, forward: CloudForward, target: string, pending: AbortController,
  ): Promise<void> {
    const { origin } = forward
    isolated.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
    isolated.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'clipboard-sanitized-write')
    })
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: this.forward !== forward || !this.authenticated || !cloudRequestAllowed(origin, details.url) })
    })

    const remote = new WebContentsView({ webPreferences: {
      session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false,
      preload: fileURLToPath(new URL('./preload-cloud-workspace.cjs', import.meta.url)),
    } })
    this.remote = remote
    remote.setVisible(false)
    const contents = remote.webContents
    contents.on('did-finish-load', this.syncFullscreen)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', (event) => {
      if (!cloudRequestAllowed(origin, event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (!cloudRequestAllowed(origin, event.url)) event.preventDefault()
    })
    contents.on('render-process-gone', () => {
      if (this.remote !== remote) return
      this.dropRemote()
      const connection = this.connection
      if (connection !== undefined) this.disconnected(connection)
      else this.render()
    })
    const userAgent = contents.getUserAgent()
    if (!userAgent.split(/\s+/u).includes(CLOUD_DESKTOP_USER_AGENT)) {
      contents.setUserAgent(`${userAgent} ${CLOUD_DESKTOP_USER_AGENT}`.trim())
    }
    contents.on('will-navigate', (event, url) => {
      if (!this.selected || this.status !== 'online' || this.connection === undefined
        || this.forward !== forward || this.remote !== remote) return
      const loginUseRequestId = cloudWebsiteLoginUseRequestId(origin, url)
      if (loginUseRequestId !== undefined) {
        event.preventDefault()
        this.vault.open(owner, target, { kind: 'login-use', id: loginUseRequestId })
        return
      }
      const requestId = cloudVaultRequestId(origin, url)
      if (requestId === undefined) return
      event.preventDefault()
      this.vault.open(owner, target, { kind: 'request', id: requestId })
    })
    const responseStatus = new Promise<number>((resolve) => {
      contents.once('did-navigate', (_event, _url, status) => { resolve(status) })
    })
    const cancelLoad = (): void => {
      if (this.remote === remote) this.dropRemote(owner)
    }
    pending.signal.addEventListener('abort', cancelLoad, { once: true })
    owner.contentView.addChildView(remote)
    try {
      const status = await Promise.race([responseStatus, contents.loadURL(origin + '/').then(() => 0)])
      if (!this.isPending(pending)) return
      if (status !== 200) throw new Error('Cloud workspace did not load')
      this.remoteReady = true
    } finally {
      pending.signal.removeEventListener('abort', cancelLoad)
    }
  }
}
